import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { WaterService } from '@/health/service';
import { DEFAULT_WATER_PREFS, dailyTarget, dueWaterSlot, parseWaterCommand, postExerciseReminder, suggestedBase, waterReminder, type WaterPrefs } from '@/health/water';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { healthTools } from '@/tools/health/tools';

vi.mock('server-only', () => ({}));
const { runTick } = await import('@/server/tick');

const at = (taipei: string) => new Date(`${taipei}+08:00`);
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const DAY = '2026-10-23'; // Friday
const prefs = (patch: Partial<WaterPrefs> = {}): WaterPrefs => ({ ...DEFAULT_WATER_PREFS, ...patch });
const day = (exercise?: any) => ({ date: DAY, total_ml: 0, entries: [], exercise });

describe('C4: personal starting point', () => {
  it('starts this owner at 2,500 ml (27 y, 74 kg, regular exercise), editable', () => {
    expect(DEFAULT_WATER_PREFS).toMatchObject({ goal_ml: 2500, profile: { age: 27, weight_kg: 74, regular_exercise: true } });
    expect(suggestedBase({ age: 27, weight_kg: 74, regular_exercise: true })).toBe(2500);
    expect(dailyTarget(prefs(), day())).toMatchObject({ target_ml: 2500, extra: { used: 0 } });
  });
});

describe('C4: exercise days', () => {
  it('90 minutes gives 3,100 / 3,400 / 3,700 ml for low / medium / high sweat', () => {
    expect(dailyTarget(prefs(), day({ minutes: 90, sweat: 'low', source: 'confirmed' })).target_ml).toBe(3100);
    expect(dailyTarget(prefs(), day({ minutes: 90, sweat: 'medium', source: 'confirmed' })).target_ml).toBe(3400);
    expect(dailyTarget(prefs(), day({ minutes: 90, sweat: 'high', source: 'confirmed' })).target_ml).toBe(3700);
  });

  it('unknown sweat gives a range and says so instead of pretending to be exact', () => {
    const t = dailyTarget(prefs(), day({ minutes: 90, sweat: 'unknown', source: 'confirmed' }));
    expect(t.extra).toEqual({ min: 600, max: 1200, used: 900 });
    expect(t.notes.join()).toContain('出汗量未知');
  });

  it('uses the weekly plan as an estimate until the day is confirmed', () => {
    const p = prefs({ weekly_exercise: [{ weekday: 5, start: '19:00', minutes: 90, intensity: 'hard' }] });
    const planned = dailyTarget(p, day());
    expect(planned).toMatchObject({ target_ml: 3700, exercise: { status: 'planned', end: '20:30' } });
    expect(planned.notes.join()).toContain('還沒確認');
    expect(dailyTarget(p, day({ minutes: 0, sweat: 'unknown', source: 'none' })).target_ml).toBe(2500);
  });

  it('a doctor\'s fluid limit turns off extras and nudges', () => {
    const p = prefs({ medical_restriction: true, goal_ml: 1500 });
    expect(dailyTarget(p, day({ minutes: 90, sweat: 'high', source: 'confirmed' })).target_ml).toBe(1500);
    expect(waterReminder(p, day(), at(`${DAY}T15:00:00`))).toBeNull();
  });
});

