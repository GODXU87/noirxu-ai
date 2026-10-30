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

describe('task creation publication', () => {
  const input = { userId: 'owner', title: '喝水', kind: 'recurring' as const,
    schedule: { type: 'daily' as const, time: '08:00' }, steps: [{ type: 'notify' as const, title: '喝水' }], now: T(BEFORE) };

  it('fails visibly after index CAS exhaustion without an unlisted task, then retries safely after restart', async () => {
    const { tasks, agenda } = setup();
    const original = agenda.compareAndSetSetting.bind(agenda);
    let failures = 8;
    vi.spyOn(agenda, 'compareAndSetSetting').mockImplementation(async (key, expected, next) =>
      key === 'tasks:index' && failures-- > 0 ? false : original(key, expected, next));
    await expect(tasks.create(input)).rejects.toThrow('task index is busy');
    expect(await tasks.list('owner')).toEqual([]);
    expect([...agenda.settings.keys()].filter(key => key.startsWith('task:'))).toEqual([]);
    const restarted = new TaskService({ store: agenda, vault, executor: { invoke: vi.fn() }, proposals: { getProposal: vi.fn() }, notify: vi.fn(), briefing: vi.fn() });
    const created = await restarted.create(input);
    expect((await restarted.list('owner')).map(t => t.id)).toEqual([created.id]);
  });

  it('retries transient index contention and publishes a discoverable task exactly once', async () => {
    const { tasks, agenda } = setup();
    const original = agenda.compareAndSetSetting.bind(agenda);
    let failures = 7;
    vi.spyOn(agenda, 'compareAndSetSetting').mockImplementation(async (key, expected, next) =>
      key === 'tasks:index' && failures-- > 0 ? false : original(key, expected, next));
    const created = await tasks.create(input);
    expect((await tasks.list('owner')).map(t => t.id)).toEqual([created.id]);
  });

  it('does not claim success when the task record could not be persisted', async () => {
    const { tasks, agenda } = setup();
    const original = agenda.compareAndSetSetting.bind(agenda);
    vi.spyOn(agenda, 'compareAndSetSetting').mockImplementation(async (key, expected, next) =>
      key.startsWith('task:') ? false : original(key, expected, next));
    await expect(tasks.create(input)).rejects.toThrow('task could not be saved');
    expect(await tasks.list('owner')).toEqual([]);
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

  it('resumes remaining steps once across concurrent approval scans and a second approval', async () => {
    const { tasks, executor, expenseRun, send } = setup();
    const task = await tasks.create({ userId: 'owner', title: 'two approvals', kind: 'background', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, now: T(BEFORE), steps: [
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } },
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 2 } },
      { type: 'notify', title: 'done', body: '' }
    ] });
    await tasks.runDue(T(DUE));
    const first = (await tasks.get(task.id))!.waiting_proposal!;
    await executor.confirm(first, ctxAt(DUE));
    await Promise.all(Array.from({ length: 5 }, () => tasks.runDue(T('2026-10-23T00:01:00Z'))));
    const waiting = (await tasks.get(task.id))!;
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.waiting_proposal).not.toBe(first);
    expect(waiting.runs).toHaveLength(1);
    await executor.confirm(waiting.waiting_proposal!, ctxAt('2026-10-23T00:01:00Z'));
    await Promise.all(Array.from({ length: 5 }, () => tasks.runDue(T('2026-10-23T00:02:00Z'))));
    await tasks.runDue(T('2026-10-23T00:03:00Z'));
    const finished = (await tasks.get(task.id))!;
    expect(finished.status).toBe('completed');
    expect(finished.runs).toHaveLength(1);
    expect(finished.runs[0].steps.map(s => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(expenseRun).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(3); // two approval prompts and one completion
  });

  it('retries an old notification after a newer recurring slot and never resends accepted keys', async () => {
    const { tasks, send } = setup({ sends: [none, accepted] });
    const task = await tasks.create({ userId: 'owner', title: 'retry', kind: 'recurring', schedule: { type: 'interval', minutes: 30 }, now: T(BEFORE), steps: [{ type: 'notify', title: 'retry', body: '' }] });
    await tasks.runDue(T('2026-10-22T23:30:00Z'));
    const oldKey = (await tasks.get(task.id))!.runs[0].steps[0].delivery_key;
    await Promise.all(Array.from({ length: 3 }, () => tasks.runDue(T('2026-10-23T00:00:00Z'))));
    const latest = (await tasks.get(task.id))!;
    expect(latest.runs).toHaveLength(2);
    expect(latest.runs[1].steps[0]).toMatchObject({ delivery_key: oldKey, delivery_status: 'provider_accepted' });
    await tasks.runDue(T('2026-10-23T00:01:00Z'));
    expect(send).toHaveBeenCalledTimes(3); // old failure, new slot, old retry
  });

  it.each(['rejected', 'outcome_unknown', 'failed', 'expired', 'missing'] as const)('never resumes remaining steps for %s approval', async status => {
    const { tasks, executor, store, send } = setup();
    const task = await tasks.create({ userId: 'owner', title: 'blocked continuation', kind: 'background', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, now: T(BEFORE), steps: [
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } }, { type: 'notify', title: 'must not send', body: '' }
    ] });
    await tasks.runDue(T(DUE));
    const proposal = await store.getProposal((await tasks.get(task.id))!.waiting_proposal!);
    vi.spyOn(store, 'getProposal').mockResolvedValue(status === 'missing' ? null : { ...proposal!, ...(status === 'expired' ? { expiresAt: BEFORE } : { status }) });
    await tasks.runDue(T('2026-10-23T00:01:00Z'));
    expect((await tasks.get(task.id))!.runs[0].steps).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1); // approval request only
  });

  it('stops a resumed run before its next step when cancellation revokes its claim', async () => {
    const { tasks, executor, send, analytics } = setup();
    const task = await tasks.create({ userId: 'owner', title: 'cancel continuation', kind: 'background', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, now: T(BEFORE), steps: [
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } },
      { type: 'tool', tool: 'ledger.analytics.get', input: { month: '2026-10' } },
      { type: 'notify', title: 'must not send', body: '' }
    ] });
    await tasks.runDue(T(DUE));
    await executor.confirm((await tasks.get(task.id))!.waiting_proposal!, ctxAt(DUE));
    analytics.mockImplementationOnce(async () => {
      await tasks.control('owner', task.id, 'cancel', T(DUE));
      return { data: LEDGER_OCTOBER };
    });
    await tasks.runDue(T('2026-10-23T00:01:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await tasks.get(task.id))!.status).toBe('cancelled');
  });

  it.each(['invoke', 'approval-notify'] as const)('keeps cancellation terminal during resumed %s even if the new proposal is later approved', async phase => {
    const { tasks, executor, send } = setup();
    const task = await tasks.create({ userId: 'owner', title: 'cancel approval race', kind: 'background', schedule: { type: 'once', at: '2026-10-23T00:00:00Z' }, now: T(BEFORE), steps: [
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 1 } },
      { type: 'tool', tool: 'ledger.expense.create', input: { amount: 2 } },
      { type: 'notify', title: 'must not send', body: '' }
    ] });
    await tasks.runDue(T(DUE));
    await executor.confirm((await tasks.get(task.id))!.waiting_proposal!, ctxAt(DUE));
    let secondProposal: string | undefined;
    const invoke = executor.invoke.bind(executor);
    vi.spyOn(executor, 'invoke').mockImplementationOnce(async (...args) => {
      if (phase === 'invoke') await tasks.control('owner', task.id, 'cancel', T(DUE));
      const result = await invoke(...args);
      if (result.status === 'confirmation_required') secondProposal = result.proposalId;
      return result;
    });
    if (phase === 'approval-notify') send.mockImplementationOnce(async () => {
      await tasks.control('owner', task.id, 'cancel', T(DUE));
      return accepted;
    });
    await tasks.runDue(T('2026-10-23T00:01:00Z'));
    expect((await tasks.get(task.id))!).toMatchObject({ status: 'cancelled', next_at: null });
    expect((await tasks.get(task.id))!.waiting_proposal).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(phase === 'invoke' ? 1 : 2);
    expect(secondProposal).toBeTruthy();
    await expect(executor.confirm(secondProposal!, ctxAt('2026-10-23T00:02:00Z'))).rejects.toThrow('已取消');
    await tasks.runDue(T('2026-10-23T00:03:00Z'));
    expect((await tasks.get(task.id))!.status).toBe('cancelled');
    expect(send).toHaveBeenCalledTimes(phase === 'invoke' ? 1 : 2);
  });

  it('retains a pending delivery key beyond bounded history and retries it after trimming', async () => {
    const agenda = new MemoryAgendaStore();
    const statuses = new Map<string, string>();
    const tasks = new TaskService({ store: agenda, vault, executor: { invoke: async () => { throw new Error('not used'); } }, proposals: new MemoryHubStore(),
      notify: async ({ key }) => { statuses.set(key, 'retry_pending'); return { status: 'retry_pending' }; },
      briefing: async () => ({ title: '', body: '' }), redeliver: async key => statuses.get(key) ?? null });
    const task = await tasks.create({ userId: 'owner', title: 'history', kind: 'recurring', schedule: { type: 'interval', minutes: 30 }, now: T(BEFORE), steps: [{ type: 'notify', title: 'history', body: '' }] });
    for (let i = 1; i <= 21; i++) await tasks.runDue(new Date(T(BEFORE).getTime() + i * 30 * 60_000));
    const firstKey = [...statuses.keys()][0];
    const trimmed = (await tasks.get(task.id))!;
    expect(trimmed.runs).toHaveLength(20);
    expect(trimmed.pending_delivery_keys).toContain(firstKey);
    statuses.set(firstKey, 'provider_accepted');
    await tasks.runDue(new Date(T(BEFORE).getTime() + 21 * 30 * 60_000 + 60_000));
    expect((await tasks.get(task.id))!.pending_delivery_keys).not.toContain(firstKey);
  });

  it.each(['paused', 'cancelled'] as const)('bounds and rotates delivery retries for %s tasks; global halt suppresses them', async status => {
    const agenda = new MemoryAgendaStore();
    const visited: string[] = [];
    const tasks = new TaskService({ store: agenda, vault, executor: { invoke: async () => { throw new Error('not used'); } }, proposals: new MemoryHubStore(),
      notify: async () => ({ status: 'pending' }), briefing: async () => ({ title: '', body: '' }),
      redeliver: async key => { visited.push(key); return 'retry_pending'; } });
    const task = await tasks.create({ userId: 'owner', title: 'bounded queue', kind: 'recurring', schedule: { type: 'interval', minutes: 30 }, now: T(BEFORE), steps: [] });
    const k = `task:${task.id}`;
    agenda.settings.set(k, vault.seal(JSON.stringify({ ...task, status, pending_delivery_keys: Array.from({ length: 105 }, (_, i) => `key-${i}`) }), k));
    await tasks.runDue(T(DUE));
    expect(visited).toHaveLength(100);
    await tasks.runDue(T(DUE));
    expect(visited).toHaveLength(200);
    expect(visited.slice(100, 105)).toEqual(['key-100', 'key-101', 'key-102', 'key-103', 'key-104']);
    await tasks.setHalted(true, T(DUE));
    await tasks.runDue(T(DUE));
    expect(visited).toHaveLength(200);
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
