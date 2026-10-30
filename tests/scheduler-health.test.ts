import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { DeliveryService } from '@/notify/delivery';
import type { Hub } from '@/server/hub';

vi.mock('server-only', () => ({}));
let hub: Hub;
vi.mock('@/server/hub', () => ({ getHub: () => hub }));
vi.mock('@/server/http', async importOriginal => ({ ...await importOriginal<typeof import('@/server/http')>(), requireContext: async () => ({ userId: 'owner', now: () => new Date() }) }));
vi.mock('@/server/github-oidc', () => ({ verifyGithubScheduler: async () => true }));
const { recordTick, lastTick } = await import('@/server/tick');
const { GET: status } = await import('@/app/api/push/status/route');
const { POST: cron } = await import('@/app/api/cron/tick/route');
const { POST: catchup } = await import('@/app/api/cron/catchup/route');
const at = new Date('2026-10-30T04:00:00Z');
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const request = () => new Request('https://example.test/api/cron/tick', { method: 'POST' });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  const agenda = new MemoryAgendaStore();
  hub = {
    agenda, vault, features: { briefings: false },
    push: { devices: async () => [], publicKey: async () => null },
    delivery: new DeliveryService(agenda, vault, async () => ({ sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'test', outcome: 'accepted', retryable: false }] })),
    tasks: { runDue: async () => ({ ran: 0, waiting: 0 }) }
  } as unknown as Hub;
});
afterEach(() => vi.useRealTimers());

describe('external scheduler health', () => {
  it('fresh app catchup does not hide stale external scheduling', async () => {
    await recordTick(hub, { at: new Date(at.getTime() - 30 * 60_000).toISOString(), source: 'github-actions', ok: true });
    expect((await catchup(request())).status).toBe(200);
    const body = await (await status(new Request('https://example.test/api/push/status'))).json();
    expect(body.scheduler).toMatchObject({ healthy: false, age_minutes: 30, last: { source: 'github-actions' } });
    expect(body.catchup).toMatchObject({ healthy: true, last: { source: 'app-catchup' } });
    expect((await lastTick(hub))?.source).toBe('app-catchup');
  });

  it('a legacy app-only record is not proof of an external scheduler', async () => {
    await hub.agenda.putSetting('tick:last', vault.seal(JSON.stringify({ at: at.toISOString(), source: 'app-catchup', ok: true }), 'tick:last'));
    const body = await (await status(new Request('https://example.test/api/push/status'))).json();
    expect(body.scheduler).toMatchObject({ healthy: false, last: null });
  });

  it('task exceptions degrade cron and diagnostics while due reminders still complete', async () => {
    const agenda = hub.agenda as MemoryAgendaStore;
    agenda.items.set('i1', { id: 'i1', user_id: 'owner', title: 'test', notes: '', due_date: '2026-10-30', due_time: null, importance: 2, status: 'open', source: 'chat', created_at: at.toISOString(), updated_at: at.toISOString() });
    agenda.reminders.set('r1', { id: 'r1', item_id: 'i1', user_id: 'owner', remind_at: at.toISOString(), label: 'test', sent_at: null });
    hub.tasks!.runDue = async () => { throw new Error('task storage unavailable'); };
    const response = await cron(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reminders: 1, tasks: { error: 'task storage unavailable' } });
    expect(agenda.reminders.get('r1')?.sent_at).not.toBeNull();
    expect(await lastTick(hub)).toMatchObject({ ok: false });
    const body = await (await status(new Request('https://example.test/api/push/status'))).json();
    expect(body.scheduler.healthy).toBe(false);
    expect(body.task_subsystem).toMatchObject({ healthy: false, error: 'task storage unavailable' });
  });

  it('catchup task failures also return degraded, not successful', async () => {
    hub.tasks!.runDue = async () => { throw new Error('task storage unavailable'); };
    const response = await catchup(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, ran: true });
    expect(await lastTick(hub)).toMatchObject({ ok: false });
  });
  it('failed catchup is recorded without altering external evidence, including throttled responses', async () => {
    await recordTick(hub, { at: new Date(at.getTime() - 10 * 60_000).toISOString(), source: 'github-actions', ok: true });
    hub.agenda.dueReminders = async () => { throw new Error('agenda unavailable'); };
    expect((await catchup(request())).status).toBe(500);
    expect(await lastTick(hub)).toMatchObject({ source: 'app-catchup', ok: false, error: 'agenda unavailable' });
    const skipped = await catchup(request());
    expect(skipped.status).toBe(503);
    expect(await skipped.json()).toMatchObject({ ok: false, ran: false });
    const body = await (await status(new Request('https://example.test/api/push/status'))).json();
    expect(body.scheduler).toMatchObject({ healthy: true, last: { source: 'github-actions' } });
    expect(body.catchup.healthy).toBe(false);
    expect(body.task_subsystem.healthy).toBe(false);
  });

});
