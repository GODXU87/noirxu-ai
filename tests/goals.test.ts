import { describe, expect, it } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { DeliveryService } from '@/notify/delivery';
import { ProactiveNotifier } from '@/notify/policy';
import { GoalService } from '@/goals/service';
import { goalView } from '@/goals/model';
import { vault } from './helpers/chat-hub';

const now = new Date('2026-10-30T02:00:00Z');
const due = new Date('2026-10-31T02:00:00Z');
const input = { request_id: '00000000-0000-4000-8000-000000000001', title: '教學演示', next_step: '完成教案初稿', deadline: due.toISOString() };
function setup() {
  const store = new MemoryAgendaStore();
  const sent: string[] = [];
  let offline = false;
  const delivery = new DeliveryService(store, vault, async (_user, message) => {
    if (offline) throw new Error('offline');
    sent.push(message.body);
    return { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'test', platform: 'test', outcome: 'accepted' as const, retryable: false }] };
  });
  const notifier = new ProactiveNotifier(store, vault, delivery);
  const build = () => new GoalService({ store, vault, notify: p => notifier.notify({ ...p, kind: 'goal', priority: 'normal' }), delivery });
  return { store, sent, delivery, goals: build(), restart: build, offline: (v: boolean) => { offline = v; } };
}

describe('durable goal lifecycle', () => {
  it('keeps the basis of current progress after recent-history retention trims older events', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    let g = await s.goals.update('owner', a.id, 1, { progress: 30, evidence: '第一節完成' }, now);
    for (let i = 0; i < 51; i++) g = await s.goals.update('owner', a.id, g.revision, { next_step: `下一步 ${i}` }, now);
    expect(g.history).toHaveLength(50); expect(g.history_total).toBe(53);
    expect(goalView(g).latest_evidence).toBe('第一節完成');
  });

  it('bounds push payloads while retaining the full completion result and evidence', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    const done = await s.goals.update('owner', a.id, 1, { status: 'completed', evidence: '證'.repeat(1000), result: '果'.repeat(1000) }, now);
    expect(Buffer.byteLength(JSON.stringify(done.notifications[0].message), 'utf8')).toBeLessThan(3000);
    expect(done.notifications[0].message.url).toContain(`/tasks?goal=${done.id}`);
    expect(done.completion?.result).toHaveLength(1000); expect(done.completion?.evidence).toHaveLength(1000);
  });

  it('persists encrypted state across service restart; duplicate requests return the same goal', async () => {
    const s = setup();
    const a = await s.goals.create('owner', input, now);
    const duplicate = await s.restart().create('owner', input, now);
    expect(duplicate.id).toBe(a.id);
    expect(await s.restart().list('owner')).toMatchObject([{ title: '教學演示', status: 'active', progress: 0, next_step: '完成教案初稿', deadline: due.toISOString(), check_at: due.toISOString() }]);
    expect([...s.store.settings.values()].join('')).not.toContain('教學演示');
    expect(await s.goals.list('other')).toEqual([]);
    await expect(s.goals.get('other', a.id)).rejects.toThrow('找不到');
    await expect(s.goals.update('other', a.id, 1, { title: 'stolen' }, now)).rejects.toThrow('找不到');
  });

  it('requires progress evidence and preserves the winning correction when edits race', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    await expect(s.goals.update('owner', a.id, 1, { progress: 30 }, now)).rejects.toThrow('依據');
    const results = await Promise.allSettled([
      s.goals.update('owner', a.id, 1, { progress: 30, evidence: '使用者回報：第一節已寫完', next_step: '補第二節' }, now),
      s.goals.update('owner', a.id, 1, { next_step: '先找教材' }, now)
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const latest = await s.goals.get('owner', a.id);
    expect(latest.revision).toBe(2);
    await expect(s.goals.update('owner', a.id, 1, { next_step: '舊答案' }, now)).rejects.toThrow('版本');
  });

  it('requires completion result and evidence, records user-reported provenance, and stops tracking', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    await expect(s.goals.update('owner', a.id, 1, { status: 'completed', result: '完成' }, now)).rejects.toThrow('依據');
    const done = await s.goals.update('owner', a.id, 1, { status: 'completed', result: '教案已交付', evidence: '使用者回報已提交教案 PDF' }, now);
    expect(done).toMatchObject({ status: 'completed', progress: 100, next_step: null, check_at: null, completion: { result: '教案已交付', evidence: '使用者回報已提交教案 PDF', source: 'user_report' } });
    await s.restart().runDue('owner', new Date(now.getTime() + 60000));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('使用者回報');
    expect(s.sent[0]).toContain('教案已交付');
    await s.goals.runDue('owner', new Date(due.getTime() + 86400000));
    expect(s.sent).toHaveLength(1);
    await expect(s.goals.update('owner', a.id, 2, { status: 'active' }, due)).rejects.toThrow('結束');
    expect(await s.goals.list('owner')).toEqual([]);
    expect(await s.goals.list('owner', true)).toHaveLength(1);
  });

  it('creates one check-in under overlapping ticks, without pretending any work or completion happened', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    await Promise.all(Array.from({ length: 5 }, () => s.goals.runDue('owner', due)));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('完成教案初稿');
    const current = await s.goals.get('owner', a.id);
    expect(current).toMatchObject({ status: 'active', progress: 0, check_at: null });
    expect(current.notifications).toHaveLength(1);
    expect(current.notifications[0].status).toBe('provider_accepted');
    expect(current.notifications[0].displayed_at).toBeUndefined();
    await s.goals.runDue('owner', new Date(due.getTime() + 86400000));
    expect(s.sent).toHaveLength(1);
  });

  it('keeps delivery failures separate from completion and retries after restart with the same key', async () => {
    const s = setup(); s.offline(true); const a = await s.goals.create('owner', input, now);
    await s.goals.update('owner', a.id, 1, { status: 'completed', result: '交付完成', evidence: '本人確認交付' }, now);
    await s.goals.runDue('owner', now);
    const pending = await s.goals.get('owner', a.id);
    expect(pending.status).toBe('completed');
    expect(pending.notifications[0].status).toBe('retry_pending');
    s.offline(false);
    await s.restart().runDue('owner', new Date(now.getTime() + 6 * 60000));
    const recovered = await s.goals.get('owner', a.id);
    expect(recovered.notifications[0].key).toBe(pending.notifications[0].key);
    expect(recovered.notifications[0].status).toBe('provider_accepted');
    expect(s.sent).toHaveLength(1);
  });

  it('honors quiet-hour policy and retains the result in the inbox', async () => {
    const s = setup(); const a = await s.goals.create('owner', input, now);
    const quiet = new Date('2026-10-30T16:00:00Z');
    await s.goals.update('owner', a.id, 1, { status: 'completed', result: '完成', evidence: '本人確認' }, quiet);
    await s.goals.runDue('owner', quiet);
    const done = await s.goals.get('owner', a.id);
    expect(done.notifications[0].status).toBe('held');
    expect(s.sent).toEqual([]);
    expect((await s.delivery.inbox('owner')).map(x => x.body).join('')).toContain('本人確認');
  });

  it('pause/cancel stop check-ins, including pending stale delivery retries', async () => {
    const s = setup(); s.offline(true); const a = await s.goals.create('owner', input, now);
    await s.goals.runDue('owner', due);
    const current = await s.goals.get('owner', a.id);
    await s.goals.update('owner', a.id, current.revision, { status: 'cancelled' }, due);
    s.offline(false);
    await s.goals.runDue('owner', new Date(due.getTime() + 600000));
    expect(s.sent).toEqual([]);
    expect((await s.goals.get('owner', a.id)).notifications[0].status).toBe('superseded');
    const b = await s.goals.create('owner', { ...input, request_id: '00000000-0000-4000-8000-000000000002' }, now);
    await s.goals.update('owner', b.id, 1, { status: 'paused' }, now);
    await s.goals.runDue('owner', due);
    expect(s.sent).toEqual([]);
  });

  it('refuses invalid state, missing next step, invalid date and full progress without completion', async () => {
    const s = setup();
    await expect(s.goals.create('owner', { ...input, next_step: '' }, now)).rejects.toThrow();
    await expect(s.goals.create('owner', { ...input, deadline: 'tomorrow' }, now)).rejects.toThrow();
    await expect(s.goals.create('owner', { ...input, deadline: '2026-02-30T18:00:00Z' }, now)).rejects.toThrow();
    await expect(s.goals.create('owner', { ...input, check_at: '2026-13-01T18:00:00Z' }, now)).rejects.toThrow();
    const a = await s.goals.create('owner', input, now);
    await expect(s.goals.update('owner', a.id, 1, { progress: 100, evidence: 'guess' }, now)).rejects.toThrow();
    await expect(s.goals.update('owner', a.id, 1, { status: 'blocked' }, now)).rejects.toThrow('阻礙');
    await expect(s.goals.update('owner', a.id, 1, { deadline: '2026-02-30T18:00:00Z' }, now)).rejects.toThrow();
    await expect(s.goals.update('owner', a.id, 1, { check_at: '' }, now)).rejects.toThrow();
  });
});
