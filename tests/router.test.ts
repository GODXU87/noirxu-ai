import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costOf } from '@/cost/pricing';
import { calculate, classify } from '@/router/intents';
import { searchMemories } from '@/router/memory';
import { chooseTier, selectTools, trimHistory } from '@/router/tier';
import { historyProviderOf } from '@/server/providers/history';
import { chatHub, ctxAt, fakeOpenAI, vault } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');

const NOW = '2026-10-23T07:00:00Z'; // 15:00 Taipei
const base = { style: 'professional' as const, history: [] as unknown[] };

describe('intent rules (no model involved)', () => {
  it('recognises the local questions', () => {
    expect(classify('目前喝了多少水？')).toEqual({ kind: 'water_status' });
    expect(classify('今天有哪些待辦')).toEqual({ kind: 'agenda', range: 'today' });
    expect(classify('這個月花了多少？')).toEqual({ kind: 'ledger_month', which: 'this' });
    expect(classify('你記得我的體重嗎？')).toEqual({ kind: 'memory_recall', subject: '體重' });
    expect(classify('現在幾點')).toEqual({ kind: 'datetime', what: 'time' });
    expect(classify('125*8+30')).toEqual({ kind: 'calc', expression: '125*8+30' });
    expect(calculate('125*8+30')).toBe(1030);
    expect(calculate('2+(3')).toBeNull();
    expect(calculate('1/0')).toBeNull();
  });

  it('never handles actions, several requests or ambiguous text locally', () => {
    for (const text of ['幫我記午餐 150', '這個月花了多少然後幫我記帳', '提醒我明天喝水', '分析這個月的支出', '我喝了 300', '今天有什麼事順便查支出', '/喝水 300', '寄信給 Amy'])
      expect(classify(text), text).toBeNull();
  });

  it('reads the user words after a system note', () => {
    expect(classify('[系統紀錄]\n已確認：午餐 150\n\n今天有哪些待辦')).toEqual({ kind: 'agenda', range: 'today' });
  });
});

describe('zero model calls on the local path', () => {
  const env = { ...process.env };
  beforeEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.NOIRXU_AI_PROVIDER; });
  afterEach(() => { process.env = { ...env }; });

  it('answers water, agenda and Ledger questions with no API key and no model call', async () => {
    const { hub, water } = chatHub();
    await water.log('owner', '2026-10-23', 900, new Date(NOW));
    await hub.executor.invoke('agenda.items.create', { text: '今天 交月報 很重要' }, ctxAt(NOW));
    const { client, requests } = fakeOpenAI();
    const clients = { openai: () => client };

    const w = await handleChat(hub, ctxAt(NOW), { ...base, text: '目前喝了多少水？', clients });
    expect(w).toMatchObject({ ok: true, provider: 'local', route: { level: 'L1', source: 'tool' } });
    expect(w.ok && w.reply).toContain('900 / 2,000 ml');

    const a = await handleChat(hub, ctxAt(NOW), { ...base, text: '今天有哪些待辦', clients });
    expect(a.ok && a.reply).toContain('交月報');

    const l = await handleChat(hub, ctxAt(NOW), { ...base, text: '這個月花了多少？', clients });
    expect(l.ok && l.reply).toContain('TWD 3,943');
    expect(l.ok && l.reply).toContain('餐飲 2,100');

    expect(requests).toHaveLength(0);
    expect((await hub.cost.usage(new Date(NOW))).local.count).toBe(3);
  });

  it('says Ledger is not connected instead of guessing', async () => {
    const { hub, ledgerAnalytics } = chatHub({ ledgerConnected: false });
    const r = await handleChat(hub, ctxAt(NOW), { ...base, text: '這個月花了多少' });
    expect(r.ok && r.reply).toContain('Ledger 還沒連接');
    expect(ledgerAnalytics).not.toHaveBeenCalled();
  });

  it('answers a remembered fact with its date, and never invents a missing one', async () => {
    const known = chatHub({ memories: [{ id: 'm1', content: '體重 74 公斤', tags: ['體重'], updated_at: '2026-10-20T00:00:00Z' }] });
    const r = await handleChat(known.hub, ctxAt(NOW), { ...base, text: '你記得我的體重嗎？' });
    expect(r).toMatchObject({ ok: true, provider: 'local', route: { source: 'memory' } });
    expect(r.ok && r.reply).toContain('74 公斤');
    expect(r.ok && r.reply).toContain('2026-10-20');

    const stale = chatHub({ memories: [{ id: 'm1', content: '體重 74 公斤', tags: ['體重'], updated_at: '2026-01-01T00:00:00Z' }] });
    expect(((await handleChat(stale.hub, ctxAt(NOW), { ...base, text: '你記得我的體重嗎' })) as any).reply).toContain('可能已經變了');

    const none = chatHub({ memories: [] });
    expect(((await handleChat(none.hub, ctxAt(NOW), { ...base, text: '你記得我的體重嗎' })) as any).reply).toMatch(/^Sir，我沒有保存你的體重。$|^我沒有保存你的體重，Sir。$/);

    const off = chatHub();
    expect(((await handleChat(off.hub, ctxAt(NOW), { ...base, text: '你記得我的生日嗎' })) as any).reply).toContain('長期記憶目前還沒啟用');
  });

  it('a question that needs analysis reports that AI is not configured, without touching tools', async () => {
    const { hub } = chatHub();
    const r = await handleChat(hub, ctxAt(NOW), { ...base, text: '比較這兩個月的支出差異並給建議' });
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });
});

