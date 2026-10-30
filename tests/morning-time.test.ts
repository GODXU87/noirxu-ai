import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { DeliveryService } from '@/notify/delivery';

vi.mock('server-only', () => ({}));
const { runTick } = await import('@/server/tick');
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const ACCEPTED = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };

function hubWith(sleepSynced: boolean, garmin = true) {
  const agenda = new MemoryAgendaStore();
  const sent: any[] = [];
  const invoke = vi.fn(async (name: string) => (name === 'garmin.sleep.summary'
    ? { status: 'ok', tool: name, data: { duration_s: sleepSynced ? 26000 : null }, links: [] }
    : { status: 'error', tool: name, code: 'NOT_FOUND', message: '沒有資料' }));
  const hub: any = { agenda, vault, features: { briefings: true }, garmin: garmin ? {} : null, isConnected: async () => false, executor: { invoke } };
  hub.delivery = new DeliveryService(agenda, vault, async (_u: string, m: any) => { sent.push(m); return ACCEPTED as any; });
  return { hub, sent: () => sent.filter(m => m.tag?.startsWith('briefing-')) };
}
const at = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00+08:00`);

describe('morning briefing at 07:00', () => {
  it('goes out at 07:00 once Garmin has last night\'s sleep', async () => {
    const { hub, sent } = hubWith(true);
    await runTick(hub, at('06:59'));
    expect(sent()).toHaveLength(0);
    await runTick(hub, at('07:00'));
    expect(sent()).toHaveLength(1);
  });

  it('waits for the sleep sync, but no later than 07:45', async () => {
    const { hub, sent } = hubWith(false);
    await runTick(hub, at('07:05'));
    await runTick(hub, at('07:30'));
    expect(sent()).toHaveLength(0);
    await runTick(hub, at('07:45'));
    expect(sent()).toHaveLength(1);
  });

  it('does not wait without Garmin', async () => {
    const { hub, sent } = hubWith(false, false);
    await runTick(hub, at('07:01'));
    expect(sent()).toHaveLength(1);
  });
});
