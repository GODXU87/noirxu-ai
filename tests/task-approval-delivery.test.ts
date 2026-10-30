import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryAgendaStore } from '@/agenda/store';
import { MemoryHubStore } from '@/hub/store';
import { Executor } from '@/hub/executor';
import { ToolRegistry, defineTool } from '@/hub/registry';
import { DeliveryService } from '@/notify/delivery';
import { TaskService, type TaskDeps } from '@/tasks/service';
import { vault } from './helpers/chat-hub';
const now = new Date('2026-10-30T00:00:00Z');
const later = (minutes: number) => new Date(+now + minutes * 60000);
function fixture() {
  const store = new MemoryAgendaStore();
  const proposals = new MemoryHubStore();
  const registry = new ToolRegistry();
  const write = vi.fn(async () => ({ data: { title: '已建立測試紀錄' } }));
  registry.register(defineTool({ name: 'sample.create', connection: 'internal', description: '', kind: 'write', input: z.object({}), output: z.unknown(), preview: async () => ({ title: '私人支出 15000', fields: [] }), run: write }));
  const executor = new Executor({ registry, store: proposals, isConnected: async () => true });
  let subscribed = false;
  const send = vi.fn(async () => subscribed ? { sent: 1, failed: 0, noSubscription: false, devices: [] } : { sent: 0, failed: 0, noSubscription: true, devices: [] });
  const delivery = new DeliveryService(store, vault, send);
  const deps: TaskDeps = { store, vault, executor, proposals, briefing: vi.fn(),
    notify: async ({ key, userId, message, now, expiresAt }) => delivery.deliver({ key, kind: 'task', userId, message, now, expiresAt: expiresAt ?? later(720) }),
    redeliver: async (key, at) => { const d = await delivery.get(key); return d ? (await delivery.deliver({ key, kind: d.kind, userId: d.user_id, message: d.message, now: at, expiresAt: new Date(d.expires_at) })).status : null; }
  };
  const tasks = new TaskService(deps);
  const create = () => tasks.create({ userId: 'owner', title: '私人房租', kind: 'background', schedule: { type: 'once', at: now.toISOString() }, steps: [{ type: 'tool', tool: 'sample.create', input: {} }], now });
  return { store, proposals, executor, deps, tasks, create, delivery, send, write, subscribe: () => { subscribed = true; } };
}
describe('durable approval notifications', () => {
  it('persists waiting before sending and never fails the task when notification storage throws', async () => {
    const f = fixture(); const t = await f.create();
    f.deps.notify = async () => { expect((await f.tasks.get(t.id))?.status).toBe('waiting_approval'); throw new Error('notification storage offline'); };
    await f.tasks.runDue(now);
    const stored = (await f.tasks.get(t.id))!;
    expect(stored.status).toBe('waiting_approval');
    expect(stored.last_error).toBeUndefined();
    expect(stored.runs[0].steps[0]).toMatchObject({ status: 'waiting_approval', delivery_key: `task-approval:${stored.waiting_proposal}`, delivery_status: 'pending' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('recovers a never-created delivery after restart without replaying the write proposal', async () => {
    const f = fixture(); const t = await f.create(); const notify = f.deps.notify;
    f.deps.notify = async () => { throw new Error('offline before delivery exists'); };
    await f.tasks.runDue(now); const before = (await f.tasks.get(t.id))!;
    f.deps.notify = notify; f.subscribe();
    await new TaskService(f.deps).runDue(later(1));
    const after = (await f.tasks.get(t.id))!;
    expect(after.waiting_proposal).toBe(before.waiting_proposal);
    expect(after.runs[0].steps[0].delivery_status).toBe('provider_accepted');
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.write).not.toHaveBeenCalled();
  });
  it('retries no-device delivery once across concurrent ticks without leaking proposal content', async () => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    const before = (await f.tasks.get(t.id))!;
    f.subscribe(); await Promise.all(Array.from({ length: 5 }, () => new TaskService(f.deps).runDue(later(6))));
    const after = (await f.tasks.get(t.id))!;
    expect(after.runs[0].steps[0].delivery_status).toBe('provider_accepted');
    expect(after.runs[0].steps[0].summary).toBe('私人支出 15000');
    expect(f.send).toHaveBeenCalledTimes(2);
    const d = await f.delivery.get(`task-approval:${before.waiting_proposal}`);
    expect(JSON.stringify(d?.message)).not.toMatch(/私人|15000/);
  });
  it('cancel revokes the outstanding proposal so old confirm links cannot execute it', async () => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    const before = (await f.tasks.get(t.id))!;
    await f.tasks.control('owner', t.id, 'cancel', later(1));
    await f.executor.confirm(before.waiting_proposal!, { userId: 'owner', now: () => later(2) }).catch(() => {});
    expect(f.write).not.toHaveBeenCalled();
  });
  it('retains a proposal created during cancellation when revocation fails, then revokes on next tick', async () => {
    const f = fixture(); const t = await f.create();
    const invoke = f.executor.invoke.bind(f.executor);
    vi.spyOn(f.executor, 'invoke').mockImplementationOnce(async (...args) => {
      await f.tasks.control('owner', t.id, 'cancel', now);
      return invoke(...args);
    });
    vi.spyOn(f.executor, 'reject').mockRejectedValueOnce(new Error('transient revoke failure'));
    await f.tasks.runDue(now).catch(() => {});
    await f.tasks.runDue(later(1));
    const stored = (await f.tasks.get(t.id))!;
    const proposalId = stored.runs[0].steps[0]?.proposal_id;
    expect(proposalId).toBeTruthy();
    expect((await f.proposals.getProposal(proposalId!))?.status).toBe('rejected');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('provides only the owner an active approval preview, not raw input', async () => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    expect(await f.tasks.approval('intruder', t.id, now)).toBeNull();
    expect(await f.tasks.approval('owner', t.id, now)).toMatchObject({ status: 'confirmation_required', preview: { title: '私人支出 15000' } });
    expect(await f.tasks.approval('owner', t.id, later(1440))).toBeNull();
  });
  it('resuming a paused approval keeps the same proposal and does not mark unapproved work complete', async () => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    const before = (await f.tasks.get(t.id))!;
    await f.tasks.control('owner', t.id, 'pause', later(1));
    f.subscribe(); await f.tasks.runDue(later(6)); expect(f.send).toHaveBeenCalledTimes(1);
    await f.tasks.control('owner', t.id, 'resume', later(7));
    await f.tasks.runDue(later(7));
    expect((await f.tasks.get(t.id))!).toMatchObject({ status: 'waiting_approval', waiting_proposal: before.waiting_proposal });
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.write).not.toHaveBeenCalled();
  });
  it('keeps the confirmed operation failure reason without replaying writes', async () => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    const before = (await f.tasks.get(t.id))!;
    f.write.mockRejectedValueOnce(new Error('保存服務暫時無法使用'));
    await f.executor.confirm(before.waiting_proposal!, { userId: 'owner', now: () => later(1) });
    const proposal = await f.proposals.getProposal(before.waiting_proposal!);
    await Promise.all([f.tasks.runDue(later(6)), f.tasks.runDue(later(6))]);
    expect((await f.tasks.get(t.id))!.last_error).toBe(proposal!.error!.message);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'expire', 'confirm'] as const)('does not retry an obsolete approval notification after %s', async action => {
    const f = fixture(); const t = await f.create(); await f.tasks.runDue(now);
    const waiting = (await f.tasks.get(t.id))!;
    if (action === 'cancel') await f.tasks.control('owner', t.id, 'cancel', later(1));
    if (action === 'confirm') await f.executor.confirm(waiting.waiting_proposal!, { userId: 'owner', now: () => later(1) });
    f.subscribe(); await f.tasks.runDue(action === 'expire' ? later(1440) : later(6));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.tasks.get(t.id))!.pending_delivery_keys).not.toContain(`task-approval:${waiting.waiting_proposal}`);
    expect(f.write).toHaveBeenCalledTimes(action === 'confirm' ? 1 : 0);
    if (action === 'confirm') expect((await f.tasks.get(t.id))!.runs[0].steps[0].summary).toBe('已建立測試紀錄');
  });
});
