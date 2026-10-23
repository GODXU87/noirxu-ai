import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryAgendaStore } from '@/agenda/store';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { DeliveryService } from '@/notify/delivery';
import type { SendReport } from '@/push/service';
import { classify } from '@/router/intents';
import { nextRun } from '@/tasks/model';
import { parseTaskText } from '@/tasks/parse';
import { TaskService } from '@/tasks/service';
import { taskTools } from '@/tools/tasks/tools';
import { agendaTools } from '@/tools/agenda/tools';
import { chatHub, ctxAt, fakeOpenAI, LEDGER_OCTOBER, vault } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');

const accepted: SendReport = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const none: SendReport = { sent: 0, failed: 0, noSubscription: true, devices: [] };
const T = (iso: string) => new Date(iso);
// 2026-10-23 is a Friday. 08:00 Taipei = 00:00Z.
const BEFORE = '2026-10-22T23:00:00Z'; // 07:00 Taipei
const DUE = '2026-10-23T00:00:30Z'; // 08:00:30 Taipei

function setup(options: { sends?: SendReport[] } = {}) {
  const agenda = new MemoryAgendaStore();
  const registry = new ToolRegistry();
  const store = new MemoryHubStore();
  agendaTools(agenda).forEach(t => registry.register(t));
  const analytics = vi.fn(async () => ({ data: LEDGER_OCTOBER }));
  registry.register(defineTool({ name: 'ledger.analytics.get', description: '', connection: 'ledger', kind: 'read', input: z.object({ month: z.string() }), output: z.unknown(), run: analytics }));
  const expenseRun = vi.fn(async () => ({ data: { id: 'tx1' }, recordId: 'tx1' }));
  registry.register(defineTool({ name: 'ledger.expense.create', description: '', connection: 'ledger', kind: 'write', input: z.object({ amount: z.number() }).loose(), output: z.unknown(), async preview(v) { return { title: `新增支出 ${v.amount}`, fields: [] }; }, run: expenseRun }));
  const executor = new Executor({ registry, store, isConnected: async () => true });
  const sends = [...(options.sends ?? [accepted])];
  const send = vi.fn(async (..._args: unknown[]) => (sends.length > 1 ? sends.shift()! : sends[0]));
  const delivery = new DeliveryService(agenda, vault, send);
  const tasks = new TaskService({
    store: agenda, vault, executor, proposals: store,
    notify: ({ key, userId, message, now }) => delivery.deliver({ key, kind: 'task', userId, message, now, expiresAt: new Date(now.getTime() + 12 * 3600_000) }),
    briefing: async which => ({ title: which === 'morning' ? '早報' : '晚報', body: '測試內容' }),
    redeliver: async (key, now) => { const r = await delivery.get(key); return r ? (await delivery.deliver({ key, kind: r.kind, userId: r.user_id, message: r.message, expiresAt: new Date(r.expires_at), now })).status : null; }
  });
  taskTools({ tasks, hasTool: n => Boolean(registry.get(n)) }).forEach(t => registry.register(t));
  return { agenda, registry, store, executor, delivery, send, tasks, analytics, expenseRun };
}

