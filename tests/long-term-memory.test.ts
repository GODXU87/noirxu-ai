import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { categorize, MEMORY_LIMIT, MemoryStore } from '@/memory/store';
import { classify } from '@/router/intents';
import { memoryTools } from '@/tools/memory/tools';
import { chatHub, ctxAt, fakeOpenAI, vault } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');
const NOW = new Date('2026-10-29T02:00:00Z');

describe('long-term memory store', () => {
  it('keeps what the user asked, sealed, without duplicates, and can edit and delete', async () => {
    const store = new MemoryAgendaStore();
    const mem = new MemoryStore(store, vault);
    const a = await mem.add('owner', { content: '週三羽球改到晚上 8 點。', now: NOW });
    expect(a).toMatchObject({ updated: false, memory: { content: '週三羽球改到晚上 8 點', category: 'routine', source: 'user' } });
    expect(store.settings.get('memory:owner')).not.toContain('羽球');
    const again = await mem.add('owner', { content: '週三羽球改到晚上8點', now: new Date('2026-10-30T00:00:00Z') });
    expect(again.updated).toBe(true);
    expect(await mem.list('owner')).toHaveLength(1);
    await mem.update('owner', a.memory.id, { content: '週三羽球改到晚上 9 點' }, NOW);
    expect((await mem.list('owner'))[0].content).toBe('週三羽球改到晚上 9 點');
    expect(await mem.remove('owner', a.memory.id)).toBe(true);
    expect(await mem.list('owner')).toEqual([]);
    expect(MEMORY_LIMIT).toBe(300);
  });

  it('files memories under sensible categories', () => {
    expect(categorize('我對花生過敏')).toBe('health');
    expect(categorize('目標是明年三月完成 HYROX')).toBe('goal');
    expect(categorize('我喜歡美式咖啡不加糖')).toBe('preference');
    expect(categorize('以後早報不要放喝水')).toBe('decision');
  });
});

describe('memory in the chat (no model call)', () => {
  it('"記住…" saves, a later question recalls it with the date, and "忘記…" asks before deleting', async () => {
    expect(classify('記住我對花生過敏')).toEqual({ kind: 'memory_save', content: '我對花生過敏' });
    expect(classify('幫我記住：週三羽球改到晚上 8 點')).toEqual({ kind: 'memory_save', content: '週三羽球改到晚上 8 點' });
    expect(classify('忘記花生那件事')).toEqual({ kind: 'memory_forget', subject: '花生那件事' });

    const { hub, agenda } = chatHub();
    const mem = new MemoryStore(agenda, vault);
    memoryTools(mem).forEach(t => hub.registry.register(t));
    hub.memory = mem;
    const { client, requests } = fakeOpenAI();
    const say = (text: string) => handleChat(hub, ctxAt(NOW.toISOString()), { style: 'professional', history: [], text, clients: { openai: () => client } });

    const saved = await say('記住我的體重 74 公斤');
    expect(saved.ok && saved.reply).toBe('記住了，Sir：我的體重 74 公斤。之後需要時我會用上；想看或修改，在「個人記憶」。');
    const recalled = await say('你記得我的體重嗎');
    expect(recalled.ok && recalled.reply).toContain('我的體重 74 公斤（2026-10-29 記錄）');
    const forget = await say('忘記體重');
    expect(forget.ok && forget.reply).toContain('找到這筆：「我的體重 74 公斤」。確認後就刪除');
    expect(forget.ok && forget.events[0].result.status).toBe('confirmation_required');
    expect(await mem.list('owner')).toHaveLength(1); // nothing deleted until confirmed
    expect(requests).toHaveLength(0);
  });
});
