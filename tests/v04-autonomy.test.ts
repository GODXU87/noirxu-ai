import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryAgendaStore } from '@/agenda/store';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { DeliveryService } from '@/notify/delivery';
import { decide, DEFAULT_PROACTIVE, inQuietHours, ProactiveNotifier, PROACTIVE_PREFS_KEY } from '@/notify/policy';
import type { SendReport } from '@/push/service';
import { classify } from '@/router/intents';
import { parseTaskText } from '@/tasks/parse';
import { TaskService } from '@/tasks/service';
import { taskTools } from '@/tools/tasks/tools';
import { ctxAt, vault } from './helpers/chat-hub';

const accepted: SendReport = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const T = (iso: string) => new Date(iso);
const NOON = '2026-10-23T04:00:00Z'; // 12:00 Taipei
const NIGHT = '2026-10-23T15:30:00Z'; // 23:30 Taipei

function rig(options: { important?: boolean; slowTool?: boolean } = {}) {
  const agenda = new MemoryAgendaStore();
  const registry = new ToolRegistry();
  const hubStore = new MemoryHubStore();
  const read = (name: string, data: unknown) => defineTool({ name, description: '', connection: 'internal', kind: 'read', input: z.object({}).loose(), output: z.unknown(), run: vi.fn(async () => ({ data })) });
  registry.register(read('radar.signals.scan', { trade_date: '2026-10-22', signals: [{ symbol: '2330' }, { symbol: '2454' }, { symbol: '3008' }] }));
  registry.register(read('journal.trades.list', { trades: [{ id: 't1' }], total_matching: 4 }));
  registry.register(read('gmail.messages.search', { messages: [{ id: 'm1' }, { id: 'm2' }] }));
  registry.register(defineTool({ name: 'radar.slow.status', description: '', connection: 'internal', kind: 'read', input: z.object({}).loose(), output: z.unknown(), run: () => new Promise<never>(() => undefined) }));
  const sendRun = vi.fn(async () => ({ data: { id: 'sent-1' }, recordId: 'sent-1' }));
  registry.register(defineTool({ name: 'gmail.message.send', description: '', connection: 'internal', kind: 'send', input: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }), output: z.unknown(), async preview(v) { return { title: `寄信給 ${v.to.join(', ')}`, fields: [{ label: '主旨', value: v.subject }], body: v.body }; }, run: sendRun }));
  const executor = new Executor({ registry, store: hubStore, isConnected: async () => true });
  const send = vi.fn(async (..._args: unknown[]) => accepted);
  const delivery = new DeliveryService(agenda, vault, send);
  const notifier = new ProactiveNotifier(agenda, vault, delivery);
  const tasks = new TaskService({
    store: agenda, vault, executor, proposals: hubStore, stepTimeoutMs: 50,
    notify: ({ key, userId, message, now, proactive }) => {
      const expiresAt = new Date(now.getTime() + 12 * 3600_000);
      return proactive ? notifier.notify({ key, kind: 'task', userId, message, now, expiresAt, priority: 'normal' }) : delivery.deliver({ key, kind: 'task', userId, message, now, expiresAt });
    },
    briefing: async () => ({ title: '晚報', body: '明天：交月報', important: options.important ?? false })
  });
  taskTools({ tasks, hasTool: n => Boolean(registry.get(n)) }).forEach(t => registry.register(t));
  const create = async (input: unknown, at = '2026-10-23T00:00:00Z') => { const r = await executor.invoke('tasks.create', input, ctxAt(at)); if (r.status !== 'ok') throw new Error(JSON.stringify(r)); return (r.data as any).task.id as string; };
  return { agenda, registry, hubStore, executor, delivery, send, notifier, tasks, sendRun, create };
}

describe('proactive notification limits', () => {
  it('quiet hours and the daily cap file alerts in the inbox; critical always pushes', () => {
    expect(inQuietHours(DEFAULT_PROACTIVE, T(NIGHT))).toBe(true);
    expect(inQuietHours(DEFAULT_PROACTIVE, T(NOON))).toBe(false);
    expect(decide({ priority: 'normal', now: T(NIGHT), sentToday: 0, prefs: DEFAULT_PROACTIVE })).toMatchObject({ action: 'inbox' });
    expect(decide({ priority: 'critical', now: T(NIGHT), sentToday: 99, prefs: DEFAULT_PROACTIVE })).toEqual({ action: 'push' });
    expect(decide({ priority: 'normal', now: T(NOON), sentToday: 6, prefs: DEFAULT_PROACTIVE })).toMatchObject({ action: 'inbox', reason: expect.stringContaining('6 則上限') });
    expect(decide({ priority: 'high', now: T(NOON), sentToday: 6, prefs: DEFAULT_PROACTIVE })).toEqual({ action: 'push' });
  });

  it('never drops an alert over the limit, and the same event id is never sent twice', async () => {
    const { notifier, delivery, send, agenda } = rig();
    agenda.settings.set(PROACTIVE_PREFS_KEY, JSON.stringify({ daily_cap: 2 }));
    const msg = (n: number) => ({ title: `警示 ${n}`, body: '' });
    for (const n of [1, 1, 2, 3]) await notifier.notify({ key: `finance:${n}`, kind: 'finance', userId: 'owner', message: msg(n), priority: 'normal', now: T(NOON), expiresAt: T('2026-10-24T00:00:00Z') });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await delivery.get('finance:3')).toMatchObject({ status: 'held', held_reason: expect.stringContaining('上限') });
    expect((await delivery.inbox('owner')).map(e => e.key).sort()).toEqual(['finance:1', 'finance:2', 'finance:3']);
  });
});