describe('task parser (rules, no model)', () => {
  const today = '2026-10-23';
  it('reads recurring reminders, briefings and spending watches', () => {
    expect(parseTaskText('每天早上8點提醒我喝水', today)).toMatchObject({ ok: true, task: { kind: 'recurring', title: '喝水', schedule: { type: 'daily', time: '08:00' } } });
    expect(parseTaskText('每週一三五晚上9點提醒我運動', today)).toMatchObject({ ok: true, task: { schedule: { type: 'weekly', weekdays: [1, 3, 5], time: '21:00' } } });
    expect(parseTaskText('工作日早上9點給我早報', today)).toMatchObject({ ok: true, task: { title: '早報', schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5] }, steps: [{ type: 'briefing', which: 'morning' }] } });
    expect(parseTaskText('每月5號早上10點提醒我繳信用卡', today)).toMatchObject({ ok: true, task: { schedule: { type: 'monthly', day: 5, time: '10:00' } } });
    expect(parseTaskText('每隔2小時提醒我起來走走', today)).toMatchObject({ ok: true, task: { schedule: { type: 'interval', minutes: 120 } } });
    expect(parseTaskText('如果這個月餐飲支出超過5000就提醒我', today)).toMatchObject({ ok: true, task: { kind: 'conditional', condition: { type: 'ledger_month_expense_over', amount: 5000, category: '餐飲' } } });
  });

  it('refuses incomplete or too-frequent requests instead of guessing, and leaves the rest to the model', () => {
    expect(parseTaskText('每天提醒我喝水', today)).toMatchObject({ ok: false });
    expect(parseTaskText('每隔10分鐘提醒我', today)).toMatchObject({ ok: false });
    expect(parseTaskText('明天9點提醒我開會', today)).toBeNull();
    expect(parseTaskText('幫我研究台積電', today)).toBeNull();
  });

  it('monthly day 31 falls back to the last day of a short month', () => {
    expect(nextRun({ type: 'monthly', day: 31, time: '09:00' }, T('2026-11-01T00:00:00Z'))?.toISOString()).toBe('2026-11-30T01:00:00.000Z');
  });
});

