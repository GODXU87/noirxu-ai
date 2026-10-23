import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { TokenVault } from '@/connections/vault';
import { HistoryService } from '@/history/service';
import { PgHistoryStore } from '@/history/store';

// Real PostgreSQL with the C2 migration applied:
//   sh scripts/test-db.sh supabase/pending/20261023120000_noirxu_ai_history_memory_c2.sql
const url = process.env.NOIRXU_TEST_DATABASE_URL;
const withC2 = process.env.NOIRXU_TEST_C2 === '1';
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const msgs = (n: number, tag = 'm') => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `${tag}-${i}` }));

describe.skipIf(!url || !withC2)('C2 on real PostgreSQL (noirxu_ai_app)', () => {
  const pools = url ? [new Pool({ connectionString: url, max: 2 }), new Pool({ connectionString: url, max: 2 })] : [];
  const [phone, mac] = pools.map(p => new HistoryService(new PgHistoryStore(p), vault));
  afterAll(async () => { await Promise.all(pools.map(p => p.end())); });
  const user = () => `it-${randomUUID()}`;

  it('permission matrix: messages are append-only, nothing outside noirxu_ai is reachable', async () => {
    const p = pools[0];
    await expect(p.query('update noirxu_ai.messages set kind = $1', ['user'])).rejects.toThrow(/permission denied/);
    await expect(p.query('delete from noirxu_ai.messages')).rejects.toThrow(/permission denied/);
    await expect(p.query('select * from outside_data.secrets')).rejects.toThrow(/permission denied/);
    await expect(p.query('create table noirxu_ai.evil (x int)')).rejects.toThrow(/permission denied/);
    await expect(p.query('drop table noirxu_ai.memories')).rejects.toThrow(/must be owner|permission denied/);
  });

  it('two devices appending at the same moment: one wins, the other gets a conflict, nothing is interleaved', async () => {
    const u = user();
    const conv = await phone.create(u, '同步測試');
    const results = await Promise.all([phone.append(u, conv.id, 0, msgs(3, 'phone')), mac.append(u, conv.id, 0, msgs(3, 'mac'))]);
    expect(results.map(r => r.status).sort()).toEqual(['conflict', 'ok']);
    const loser = results.findIndex(r => r.status === 'conflict');
    const retry = await [phone, mac][loser].append(u, conv.id, 3, msgs(3, loser ? 'mac' : 'phone'));
    expect(retry.status).toBe('ok');
    const loaded = (await mac.load(u, conv.id))!;
    expect(loaded.items).toHaveLength(6);
    const tags = loaded.items.map(i => String(i.text).split('-')[0]);
    expect(tags.slice(0, 3).every(t => t === tags[0]) && tags.slice(3).every(t => t === tags[3])).toBe(true);
  });

  it('the same import sent twice at once creates one conversation, verified by count', async () => {
    const u = user();
    const input = { importKey: 'legacy:abc', source: 'legacy_import' as const, title: '原版對話', items: msgs(5), context: { history: [], notes: [] } };
    const settled = await Promise.allSettled([phone.importConversation(u, input), mac.importConversation(u, input)]);
    expect(settled.some(s => s.status === 'fulfilled')).toBe(true);
    // A loser may see a conflict; retrying is safe and adds nothing.
    const final = await phone.importConversation(u, input);
    expect(final.conversation.message_count).toBe(5);
    expect(await phone.list(u)).toHaveLength(1);
  });

  it('search finds masked user text and titles, never tool output or raw e-mail', async () => {
    const u = user();
    const conv = await phone.create(u, '報價');
    await phone.append(u, conv.id, 0, [{ kind: 'user', text: '寄給 amy@example.com 報價單' }, { kind: 'tool', result: { note: 'secret-tool-text' } }]);
    expect(await phone.list(u, '報價單')).toHaveLength(1);
    expect(await phone.list(u, 'amy@example.com')).toHaveLength(0);
    expect(await phone.list(u, 'secret-tool-text')).toHaveLength(0);
    expect(await phone.list(u, '%')).toHaveLength(0);
  });

  it('soft delete hides at once; purge after 30 days removes the conversation and its messages', async () => {
    const u = user();
    const conv = await phone.create(u, '要刪的');
    await phone.append(u, conv.id, 0, msgs(2));
    await phone.remove(u, conv.id, new Date('2026-01-01T00:00:00Z'));
    expect(await mac.load(u, conv.id)).toBeNull();
    await phone.purge(new Date('2026-01-30T00:00:00Z'));
    const kept = await pools[0].query('select count(*)::int n from noirxu_ai.messages where conversation_id = $1', [conv.id]);
    expect(kept.rows[0].n).toBe(2);
    await phone.purge(new Date('2026-02-01T00:00:00Z'));
    const gone = await pools[0].query('select count(*)::int n from noirxu_ai.messages where conversation_id = $1', [conv.id]);
    expect(gone.rows[0].n).toBe(0);
  });

  it('memories persist across devices and respect the content rules', async () => {
    const u = user();
    const m = await phone.remember(u, { content: '每天早上 7 點起床', source: 'user_command' });
    expect(await mac.listMemories(u)).toEqual([expect.objectContaining({ id: m.id, category: 'routine' })]);
    await mac.editMemory(u, m.id, { active: false });
    expect(await phone.listMemories(u)).toHaveLength(0);
    await expect(phone.remember(u, { content: '我持有 2330 十張', source: 'chat' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(pools[0].query("insert into noirxu_ai.memories (id, user_id, category, content, source) values ($1, $2, 'oops', 'x', 'chat')", [randomUUID(), u])).rejects.toThrow(/check constraint/);
  });
});