describe('the model path is sized to the task', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-test'; delete process.env.ANTHROPIC_API_KEY; delete process.env.NOIRXU_AI_PROVIDER; });
  afterEach(() => { process.env = { ...env }; });

  it('sends only recent turns and the relevant tools for a simple question', async () => {
    const { hub } = chatHub();
    const history = Array.from({ length: 300 }, (_, i) => (i % 2 ? { role: 'assistant', content: `回覆 ${i}` } : { role: 'user', content: `問題 ${i}` }));
    const { client, requests } = fakeOpenAI();
    const r = await handleChat(hub, ctxAt(NOW), { ...base, history, text: '幫我看一下最近一筆餐飲花費正不正常', clients: { openai: () => client } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.route.level).toBe('L2');
    expect(requests).toHaveLength(1);
    expect(requests[0].input.length).toBeLessThanOrEqual(13);
    expect(requests[0].tools.map((t: any) => t.name).every((n: string) => n.startsWith('ledger__') || n.startsWith('agenda__'))).toBe(true);
    expect(requests[0].max_output_tokens).toBe(4000);
    // Later turns keep up to 40 turns of context (more than this question needed); the
    // conversation on screen is stored separately and is never trimmed.
    expect(r.ok && r.messages.length).toBe(80);
  });

  it('deep research gets the full model, every tool and keeps the data-date rule', async () => {
    const { hub } = chatHub();
    const { client, requests } = fakeOpenAI();
    const r = await handleChat(hub, ctxAt(NOW), { ...base, text: '幫我深入研究 2330 的風險與失效條件', clients: { openai: () => client } });
    expect(r.ok && r.route.level).toBe('L3');
    expect(requests[0].tools.map((t: any) => t.name)).toContain('radar__stock__analyze');
    expect(requests[0].instructions).toContain('資料日期');
    expect(requests[0].max_output_tokens).toBe(16000);
  });

  it('stops paid calls at the budget while local answers keep working', async () => {
    const { hub } = chatHub();
    await hub.cost.setConfig({ monthly_usd: 0.01 });
    process.env.NOIRXU_AI_PRICES = JSON.stringify({ 'gpt-test': { input: 1, output: 10, cacheRead: 0.1 } });
    await hub.cost.recordTurn({ model: 'gpt-test', feature: 'chat_L2', usage: { calls: 1, input_tokens: 10_000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, now: new Date(NOW) });
    const { client, requests } = fakeOpenAI();
    const blocked = await handleChat(hub, ctxAt(NOW), { ...base, text: '分析我這個月的消費習慣', clients: { openai: () => client } });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(requests).toHaveLength(0);
    const local = await handleChat(hub, ctxAt(NOW), { ...base, text: '今天幾號' });
    expect(local.ok && local.reply).toContain('10 月 23 日');
  });

  it('stops a turn at the per-task call limit', async () => {
    const { hub } = chatHub();
    await hub.cost.setConfig({ max_calls_per_task: 1 });
    const requests: any[] = [];
    const client: any = { responses: { create: vi.fn(async (params: any) => { requests.push(structuredClone(params)); return { output: [{ type: 'function_call', call_id: `c${requests.length}`, name: 'agenda__items__list', arguments: '{}' }], output_text: '', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } }; }) } };
    const r = await handleChat(hub, ctxAt(NOW), { ...base, text: '把最近的提醒依時間整理給我看', clients: { openai: () => client } });
    expect(requests).toHaveLength(1);
    expect(r.ok && r.stopReason).toBe('budget');
  });
});

