import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { afternoonBodyAlert, morningBodyAlert } from '@/health/alerts';
import { DeliveryService } from '@/notify/delivery';

vi.mock('server-only', () => ({}));
const { runTick } = await import('@/server/tick');
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const ACCEPTED = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };

const daily = (over: Record<string, unknown> = {}) => ({ date: '2026-10-29', steps: 4000, step_goal: 8000, distance_m: null, active_kcal: null, total_kcal: null, resting_hr: 52, resting_hr_7d_avg: 52, min_hr: null, max_hr: null, stress_avg: 30, stress_max: null, moderate_minutes: null, vigorous_minutes: null, body_battery_high: null, body_battery_low: null, body_battery_latest: 55, body_battery_at_wake: 70, hydration_ml: null, hydration_goal_ml: null, last_device_sync: null, ...over });

describe('body-state alert rules', () => {
  it('speaks up in the morning only when recovery is clearly poor', () => {
    const poor = { readiness: 'easy' as const, suggestion: '今天以恢復為主，散步或伸展就好。', signals: [{ key: 'sleep', tone: 'low', text: '睡 5 小時 10 分' }, { key: 'hrv', tone: 'low', text: 'HRV 偏低' }, { key: 'body_battery', tone: 'watch', text: 'Body Battery 45' }] };
    const alert = morningBodyAlert(poor, 'd');
    expect(alert?.title).toMatch(/^Sir，/);
    expect(alert?.body).toContain('睡 5 小時 10 分、HRV 偏低');
    expect(alert?.body).toContain('今晚也請早點休息');
    expect(morningBodyAlert({ readiness: 'moderate', signals: [{ key: 'sleep', tone: 'watch', text: '睡 6 小時 40 分' }] }, 'd')).toBeNull();
    expect(morningBodyAlert({ readiness: 'moderate', signals: [{ key: 'sleep', tone: 'low', text: '睡 4 小時 50 分' }] }, 'd')).not.toBeNull();
    expect(morningBodyAlert({ readiness: null, signals: [] }, 'd')).toBeNull();
  });

  it('speaks up in the afternoon on a low Body Battery or high stress', () => {
    expect(afternoonBodyAlert(daily(), 'd')).toBeNull();
    expect(afternoonBodyAlert(daily({ body_battery_latest: 18 }), 'd')?.body).toContain('Body Battery 只剩 18');
    expect(afternoonBodyAlert(daily({ stress_avg: 58 }), 'd')?.body).toContain('今天平均壓力 58');
  });
});

describe('body-state alerts in the scheduler', () => {
  function hubAt(insight: unknown, day: unknown) {
    const agenda = new MemoryAgendaStore();
    const sent: any[] = [];
    const invoke = vi.fn(async (name: string) => ({ status: 'ok', tool: name, data: name === 'garmin.health.insight' ? insight : day, links: [] }));
    const hub: any = { agenda, vault, features: { health_alerts: true, briefings: false }, garmin: {}, isConnected: async () => false, executor: { invoke } };
    hub.delivery = new DeliveryService(agenda, vault, async (_u: string, m: any) => { sent.push(m); return ACCEPTED as any; });
    return { hub, sent, invoke };
  }
  const poor = { readiness: 'easy', suggestion: '今天以恢復為主。', signals: [{ key: 'sleep', tone: 'low', text: '睡 4 小時 30 分' }, { key: 'hrv', tone: 'low', text: 'HRV 偏低' }] };

  it('sends the morning alert once, and checks Garmin at most every 30 minutes otherwise', async () => {
    const { hub, sent, invoke } = hubAt(poor, daily());
    await runTick(hub, new Date('2026-10-29T09:10:00+08:00'));
    await runTick(hub, new Date('2026-10-29T09:11:00+08:00'));
    await runTick(hub, new Date('2026-10-29T10:30:00+08:00'));
    const alerts = sent.filter(m => m.tag?.startsWith('health-'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toMatch(/^Sir，/);

    const fine = hubAt({ readiness: 'go', signals: [{ key: 'sleep', tone: 'good', text: '睡 7 小時 30 分' }] }, daily());
    for (const m of ['09:10', '09:11', '09:20', '09:45']) await runTick(fine.hub, new Date(`2026-10-29T${m}:00+08:00`));
    expect(fine.sent).toHaveLength(0);
    expect(fine.invoke.mock.calls.filter(c => c[0] === 'garmin.health.insight')).toHaveLength(2);
  });

  it('stays off without the feature', async () => {
    const { hub, sent } = hubAt(poor, daily({ body_battery_latest: 10 }));
    hub.features.health_alerts = false;
    await runTick(hub, new Date('2026-10-29T15:10:00+08:00'));
    expect(sent).toHaveLength(0);
  });
});