describe('emergency stop', () => {
  it('stops every background run without touching tasks or history, and resumes', async () => {
    const { tasks, executor, send, create } = rig();
    const id = await create({ text: '每天中午12點提醒我吃藥' });
    expect(classify('停止所有自動任務')).toEqual({ kind: 'task_halt', halted: true });
    await executor.invoke('tasks.halt', { halted: true }, ctxAt(NOON));
    expect(await tasks.runDue(T('2026-10-23T04:00:30Z'))).toMatchObject({ halted: true, ran: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await tasks.get(id))!.status).toBe('queued');
    expect((await executor.invoke('tasks.list', {}, ctxAt(NOON)) as any).data.halted).toBe(true);
    await executor.invoke('tasks.halt', { halted: false }, ctxAt(NOON));
    await tasks.runDue(T('2026-10-23T04:01:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('acceptance workflows', () => {
  it('A. daily evening review of tomorrow, notifying only when something important is coming', async () => {
    const parsed = parseTaskText('每天晚上幫我整理明天的工作，重要的事情再通知我', '2026-10-23');
    expect(parsed).toMatchObject({ ok: true, task: { title: '晚上整理明天的工作', default_time: '21:00', schedule: { type: 'daily', time: '21:00' }, steps: [{ type: 'briefing', which: 'evening', only_if_important: true }] } });

    const quiet = rig({ important: false });
    const id = await quiet.create({ text: '每天晚上幫我整理明天的工作，重要的事情再通知我' });
    await quiet.tasks.runDue(T('2026-10-23T13:00:10Z'));
    expect(quiet.send).not.toHaveBeenCalled();
    expect((await quiet.tasks.get(id))!.runs[0]).toMatchObject({ status: 'completed', steps: [{ status: 'skipped', summary: '沒有重要事項，這次不通知' }] });

    const busy = rig({ important: true });
    await busy.create({ text: '每天晚上幫我整理明天的工作，重要的事情再通知我' });
    await busy.tasks.runDue(T('2026-10-23T13:00:10Z'));
    expect(busy.send).toHaveBeenCalledTimes(1);
    expect(busy.send.mock.calls[0][1]).toMatchObject({ title: '晚報', body: '明天：交月報' });
  });

  it('B. cross-tool check (RADAR + Journal) reports what each tool found, with data dates and tool-call count', async () => {
    const { tasks, send, create } = rig();
    const id = await create({
      title: '收盤後 RADAR 訊號對照持倉', schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '15:00' },
      steps: [{ type: 'tool', tool: 'radar.signals.scan', input: {} }, { type: 'tool', tool: 'journal.trades.list', input: { status: 'open' } }, { type: 'notify', title: '今日訊號與持倉', include_results: true }]
    });
    await tasks.runDue(T('2026-10-23T07:00:10Z'));
    const run = (await tasks.get(id))!.runs[0];
    expect(run).toMatchObject({ status: 'completed', tool_calls: 2, llm_tokens: 0 });
    expect(run.steps.map(s => s.summary).slice(0, 2)).toEqual(['3 個訊號，資料日期 2026-10-22', '4 筆交易']);
    expect(send.mock.calls[0][1]).toMatchObject({ title: 'SASUKE · 今日訊號與持倉', body: 'radar.signals.scan：3 個訊號，資料日期 2026-10-22\njournal.trades.list：4 筆交易' });
  });

  it('C. Gmail task: reading runs automatically, sending waits for approval and is audited', async () => {
    const { tasks, executor, hubStore, sendRun, create } = rig();
    const id = await create({
      title: '週五寄週報', schedule: { type: 'weekly', weekdays: [5], time: '17:00' },
      steps: [{ type: 'tool', tool: 'gmail.messages.search', input: {} }, { type: 'tool', tool: 'gmail.message.send', input: { to: ['me@example.com'], subject: '週報', body: '本週摘要' } }]
    });
    await tasks.runDue(T('2026-10-23T09:00:10Z'));
    let task = (await tasks.get(id))!;
    expect(task.status).toBe('waiting_approval');
    expect(task.runs[0].steps.map(s => s.status)).toEqual(['ok', 'waiting_approval']);
    expect(sendRun).not.toHaveBeenCalled();
    const outcome = await executor.confirm(task.waiting_proposal!, ctxAt('2026-10-23T09:05:00Z'));
    expect(outcome.status).toBe('succeeded');
    await tasks.runDue(T('2026-10-23T09:06:00Z'));
    task = (await tasks.get(id))!;
    expect(task).toMatchObject({ status: 'queued', runs: [{ status: 'completed' }] });
    expect(task.next_at).toBe('2026-10-30T09:00:00.000Z');
    expect(sendRun).toHaveBeenCalledTimes(1);
    expect(hubStore.audit.map(a => [a.tool, a.event])).toEqual(expect.arrayContaining([['gmail.messages.search', 'read'], ['gmail.message.send', 'proposed']]));
  });

  it('a step that hangs is stopped and reported instead of holding the run', async () => {
    const { tasks, create } = rig();
    const id = await create({ title: '慢查詢', schedule: { type: 'once', at: '2026-10-23T04:00:00Z' }, steps: [{ type: 'tool', tool: 'radar.slow.status', input: {} }] });
    await tasks.runDue(T('2026-10-23T04:00:10Z'));
    expect((await tasks.get(id))!).toMatchObject({ status: 'failed', runs: [{ error: expect.stringContaining('秒未完成') }] });
  });
});
