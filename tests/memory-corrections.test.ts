import { describe, expect, it } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { MemoryStore } from '@/memory/store';
import { searchMemories } from '@/router/memory';
import { vault } from './helpers/chat-hub';
const now = new Date('2026-10-30T02:00:00Z');
const id = '00000000-0000-4000-8000-000000000001';
function setup() { const store = new MemoryAgendaStore(); return { store, memory: new MemoryStore(store, vault) }; }

describe('memory corrections', () => {
  it('reads legacy sealed entries as revision 1 and preserves original provenance when correcting', async () => {
    const { store, memory } = setup();
    store.settings.set('memory:owner', vault.seal(JSON.stringify([{ id, content: '示範偏好：簡短回答', category: 'other', source: 'confirmed', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z' }]), 'memory:owner'));
    expect((await memory.list('owner'))[0]).toMatchObject({ revision: 1, source: 'confirmed' });
    const corrected = await memory.update('owner', id, { content: '示範偏好：回答附重點', category: 'preference' }, now, 1);
    expect(corrected).toMatchObject({ revision: 2, source: 'confirmed', category: 'preference', created_at: '2026-10-01T01:00:00Z', updated_at: now.toISOString() });
    expect(store.settings.get('memory:owner')).not.toContain('示範');
    expect((await new MemoryStore(store, vault).list('owner'))[0]).toEqual(corrected);
    expect(await memory.list('other')).toEqual([]);
    expect(await memory.update('other', id, { content: '不可寫入' }, now, 2)).toBeNull();
  });

  it('rejects stale same-entry corrections even with identical timestamps and retains unrelated concurrent additions', async () => {
    const { memory } = setup(); const { memory: first } = await memory.add('owner', { content: '測試條目原值', now });
    const outcomes = await Promise.allSettled([
      memory.update('owner', first.id, { content: '更正甲' }, now, 1),
      memory.update('owner', first.id, { content: '更正乙' }, now, 1),
      memory.add('owner', { content: '另一筆條目', now })
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const failure = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure?.reason).toMatchObject({ code: 'CONFLICT' });
    const list = await memory.list('owner'); expect(list).toHaveLength(2);
    expect(list.find(m => m.id === first.id)).toMatchObject({ revision: 2 });
    await expect(memory.update('owner', first.id, { content: '過期草稿' }, now, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await memory.list('owner')).find(m => m.id === first.id)?.content).not.toBe('過期草稿');
  });

  it('keeps old factual content stale when only classification changes, but dates a real correction', async () => {
    const { memory } = setup();
    const old = await memory.add('owner', { content: '示範體重 60 公斤', category: 'other', now: new Date('2026-01-01T01:00:00Z') });
    const categorized = await memory.update('owner', old.memory.id, { content: '  示範體重 60 公斤  ', category: 'health' }, now, 1);
    expect(categorized).toMatchObject({ revision: 2, category: 'health', updated_at: '2026-01-01T01:00:00.000Z' });
    expect(searchMemories(await memory.list('owner'), '體重', 5, now)[0].stale).toBe(true);
    await memory.update('owner', old.memory.id, { content: '示範體重 62 公斤' }, now, 2);
    const corrected = searchMemories(await memory.list('owner'), '體重', 5, now)[0];
    expect(corrected.stale).toBe(false); expect(corrected.record.updated_at).toBe(now.toISOString());
  });

  it('advances revision on duplicate refresh so an older page cannot correct or delete a renewed memory', async () => {
    const { memory } = setup(); const first = await memory.add('owner', { content: '示範偏好：條列重點', now });
    const again = await memory.add('owner', { content: '示範偏好：條列重點', now });
    expect(again.memory).toMatchObject({ id: first.memory.id, revision: 2 });
    await expect(memory.remove('owner', first.memory.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await memory.list('owner')).toHaveLength(1);
    expect(await memory.remove('owner', first.memory.id, 2)).toBe(true);
    expect(await memory.list('owner')).toEqual([]);
  });
});
