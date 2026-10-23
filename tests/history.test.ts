import { describe, expect, it } from 'vitest';
import { TokenVault } from '@/connections/vault';
import { maskForSearch, memoryRejection } from '@/history/privacy';
import { HistoryService } from '@/history/service';
import { MemoryHistoryStore } from '@/history/store';

const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const setup = () => { const store = new MemoryHistoryStore(); return { store, history: new HistoryService(store, vault) }; };
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `第 ${i} 則` }));

describe('C2 privacy rules', () => {
  it('masks contact details and long numbers in the search copy', () => {
    expect(maskForSearch('寄給 amy@example.com 或打 0912-345-678，卡號 4111 1111 1111 1111，身分證 A123456789'))
      .toBe('寄給 [email] 或打 [電話]，卡號 [數字]，身分證 [身分證]');
  });

  it('refuses memories that hold money, holdings, prices, secrets or ID numbers', () => {
    for (const bad of ['我的存款餘額是很多', '我持有 2330 十張', '台積電現價多少要記住', '密碼是 abc', '帳號 1234567890123', '每月房租 NT$ 25000']) expect(memoryRejection(bad)).not.toBeNull();
    for (const ok of ['回覆一律用繁體中文', '每天早上 7 點起床', '稱呼我先生', 'NOIRXU 品牌只用黑白灰']) expect(memoryRejection(ok)).toBeNull();
  });
});

describe('C2 history service', () => {
  it('stores messages encrypted and bound to their position; search sees only masked user text', async () => {
    const { store, history } = setup();
    const conv = await history.create('owner', '測試');
    await history.append('owner', conv.id, 0, [{ kind: 'user', text: '聯絡 amy@example.com' }, { kind: 'tool', result: { secret: 'tool-output' } }]);
    const raw = (await store.get('owner', conv.id))!.messages;
    expect(raw.every(m => !m.sealed.includes('amy') && !m.sealed.includes('tool-output'))).toBe(true);
    expect(raw.map(m => m.search_text)).toEqual(['聯絡 [email]', '']);
    expect((await history.load('owner', conv.id))!.items[1]).toMatchObject({ kind: 'tool', result: { secret: 'tool-output' } });
    // A sealed message moved to another position cannot be opened.
    [raw[0].sealed, raw[1].sealed] = [raw[1].sealed, raw[0].sealed];
    store.conversations.get(conv.id)!.messages = raw;
    await expect(history.load('owner', conv.id)).rejects.toThrow();
  });

  it('detects a second device appending first, then succeeds after reload', async () => {
    const { history } = setup();
    const conv = await history.create('owner');
    expect((await history.append('owner', conv.id, 0, items(2))).status).toBe('ok');
    expect(await history.append('owner', conv.id, 0, items(1))).toMatchObject({ status: 'conflict', nextSeq: 2 });
    expect((await history.append('owner', conv.id, 2, items(1))).status).toBe('ok');
    expect((await history.load('owner', conv.id))!.items).toHaveLength(3);
  });

  it('saves model context with a version check', async () => {
    const { history } = setup();
    const conv = await history.create('owner');
    const first = await history.append('owner', conv.id, 0, items(1), { value: { history: ['a'], notes: [] }, expectedVersion: 1 });
    expect(first).toMatchObject({ status: 'ok', version: 2 });
    expect(await history.append('owner', conv.id, 1, [], { value: { history: ['stale'], notes: [] }, expectedVersion: 1 })).toMatchObject({ status: 'context_conflict', version: 2 });
    expect((await history.load('owner', conv.id))!.context.history).toEqual(['a']);
  });

  it('imports a browser conversation idempotently and only adds what is missing', async () => {
    const { history, store } = setup();
    const first = await history.importConversation('owner', { importKey: 'local:c_1', source: 'local_import', title: '舊對話', items: items(4), context: { history: [], notes: [] } });
    expect(first).toMatchObject({ created: true, added: 4 });
    const again = await history.importConversation('owner', { importKey: 'local:c_1', source: 'local_import', title: '舊對話', items: items(4), context: { history: [], notes: [] } });
    expect(again).toMatchObject({ created: false, added: 0 });
    const grown = await history.importConversation('owner', { importKey: 'local:c_1', source: 'local_import', title: '舊對話', items: items(6), context: { history: [], notes: [] } });
    expect(grown.added).toBe(2);
    expect(store.conversations.size).toBe(1);
  });

  it('keeps users apart and soft-deletes with a 30-day purge', async () => {
    const { history } = setup();
    const conv = await history.create('owner');
    expect(await history.load('someone-else', conv.id)).toBeNull();
    const now = new Date('2026-10-23T00:00:00Z');
    expect(await history.remove('owner', conv.id, now)).toBe(true);
    expect(await history.list('owner')).toHaveLength(0);
    expect(await history.purge(new Date('2026-11-21T00:00:00Z'))).toEqual({ conversations: 0, memories: 0 });
    expect(await history.purge(new Date('2026-11-22T00:00:01Z'))).toEqual({ conversations: 1, memories: 0 });
  });

  it('memories: create, search, disable, edit, delete; bad content refused', async () => {
    const { history } = setup();
    const m = await history.remember('owner', { content: '回覆一律用繁體中文', source: 'user_command' });
    expect(m).toMatchObject({ category: 'preference', active: true, source: 'user_command' });
    expect(await history.listMemories('owner', { query: '繁體' })).toHaveLength(1);
    await history.editMemory('owner', m.id, { active: false });
    expect(await history.listMemories('owner')).toHaveLength(0);
    expect(await history.listMemories('owner', { includeInactive: true })).toHaveLength(1);
    await expect(history.editMemory('owner', m.id, { content: '我的存款餘額要記住' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await history.forget('owner', m.id);
    expect(await history.listMemories('owner', { includeInactive: true })).toHaveLength(0);
    await expect(history.remember('owner', { content: '密碼是 1234', source: 'chat' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
