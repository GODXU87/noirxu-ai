import { DeliveryService } from '@/notify/delivery';
import { describe, expect, it, vi } from 'vitest';
import { parseCommand } from '@/assistant/commands';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { WaterService } from '@/health/service';
import { DEFAULT_WATER_PREFS, dueWaterSlot, expectedByNow, parseWaterCommand, waterReminder, waterSlots } from '@/health/water';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { healthTools } from '@/tools/health/tools';

vi.mock('server-only', () => ({}));
const testVault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const ACCEPTED = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const { runTick } = await import('@/server/tick');

const at = (taipei: string) => new Date(`${taipei}+08:00`);
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');

describe('water command parsing', () => {
  it('reads amounts, cups, goals and on/off', () => {
    expect(parseCommand('/喝水 300')).toMatchObject({ name: 'water', arg: '300' });
    expect(parseWaterCommand('')).toEqual({ action: 'status' });
    expect(parseWaterCommand('300')).toEqual({ action: 'log', ml: 300 });
    expect(parseWaterCommand('350ml')).toEqual({ action: 'log', ml: 350 });
    expect(parseWaterCommand('0.5L')).toEqual({ action: 'log', ml: 500 });
    expect(parseWaterCommand('一杯')).toEqual({ action: 'log', ml: 250, assumed: '以一杯 250 ml 計算' });
    expect(parseWaterCommand('目標 2500')).toEqual({ action: 'goal', ml: 2500 });
    expect(parseWaterCommand('關閉')).toEqual({ action: 'disable' });
    expect(parseWaterCommand('開啟')).toEqual({ action: 'enable' });
    expect(parseWaterCommand('復原')).toEqual({ action: 'undo' });
  });

  it('rejects amounts outside sensible limits instead of guessing', () => {
    expect(parseWaterCommand('5').action).toBe('invalid');
    expect(parseWaterCommand('9000').action).toBe('invalid');
    expect(parseWaterCommand('目標 100').action).toBe('invalid');
    expect(parseWaterCommand('很多').action).toBe('invalid');
  });
});

describe('water pace and reminders', () => {
  const prefs = DEFAULT_WATER_PREFS;

  it('spreads the goal across the reminder window (Asia/Taipei)', () => {
    expect(expectedByNow(prefs, at('2026-10-22T08:00:00'))).toBe(0);
    expect(expectedByNow(prefs, at('2026-10-22T15:00:00'))).toBe(1000);
    expect(expectedByNow(prefs, at('2026-10-22T22:00:00'))).toBe(2000);
  });

  it('has reminder slots every 2 hours from 09:00 to 21:00', () => {
    expect(waterSlots(prefs)).toEqual(['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00']);
    expect(dueWaterSlot(prefs, at('2026-10-22T13:20:00'))).toBe('13:00');
    expect(dueWaterSlot(prefs, at('2026-10-22T14:10:00'))).toBeNull();
    expect(dueWaterSlot({ ...prefs, enabled: false }, at('2026-10-22T13:20:00'))).toBeNull();
  });

  it('only reminds when behind pace', () => {
    const now = at('2026-10-22T15:00:00');
    expect(waterReminder(prefs, { date: '2026-10-22', total_ml: 1000, entries: [] }, now)).toBeNull();
    const behind = waterReminder(prefs, { date: '2026-10-22', total_ml: 300, entries: [] }, now);
    expect(behind?.body).toContain('300 / 2,000 ml');
    expect(behind?.body).toContain('1,000 ml');
  });
});

function setup(now: Date) {
  const agenda = new MemoryAgendaStore();
  const water = new WaterService(agenda, vault);
  const registry = new ToolRegistry();
  healthTools(water).forEach(tool => registry.register(tool));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => false });
  return { agenda, water, executor, ctx: { userId: 'owner', now: () => now } };
}

describe('water tools', () => {
  it('logs, undoes and reports progress without a confirmation card', async () => {
    const { executor, ctx, agenda } = setup(at('2026-10-22T15:00:00'));
    expect((await executor.invoke('health.water.log', { ml: 300 }, ctx)).status).toBe('ok');
    const second = await executor.invoke('health.water.log', { ml: 500 }, ctx) as any;
    expect(second.data).toMatchObject({ total_ml: 800, goal_ml: 2000, percent: 40, expected_ml: 1000, behind_ml: 200 });
    const undone = await executor.invoke('health.water.undo', {}, ctx) as any;
    expect(undone.data).toMatchObject({ total_ml: 300, removed_ml: 500 });
    // Stored encrypted, not as plain JSON.
    expect([...agenda.settings.values()].some(v => v.includes('total_ml'))).toBe(false);
  });

  it('keeps each day separate and validates settings', async () => {
    const day1 = setup(at('2026-10-22T20:00:00'));
    await day1.executor.invoke('health.water.log', { ml: 1500 }, day1.ctx);
    const next = { ...day1.ctx, now: () => at('2026-10-23T09:30:00') };
    expect(((await day1.executor.invoke('health.water.status', {}, next)) as any).data.total_ml).toBe(0);
    const set = await day1.executor.invoke('health.water.settings', { goal_ml: 2500, interval_hours: 3 }, next) as any;
    expect(set.data.prefs).toMatchObject({ goal_ml: 2500, interval_hours: 3, enabled: true });
    expect((await day1.executor.invoke('health.water.settings', { start: '21:00', end: '09:00' }, next)).status).toBe('error');
    expect((await day1.executor.invoke('health.water.log', { ml: 99999 }, next)).status).toBe('error');
  });
});

describe('water reminders in the scheduler', () => {
  function hubWith(now: Date) {
    const { agenda, water } = setup(now);
    const sent: any[] = [];
    const hub: any = {
      agenda, water, features: { water: true },
      push: { send: vi.fn(async (_u: string, m: any) => { sent.push(m); return ACCEPTED; }) },
      isConnected: async () => false,
      executor: { invoke: vi.fn() }
    };
    hub.vault = testVault;
    hub.delivery = new DeliveryService(agenda, testVault, (u: string, m: any, n: Date) => hub.push.send(u, m, n));
    return { hub, sent, water };
  }

  it('sends one reminder per slot when behind pace', async () => {
    const now = at('2026-10-22T13:05:00');
    const { hub, sent } = hubWith(now);
    await runTick(hub, now);
    await runTick(hub, new Date(now.getTime() + 10 * 60_000));
    expect(sent.filter(m => m.title === '該喝水了')).toHaveLength(1);
  });

  it('stays quiet when on pace, when switched off, or outside the window', async () => {
    const now = at('2026-10-22T13:05:00');
    const onPace = hubWith(now);
    await onPace.water.log('owner', '2026-10-22', 900, now);
    await runTick(onPace.hub, now);
    expect(onPace.sent).toHaveLength(0);

    const off = hubWith(now);
    await off.water.updatePrefs('owner', { enabled: false });
    await runTick(off.hub, now);
    expect(off.sent).toHaveLength(0);

    const late = hubWith(at('2026-10-22T23:30:00'));
    await runTick(late.hub, at('2026-10-22T23:30:00'));
    expect(late.sent).toHaveLength(0);
  });
});
