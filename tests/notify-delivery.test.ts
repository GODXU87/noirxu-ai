import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { backoffMs, DeliveryService, MAX_ATTEMPTS } from '@/notify/delivery';
import { classifyPushError, platformOf, type SendReport } from '@/push/service';

vi.mock('server-only', () => ({}));
const { runTick } = await import('@/server/tick');

const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const accepted: SendReport = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const none: SendReport = { sent: 0, failed: 0, noSubscription: true, devices: [] };
const gone: SendReport = { sent: 0, failed: 1, noSubscription: false, devices: [{ device: 'd2', platform: 'Mac Safari', outcome: 'gone', retryable: false, error: '訂閱已失效' }] };
const msg = { title: '明天：繳電話費', body: '' };
const t0 = new Date('2026-10-21T12:05:00Z'); // 20:05 Taipei
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

function setup(results: Array<SendReport | Error>) {
  const store = new MemoryAgendaStore();
  const send = vi.fn(async () => { const r = results.length > 1 ? results.shift()! : results[0]; if (r instanceof Error) throw r; return r; });
  return { store, send, delivery: new DeliveryService(store, vault, send) };
}

const input = (now: Date) => ({ key: 'reminder:r1', kind: 'reminder', userId: 'owner', message: msg, expiresAt: later(12 * 60), now });

describe('notification delivery state machine', () => {
  it('keeps a notification for retry when no device is subscribed, and files it in the inbox', async () => {
    const { delivery, send } = setup([none, accepted]);
    const first = await delivery.deliver(input(t0));
    expect(first).toMatchObject({ status: 'retry_pending', attempts: 1, last_error: '沒有任何已訂閱通知的裝置' });
    expect((await delivery.inbox('owner')).map(e => e.key)).toEqual(['reminder:r1']);
    // Not before the backoff…
    expect((await delivery.deliver(input(later(2)))).status).toBe('retry_pending');
    expect(send).toHaveBeenCalledTimes(1);
    // …then delivered once a device exists, and never again.
    const second = await delivery.deliver(input(later(6)));
    expect(second).toMatchObject({ status: 'provider_accepted', attempts: 2 });
    await delivery.deliver(input(later(30)));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('records the provider error and retries after a thrown send', async () => {
    const { delivery } = setup([new Error('connect ETIMEDOUT'), accepted]);
    expect(await delivery.deliver(input(t0))).toMatchObject({ status: 'retry_pending', last_error: 'connect ETIMEDOUT' });
    expect((await delivery.deliver(input(later(6)))).status).toBe('provider_accepted');
  });

  it('keeps per-device reasons when every device rejects', async () => {
    const { delivery } = setup([gone]);
    const record = await delivery.deliver(input(t0));
    expect(record.status).toBe('retry_pending');
    expect(record.last_error).toContain('Mac Safari');
    expect(record.devices?.[0].outcome).toBe('gone');
  });

  it('sends only once when several scheduler runs overlap', async () => {
    const { delivery, send } = setup([accepted]);
    await Promise.all(Array.from({ length: 6 }, () => delivery.deliver(input(t0))));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await delivery.get('reminder:r1'))?.status).toBe('provider_accepted');
  });

  it('recovers a delivery whose run crashed mid-send once the lease runs out', async () => {
    const { delivery, store, send } = setup([accepted]);
    await delivery.deliver({ ...input(t0), message: msg });
    // Simulate a crashed run: force the record back to "sending" with an expired lease.
    const stuck = { ...(await delivery.get('reminder:r1'))!, status: 'sending', lease_until: later(1).toISOString() };
    store.settings.set('notify:reminder:r1', vault.seal(JSON.stringify(stuck), 'notify:reminder:r1'));
    expect((await delivery.deliver(input(later(0.5)))).status).toBe('sending');
    expect((await delivery.deliver(input(later(2)))).status).toBe('provider_accepted');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up after the maximum attempts and expires late notifications', async () => {
    const failing = setup([none]);
    let now = t0;
    let record = await failing.delivery.deliver({ ...input(now), expiresAt: later(10 * 24 * 60) });
    while (record.status === 'retry_pending') {
      now = new Date(Date.parse(record.next_retry_at!) + 1000);
      record = await failing.delivery.deliver({ ...input(now), expiresAt: later(10 * 24 * 60) });
    }
    expect(record).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

    const late = setup([none]);
    await late.delivery.deliver(input(t0));
    expect((await late.delivery.deliver(input(later(13 * 60)))).status).toBe('expired');
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(10)).toBe(2 * 60 * 60_000);
  });

  it('retries with the current message, not the first draft', async () => {
    const { delivery, send } = setup([none, accepted]);
    await delivery.deliver({ ...input(t0), message: { title: '該喝水了', body: '今天 0 ml' } });
    await delivery.deliver({ ...input(later(6)), message: { title: '該喝水了', body: '今天 300 ml' } });
    expect(send.mock.calls[1]).toEqual(['owner', { title: '該喝水了', body: '今天 300 ml' }, later(6)]);
  });

  it('marks inbox entries read', async () => {
    const { delivery } = setup([accepted]);
    await delivery.deliver(input(t0));
    await delivery.markRead('owner', 'all');
    expect((await delivery.inbox('owner'))[0].read).toBe(true);
  });
});

describe('scheduler with no subscribed device (the bug that lost reminders)', () => {
  it('does not mark a reminder done until a push service accepts it', async () => {
    const agenda = new MemoryAgendaStore();
    agenda.items.set('i1', { id: 'i1', user_id: 'owner', title: '繳電話費', notes: '', due_date: '2026-10-22', due_time: null, importance: 2, status: 'open', source: 'chat', created_at: t0.toISOString(), updated_at: t0.toISOString() });
    agenda.reminders.set('r1', { id: 'r1', item_id: 'i1', user_id: 'owner', remind_at: '2026-10-21T12:00:00Z', label: '明天', sent_at: null });
    const results: SendReport[] = [none, accepted];
    const push = { send: vi.fn(async (..._args: unknown[]) => results.length > 1 ? results.shift()! : results[0]) };
    const hub: any = { agenda, push, vault, isConnected: async () => false, executor: { invoke: vi.fn() } };
    hub.delivery = new DeliveryService(agenda, vault, (u: string, m: any, n: Date) => push.send(u, m, n));

    await runTick(hub, t0);
    expect(agenda.reminders.get('r1')?.sent_at).toBeNull();
    expect(agenda.log.has('reminder:r1')).toBe(false);

    const result = await runTick(hub, later(6));
    expect(result).toMatchObject({ reminders: 1, pushed: 1 });
    expect(agenda.reminders.get('r1')?.sent_at).not.toBeNull();
    expect(agenda.log.has('reminder:r1')).toBe(true);
    await runTick(hub, later(20));
    expect(push.send).toHaveBeenCalledTimes(2);
  });
});

describe('push error classification', () => {
  it('maps push service responses to actionable outcomes', () => {
    expect(classifyPushError({ statusCode: 410 })).toMatchObject({ outcome: 'gone', retryable: false });
    expect(classifyPushError({ statusCode: 403, body: 'BadJwtToken' })).toMatchObject({ outcome: 'vapid_mismatch' });
    expect(classifyPushError({ statusCode: 429 })).toMatchObject({ outcome: 'rate_limited', retryable: true });
    expect(classifyPushError({ statusCode: 503 })).toMatchObject({ outcome: 'provider_error', retryable: true });
    expect(classifyPushError(new Error('socket hang up'))).toMatchObject({ outcome: 'network_error', retryable: true });
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')).toBe('iPhone');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Mac Safari');
  });
});
