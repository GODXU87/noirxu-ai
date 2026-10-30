import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { GoalService } from '@/goals/service';
import { goalTools } from '@/tools/goals/tools';
import { selectTools } from '@/router/tier';
import { taskTools } from '@/tools/tasks/tools';
import { TaskService } from '@/tasks/service';
import { vault } from './helpers/chat-hub';
vi.mock('server-only', () => ({}));
const { runTick, tickHealthy } = await import('@/server/tick');
const { systemPrompt } = await import('@/server/agent');
const ctx = { userId: 'owner', now: () => new Date('2026-10-30T02:00:00Z') };
const create = { request_id: '00000000-0000-4000-8000-000000000001', title: '教案', next_step: '備課', deadline: '2026-11-10T02:00:00Z' };
function setup() {
  const agenda = new MemoryAgendaStore(); const registry = new ToolRegistry(); const store = new MemoryHubStore();
  const delivery = { get: async (): Promise<null> => null };
  const goals = new GoalService({ store: agenda, vault, notify: async () => { throw new Error('transport down'); }, delivery });
  goalTools(goals).forEach(t => registry.register(t));
  const executor = new Executor({ registry, store, isConnected: async () => false });
  return { agenda, registry, goals, executor, store, delivery };
}

describe('goal executor integration', () => {
  it('returns committed completion even when the subsequent receipt read fails', async () => {
    const s = setup(); const made = await s.goals.create('owner', create, ctx.now());
    vi.spyOn(s.delivery, 'get').mockRejectedValue(new Error('receipt store unavailable'));
    const result = await s.executor.invoke('goals.update', { id: made.id, revision: 1, status: 'completed', evidence: '本人確認', result: '教案交付' }, ctx);
    expect(result).toMatchObject({ status: 'ok', data: { goal: { status: 'completed', completion: { result: '教案交付' } }, notification_error: expect.any(String) } });
  });

  it('creates and completes through the real executor while leaving uncertain delivery explicitly pending', async () => {
    const s = setup();
    const made = await s.executor.invoke('goals.create', create, ctx);
    expect(made.status).toBe('ok'); if (made.status !== 'ok') return;
    const goal = (made.data as any).goal;
    expect(goal).toMatchObject({ title: '教案', next_step: '備課', progress: 0 });
    expect(goal.user_id).toBeUndefined(); expect(goal.request_fingerprint).toBeUndefined();
    const invalid = await s.executor.invoke('goals.update', { id: goal.id, revision: 1, status: 'completed' }, ctx);
    expect(invalid.status).toBe('error');
    const done = await s.executor.invoke('goals.update', { id: goal.id, revision: 1, status: 'completed', evidence: '本人確認交付', result: '交付教案' }, ctx);
    expect(done).toMatchObject({ status: 'ok', data: { goal: { status: 'completed', completion: { source: 'user_report' }, notifications: [{ status: 'pending' }] } } });
    const history = await s.executor.invoke('goals.history.get', { id: goal.id }, ctx);
    expect(history).toMatchObject({ status: 'ok', data: { total: 2, events: expect.arrayContaining([expect.objectContaining({ evidence: '本人確認交付' })]) } });
    expect(await s.executor.invoke('goals.history.get', { id: goal.id }, { ...ctx, userId: 'other' })).toMatchObject({ status: 'error' });
  });

  it('selects goal tools even when a short goal request also matches another domain', () => {
    const { registry } = setup();
    for (const text of ['更新今天的教案目標進度', '期限改到明天', '先暫停這個任務']) expect(selectTools(registry, text, 'L2').get('goals.update')).toBeDefined();
    expect(systemPrompt(registry, '2026-10-30')).toContain('goals.create');
  });

  it('refuses scheduled goal mutation, so a timer cannot invent user-reported completion', async () => {
    const s = setup();
    const tasks = new TaskService({ store: s.agenda, vault, executor: s.executor, proposals: s.store, notify: vi.fn(), briefing: vi.fn() });
    taskTools({ tasks, hasTool: n => Boolean(s.registry.get(n)) }).forEach(t => s.registry.register(t));
    const result = await s.executor.invoke('tasks.create', { title: 'unsafe', schedule: { type: 'daily', time: '09:00' }, steps: [{ type: 'tool', tool: 'goals.update', input: { status: 'completed' } }] }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect(await tasks.list('owner')).toEqual([]);
  });
});

describe('goal scheduler integration', () => {
  function hub(goals: unknown, halted = false) {
    return { agenda: new MemoryAgendaStore(), vault, goals, features: { briefings: false }, delivery: { get: async () => null }, tasks: { runDue: async () => ({ ran: 0, waiting: 0, halted }), halted: async () => ({ halted }) } } as any;
  }
  it('runs the durable goal lifecycle from the existing tick and exposes subsystem errors', async () => {
    const s = setup(); await s.goals.create('owner', { ...create, deadline: ctx.now().toISOString() }, ctx.now());
    const result = await runTick(hub(s.goals), ctx.now());
    expect(result.goals).toMatchObject({ checked: 1 });
    expect((await s.goals.list('owner'))[0].check_at).toBeNull();
    const failed = await runTick(hub({ runDue: async () => { throw new Error('goal store unavailable'); } }), ctx.now());
    expect(failed.goals?.error).toContain('goal store unavailable'); expect(tickHealthy(failed)).toBe(false);
  });
  it('honors the existing emergency halt before checking or delivering goals', async () => {
    const s = setup(); await s.goals.create('owner', { ...create, deadline: ctx.now().toISOString() }, ctx.now());
    const result = await runTick(hub(s.goals, true), ctx.now());
    expect(result.goals).toMatchObject({ halted: true, checked: 0 });
    expect((await s.goals.list('owner'))[0].check_at).toBe(ctx.now().toISOString());
  });
});