describe('task scheduler', () => {
  it('runs a recurring slot once even when scheduler runs overlap, then moves to the next day', async () => {
    const { tasks, executor, send, agenda } = setup();
    const created = await executor.invoke('tasks.create', { text: '每天早上8點提醒我喝水' }, ctxAt(BEFORE));
    expect(created.status).toBe('ok');
    const id = (created as any).data.task.id;
    await Promise.all(Array.from({ length: 5 }, () => tasks.runDue(T(DUE))));
    expect(send).toHaveBeenCalledTimes(1);
    const task = (await tasks.get(id))!;
    expect(task).toMatchObject({ status: 'queued', next_at: '2026-10-24T00:00:00.000Z' });
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]).toMatchObject({ status: 'completed', steps: [{ type: 'notify', delivery_status: 'provider_accepted' }] });
    // Persisted in the settings table, sealed — not readable as plain text.
    expect(agenda.settings.get(`task:${id}`)).toBeTruthy();
    expect(agenda.settings.get(`task:${id}`)).not.toContain('喝水');
  });

  it('cancelled and paused tasks send nothing; resume picks the next future slot', async () => {
    const { tasks, executor, send } = setup();
    const a = (await executor.invoke('tasks.create', { text: '每天早上8點提醒我喝水' }, ctxAt(BEFORE)) as any).data.task.id;
    const b = (await executor.invoke('tasks.create', { text: '每天早上8點提醒我伸展' }, ctxAt(BEFORE)) as any).data.task.id;
    await executor.invoke('tasks.update', { id: a, action: 'cancel' }, ctxAt(BEFORE));
    await executor.invoke('tasks.update', { id: b, action: 'pause' }, ctxAt(BEFORE));
    await tasks.runDue(T(DUE));
    expect(send).not.toHaveBeenCalled();
    const resumed = await executor.invoke('tasks.update', { id: b, action: 'resume' }, ctxAt('2026-10-23T02:00:00Z'));
    expect((resumed as any).data.task).toMatchObject({ status: 'queued', next_at: '2026-10-24T00:00:00.000Z' });
    const again = await executor.invoke('tasks.update', { id: a, action: 'resume' }, ctxAt(BEFORE));
    expect(again).toMatchObject({ status: 'error', message: '這個任務已經結束，無法再更改。' });
  });

  it('skips a recurring slot missed for hours instead of replaying it late', async () => {
    const { tasks, executor, send } = setup();
    const id = (await executor.invoke('tasks.create', { text: '每天早上8點提醒我喝水' }, ctxAt(BEFORE)) as any).data.task.id;
    await tasks.runDue(T('2026-10-23T07:00:00Z')); // 15:00 Taipei, 7 h late
    expect(send).not.toHaveBeenCalled();
    expect((await tasks.get(id))!).toMatchObject({ status: 'queued', next_at: '2026-10-24T00:00:00.000Z', runs: [{ status: 'skipped' }] });
  });

  it('a write step waits for the user; approval completes it and the write is never repeated', async () => {
    const { tasks, executor, store, expenseRun } = setup();
    const created = await executor.invoke('tasks.create', { title: '每月房租記帳', schedule: { type: 'monthly', day: 23, time: '08:00' }, steps: [{ type: 'tool', tool: 'ledger.expense.create', input: { amount: 15000 } }] }, ctxAt(BEFORE));
    const id = (created as any).data.task.id;
    await tasks.runDue(T(DUE));
    let task = (await tasks.get(id))!;
    expect(task.status).toBe('waiting_approval');
    expect(expenseRun).not.toHaveBeenCalled();
    await tasks.runDue(T('2026-10-23T00:05:00Z'));
    expect((await tasks.get(id))!.status).toBe('waiting_approval');
    await executor.confirm(task.waiting_proposal!, ctxAt('2026-10-23T00:10:00Z'));
    await tasks.runDue(T('2026-10-23T00:12:00Z'));
    task = (await tasks.get(id))!;
    expect(task).toMatchObject({ status: 'queued', next_at: '2026-11-23T00:00:00.000Z', runs: [{ status: 'completed' }] });
    await tasks.runDue(T('2026-10-23T01:00:00Z'));
    expect(expenseRun).toHaveBeenCalledTimes(1);
    expect((await store.getProposal(task.runs[0].steps[0].proposal_id!))?.status).toBe('succeeded');
  });

  it('an approval left unanswered past the confirmation window fails without writing', async () => {
    const { tasks, executor, expenseRun } = setup();
    const id = (await executor.invoke('tasks.create', { title: '記帳', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, steps: [{ type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } }] }, ctxAt(BEFORE)) as any).data.task.id;
    await tasks.runDue(T(DUE));
    await tasks.runDue(T('2026-10-23T00:30:00Z'));
    expect((await tasks.get(id))!).toMatchObject({ status: 'failed', runs: [{ error: '確認已逾期，沒有執行' }] });
    expect(expenseRun).not.toHaveBeenCalled();
  });

  it('a rejected approval is recorded and nothing is written', async () => {
    const { tasks, executor, expenseRun } = setup();
    const id = (await executor.invoke('tasks.create', { title: '一次性記帳', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, steps: [{ type: 'tool', tool: 'ledger.expense.create', input: { amount: 99 } }] }, ctxAt(BEFORE)) as any).data.task.id;
    await tasks.runDue(T(DUE));
    await executor.reject((await tasks.get(id))!.waiting_proposal!, ctxAt(DUE));
    await tasks.runDue(T('2026-10-23T00:10:00Z'));
    expect((await tasks.get(id))!).toMatchObject({ status: 'failed', runs: [{ error: '你取消了這個操作' }] });
    expect(expenseRun).not.toHaveBeenCalled();
  });

  it('a run that crashed mid-way becomes outcome_unknown and is not re-run', async () => {
    const { tasks, executor, agenda, expenseRun } = setup();
    const id = (await executor.invoke('tasks.create', { title: '記帳', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, steps: [{ type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } }] }, ctxAt(BEFORE)) as any).data.task.id;
    const stuck = { ...(await tasks.get(id))!, status: 'running', lease_until: '2026-10-23T00:02:00Z', last_slot: '2026-10-23T00:00:00.000Z' };
    agenda.settings.set(`task:${id}`, vault.seal(JSON.stringify(stuck), `task:${id}`));
    await tasks.runDue(T('2026-10-23T00:10:00Z'));
    expect((await tasks.get(id))!.status).toBe('outcome_unknown');
    expect(expenseRun).not.toHaveBeenCalled();
  });

  it('a spending watch notifies once per month, only when the real Ledger total crosses it', async () => {
    const { tasks, executor, send, analytics } = setup();
    // October test data: total expense 3,943, of which 餐飲 2,100.
    await executor.invoke('tasks.create', { text: '如果這個月支出超過3000就提醒我' }, ctxAt(BEFORE));
    await executor.invoke('tasks.create', { text: '如果這個月餐飲支出超過5000就提醒我' }, ctxAt(BEFORE));
    await tasks.runDue(T('2026-10-23T05:00:00Z'));
    await tasks.runDue(T('2026-10-23T11:00:00Z'));
    await tasks.runDue(T('2026-10-23T17:00:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ title: 'Sir，本月支出已超過 3,000' });
    expect(analytics).toHaveBeenCalled();
    const list = await tasks.list('owner');
    expect(list.find(t => t.condition?.category === '餐飲')!.runs[0].status).toBe('not_met');
  });

  it('a notification with no subscribed device is retried by later runs, not lost', async () => {
    const { tasks, executor, send } = setup({ sends: [none, accepted] });
    const id = (await executor.invoke('tasks.create', { text: '每天早上8點提醒我喝水' }, ctxAt(BEFORE)) as any).data.task.id;
    await tasks.runDue(T(DUE));
    expect((await tasks.get(id))!.runs[0].steps[0].delivery_status).toBe('retry_pending');
    await tasks.runDue(T('2026-10-23T00:07:00Z'));
    expect(send).toHaveBeenCalledTimes(2);
    expect((await tasks.get(id))!.runs[0].steps[0]).toMatchObject({ delivery_status: 'provider_accepted' });
  });

  it('refuses steps that would let a task manage tasks, and tasks of other users', async () => {
    const { executor } = setup();
    expect(await executor.invoke('tasks.create', { title: 'x', schedule: { type: 'daily', time: '08:00' }, steps: [{ type: 'tool', tool: 'tasks.update', input: {} }] }, ctxAt(BEFORE))).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    const id = (await executor.invoke('tasks.create', { text: '每天早上8點提醒我喝水' }, ctxAt(BEFORE)) as any).data.task.id;
    expect(await executor.invoke('tasks.update', { id, action: 'cancel' }, { userId: 'someone-else', now: () => T(BEFORE) })).toMatchObject({ status: 'error' });
    expect(await executor.invoke('tasks.history.get', { id }, { userId: 'someone-else', now: () => T(BEFORE) })).toMatchObject({ status: 'error', code: 'NOT_FOUND' });
  });
});