describe('token helpers', () => {
  it('trims only at the start of a user turn, keeping tool calls with their results', () => {
    const history = [
      { role: 'user', content: 'q1' }, { type: 'function_call', call_id: 'a' }, { type: 'function_call_output', call_id: 'a' }, { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2' }, { type: 'function_call', call_id: 'b' }, { type: 'function_call_output', call_id: 'b' }, { role: 'assistant', content: 'r2' }
    ];
    const { history: kept, dropped } = trimHistory(history, 1);
    expect(dropped).toBe(4);
    expect(kept[0]).toEqual({ role: 'user', content: 'q2' });
    expect(kept.filter((m: any) => m.type === 'function_call').length).toBe(kept.filter((m: any) => m.type === 'function_call_output').length);
  });

  it('chooses tiers and tools deterministically', () => {
    expect(chooseTier('今天天氣如何', 'balanced')).toBe('L2');
    expect(chooseTier('幫我規劃下週的工作與出差', 'balanced')).toBe('L3');
    expect(chooseTier('今天天氣如何', 'quality')).toBe('L3');
    const { hub } = chatHub();
    expect(selectTools(hub.registry, '隨便聊聊', 'L2').list().length).toBe(hub.registry.list().length);
  });

  it('local answers keep the history usable by either provider', () => {
    expect(historyProviderOf([{ role: 'user', content: '今天幾號' }, { role: 'assistant', content: '10 月 23 日' }])).toBeNull();
    expect(historyProviderOf([{ role: 'user', content: 'x' }, { type: 'function_call' }])).toBe('openai');
    expect(historyProviderOf([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])).toBe('anthropic');
  });

  it('memory search returns only the top few relevant records', () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, content: `雜項記憶 ${i}`, updated_at: '2026-10-01T00:00:00Z' }));
    records.push({ id: 'w', content: '每天早上喝一杯美式咖啡', updated_at: '2026-10-10T00:00:00Z' });
    const hits = searchMemories(records, '我喝什麼咖啡', 3);
    expect(hits[0].record.id).toBe('w');
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe('cost includes cache reads and writes', () => {
  it('prices Anthropic cache writes at 1.25x input and reads at the cache rate', () => {
    expect(costOf('claude-opus-5-5', { calls: 1, input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(4 + 0.2 + 5);
  });
  it('bills OpenAI cached tokens at the cached rate inside input_tokens, from configuration', () => {
    process.env.NOIRXU_AI_PRICES = JSON.stringify({ 'gpt-x': { input: 1, output: 8, cacheRead: 0.1 } });
    expect(costOf('gpt-x', { calls: 1, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 })).toBeCloseTo(0.6 + 0.04 + 0.8);
    expect(costOf('unknown-model', { calls: 1, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull();
    delete process.env.NOIRXU_AI_PRICES;
  });
});

describe('app-level cache', () => {
  it('reuses slow-changing reads and clears them after a write', async () => {
    const { hub } = chatHub();
    const ctx = ctxAt(NOW);
    await hub.executor.invoke('radar.stock.analyze', { symbol: '2330' }, ctx);
    await hub.executor.invoke('radar.stock.analyze', { symbol: '2330' }, ctx);
    expect(hub.executor.cacheHits).toBe(1);
    await hub.executor.invoke('agenda.items.create', { text: '明天 開會' }, ctx);
    await hub.executor.invoke('radar.stock.analyze', { symbol: '2330' }, ctx);
    expect(hub.executor.cacheHits).toBe(1);
    // Amounts are never cached.
    await hub.executor.invoke('ledger.analytics.get', { month: '2026-10' }, ctx);
    await hub.executor.invoke('ledger.analytics.get', { month: '2026-10' }, ctx);
    expect(hub.executor.cacheHits).toBe(1);
  });
});

void vault;