describe('C4: safe reminders', () => {
  it('never suggests more than 500 ml at once, and does not push a catch-up at night', () => {
    const early = waterReminder(prefs(), day(), at(`${DAY}T17:00:00`))!;
    expect(early.body).toMatch(/先喝 (\d+) ml/);
    expect(Number(/先喝 (\d+) ml/.exec(early.body)![1])).toBeLessThanOrEqual(500);
    const late = waterReminder(prefs(), day(), at(`${DAY}T20:00:00`))!;
    expect(late.body).toContain('睡前不必一次補足');
    expect(Number(/先喝 (\d+) ml/.exec(late.body)![1])).toBeLessThanOrEqual(500);
  });

  it('respects quiet hours and pause', () => {
    expect(dueWaterSlot(prefs({ start: '07:00', end: '23:00', quiet_start: '22:30', quiet_end: '08:00' }), at(`${DAY}T23:00:00`))).toBeNull();
    expect(dueWaterSlot(prefs({ paused_until: at(`${DAY}T16:00:00`).toISOString() }), at(`${DAY}T15:10:00`))).toBeNull();
    expect(dueWaterSlot(prefs({ paused_until: at(`${DAY}T14:00:00`).toISOString() }), at(`${DAY}T15:10:00`))).toBe('15:00');
  });

  it('sends one post-exercise reminder about 15 minutes after the end time', () => {
    const d = day({ minutes: 90, sweat: 'high', end: '19:00', source: 'confirmed' });
    expect(postExerciseReminder(prefs(), d, at(`${DAY}T19:05:00`))).toBeNull();
    const r = postExerciseReminder(prefs(), d, at(`${DAY}T19:20:00`))!;
    expect(r.key).toBe(`water-post-exercise:${DAY}`);
    expect(r.body).toContain('不用一次喝完');
  });
});

describe('C4: commands, tools and scheduler', () => {
  it('parses the new commands', () => {
    expect(parseWaterCommand('運動 90 大汗')).toEqual({ action: 'exercise', minutes: 90, sweat: 'high' });
    expect(parseWaterCommand('運動 45')).toEqual({ action: 'exercise', minutes: 45, sweat: 'unknown' });
    expect(parseWaterCommand('今天沒運動')).toEqual({ action: 'no_exercise' });
    expect(parseWaterCommand('暫停 2 小時')).toEqual({ action: 'pause', minutes: 120 });
    expect(parseWaterCommand('暫停到明天')).toEqual({ action: 'pause', minutes: -1 });
    expect(parseWaterCommand('免打擾 22:30-08:00')).toEqual({ action: 'quiet', start: '22:30', end: '08:00' });
    expect(parseWaterCommand('個人 27 74')).toEqual({ action: 'profile', age: 27, weight_kg: 74 });
    expect(parseWaterCommand('恢復')).toEqual({ action: 'resume' });
  });

  it('exercise tool updates today\'s target and survives a reload; logging keeps it', async () => {
    const store = new MemoryAgendaStore();
    const water = new WaterService(store, vault);
    const registry = new ToolRegistry();
    healthTools(water).forEach(t => registry.register(t));
    const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => false });
    const ctx = { userId: 'owner', now: () => at(`${DAY}T12:00:00`) };
    await executor.invoke('health.water.exercise', { minutes: 90, sweat: 'medium', end: '07:30' }, ctx);
    await executor.invoke('health.water.log', { ml: 500 }, ctx);
    const status = await new WaterService(store, vault).day('owner', DAY);
    expect(status).toMatchObject({ total_ml: 500, exercise: { minutes: 90, sweat: 'medium', source: 'confirmed' } });
    const r = await executor.invoke('health.water.status', {}, ctx) as any;
    expect(r.data).toMatchObject({ goal_ml: 3400, base_goal_ml: 2500 });
  });

  it('scheduler sends the post-exercise reminder once, and nothing during a pause', async () => {
    const store = new MemoryAgendaStore();
    const water = new WaterService(store, vault);
    const sent: any[] = [];
    const hub: any = { agenda: store, water, features: { water: true }, push: { send: vi.fn(async (_u: string, m: any) => { sent.push(m); return { sent: 1, failed: 0 }; }) }, isConnected: async () => false, executor: { invoke: vi.fn() } };
    await water.setExercise('owner', DAY, { minutes: 60, sweat: 'high', end: '18:00', source: 'confirmed' });
    await runTick(hub, at(`${DAY}T18:20:00`));
    await runTick(hub, at(`${DAY}T18:30:00`));
    expect(sent.filter(m => m.title === '運動後補水')).toHaveLength(1);
    await water.updatePrefs('owner', { paused_until: at(`${DAY}T23:00:00`).toISOString() });
    const before = sent.length;
    await runTick(hub, at(`${DAY}T19:05:00`));
    expect(sent.length).toBe(before);
  });
});