describe('tasks from the chat with zero model calls', () => {
  const env = { ...process.env };
  beforeEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { process.env = { ...env }; });

  it('routes recurring requests and "my tasks" locally; one-off reminders keep their own path', async () => {
    expect(classify('每天早上8點提醒我喝水')).toEqual({ kind: 'task_create', text: '每天早上8點提醒我喝水' });
    expect(classify('兩分鐘後提醒我看電腦')).toMatchObject({ kind: 'reminder_create' });
    expect(classify('我的任務')).toEqual({ kind: 'task_list' });

    const { hub, agenda } = chatHub();
    const tasks = new TaskService({ store: agenda, vault, executor: hub.executor, proposals: new MemoryHubStore(), notify: async () => ({ status: 'pending' }), briefing: async () => ({ title: '', body: '' }) });
    taskTools({ tasks, hasTool: n => Boolean(hub.registry.get(n)) }).forEach(t => hub.registry.register(t));
    const { client, requests } = fakeOpenAI();
    const clients = { openai: () => client };

    const made = await handleChat(hub, ctxAt(BEFORE), { style: 'professional', history: [], text: '每天早上8點提醒我喝水', clients });
    expect(made).toMatchObject({ ok: true, provider: 'local', route: { level: 'L1', intent: 'task_create' } });
    expect(made.ok && made.reply).toContain('每天 08:00：喝水');
    expect(made.ok && made.events[0].tool).toBe('tasks.create');

    const bad = await handleChat(hub, ctxAt(BEFORE), { style: 'professional', history: [], text: '每天提醒我喝水', clients });
    expect(bad.ok && bad.reply).toContain('這次沒有建立任何任務');

    const list = await handleChat(hub, ctxAt(BEFORE), { style: 'professional', history: [], text: '我的任務', clients });
    expect(list.ok && list.reply).toContain('目前有 1 個自動任務');
    expect(requests).toHaveLength(0);
    expect(await tasks.list('owner')).toHaveLength(1);
  });
});
