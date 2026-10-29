import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { isCorrection, QUALITY_LIMIT, QualityLog, summarize, turnEvents, type QualityEvent } from '@/quality/log';
import { parseCommand } from '@/assistant/commands';
import { loadFeatureFlags } from '@/lib/features';
import { chatHub, ctxAt, fakeOpenAI, vault } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');
const NOW = new Date('2026-10-29T02:00:00Z');
const WEEK_AGO = new Date(NOW.getTime() - 7 * 86_400_000);

describe('quality log', () => {
  it('keeps short sealed snippets, the newest QUALITY_LIMIT events, and skips expected errors', async () => {
    const store = new MemoryAgendaStore();
    const log = new QualityLog(store, vault);
    await log.record('owner', [{ kind: 'correction', text: `不對，${'羽球'.repeat(100)}`, source: 'L1 garmin_sleep' }], NOW);
    expect(store.settings.get('quality:owner')).not.toContain('羽球');
    const [first] = await log.list('owner');
    expect(first.text!.length).toBeLessThanOrEqual(121);
    await log.record('owner', [{ kind: 'tool_error', source: 'ledger.analytics.get', code: 'NOT_CONNECTED' }, { kind: 'chat_error', code: 'BUDGET_EXCEEDED' }], NOW);
    expect(await log.list('owner')).toHaveLength(1);
    for (let i = 0; i < QUALITY_LIMIT + 5; i += 1) await log.record('owner', [{ kind: 'thumbs_up' }], NOW);
    expect(await log.list('owner', 1000)).toHaveLength(QUALITY_LIMIT);
    await log.clear('owner');
    expect(await log.list('owner')).toEqual([]);
  });

  it('recognises corrections narrowly', () => {
    for (const t of ['不對', '不對，是週三', '錯了啦', 'Sir，你搞錯了', '算錯了吧', '不是這樣']) expect(isCorrection(t)).toBe(true);
    for (const t of ['不是很急', '不對稱的設計怎麼看', '幫我查錯誤率', '今天天氣如何', '你確定的話就好', '錯誤率是多少', '好']) expect(isCorrection(t)).toBe(false);
  });

  it('turns a chat turn into events: failed tools, and a correction pinned on the previous reply', () => {
    const events = turnEvents({ text: '不對，我昨天睡了 7 小時', previousRoute: 'L1 garmin_sleep', route: 'L2', events: [
      { tool: 'garmin.sleep.summary', result: { status: 'error', code: 'UPSTREAM_UNAVAILABLE' } },
      { tool: 'agenda.items.list', result: { status: 'ok' } }
    ] });
    expect(events).toEqual([
      { kind: 'tool_error', source: 'garmin.sleep.summary', code: 'UPSTREAM_UNAVAILABLE' },
      { kind: 'correction', source: 'L1 garmin_sleep', text: '不對，我昨天睡了 7 小時' }
    ]);
  });

  it('summarises the week with fixed-rule suggestions only when something stands out', () => {
    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const ev = (kind: QualityEvent['kind'], extra: Partial<QualityEvent> = {}, h = 1): QualityEvent => ({ id: Math.random().toString(), at: at(h), kind, ...extra });
    const quiet = summarize([ev('thumbs_up'), ev('tool_error', { source: 'radar.list', code: 'UPSTREAM_UNAVAILABLE' }, 24 * 9)], WEEK_AGO, NOW);
    expect(quiet.counts).toMatchObject({ thumbs_up: 1, tool_error: 0 });
    expect(quiet.suggestions).toEqual([]);

    const busy = summarize([
      ...[1, 2, 3].map(h => ev('tool_error', { source: 'radar.list', code: 'UPSTREAM_UNAVAILABLE' }, h)),
      ev('tool_error', { source: 'garmin.sleep.summary', code: 'UNAUTHORIZED' }),
      ...[1, 2, 3].map(h => ev('thumbs_down', { text: `回覆 ${h}`, source: 'L2' }, h)),
      ev('thumbs_up'),
      ...[1, 2, 3].map(h => ev('correction', { text: '不對', source: 'L1 garmin_sleep' }, h))
    ], WEEK_AGO, NOW);
    expect(busy.failing_tools[0]).toEqual({ tool: 'radar.list', count: 3, code: 'UPSTREAM_UNAVAILABLE', reason: '來源連不上' });
    expect(busy.suggestions.join('\n')).toContain('radar.list 失敗了 3 次');
    expect(busy.suggestions.join('\n')).toContain('4 次評分中有 3 次 👎');
    expect(busy.suggestions.join('\n')).toContain('「L1 garmin_sleep」');
    expect(busy.recent_issues).toHaveLength(5);
    expect(busy.recent_issues[0].at >= busy.recent_issues[4].at).toBe(true);
  });
});

describe('quality self-check in chat', () => {
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-test'; delete process.env.ANTHROPIC_API_KEY; delete process.env.NOIRXU_AI_PROVIDER; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; });

  it('logs a correction against the previous reply route, and nothing for a normal turn', async () => {
    const { hub, agenda } = chatHub();
    hub.quality = new QualityLog(agenda, vault);
    const { client } = fakeOpenAI();
    const say = (text: string, previousRoute?: string) => handleChat(hub, ctxAt(NOW.toISOString()), { style: 'professional', history: [], text, previousRoute, clients: { openai: () => client } });
    await say('幫我想一下這週的訓練怎麼排比較好');
    expect(await hub.quality.list('owner')).toEqual([]);
    await say('不對，週三是羽球', 'L2');
    expect(await hub.quality.list('owner')).toMatchObject([{ kind: 'correction', source: 'L2', text: '不對，週三是羽球' }]);
    // System notes in front of the message do not hide the correction.
    await say('[系統紀錄]\n已記錄喝水 300 ml\n\n錯了，是 500', 'L1 water_log');
    expect((await hub.quality.list('owner'))[0]).toMatchObject({ kind: 'correction', source: 'L1 water_log', text: '錯了，是 500' });
  });

  it('works without the log (feature off)', async () => {
    const { hub } = chatHub();
    const { client } = fakeOpenAI();
    const result = await handleChat(hub, ctxAt(NOW.toISOString()), { style: 'professional', history: [], text: '不對', clients: { openai: () => client } });
    expect(result.ok).toBe(true);
  });
});

describe('quality wiring', () => {
  it('is a default-on feature with a /品質 command', () => {
    expect(loadFeatureFlags('', '').quality).toBe(true);
    expect(loadFeatureFlags('quality', '').quality).toBe(false);
    expect(parseCommand('/品質')).toEqual({ name: 'quality', arg: '', via: 'slash' });
  });
});
