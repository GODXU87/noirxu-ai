import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { GarminConnectionStore, GARMIN_TOKEN_URL } from '@/garmin/adapter';
import { compareWeeks, GarminClient, GARMIN_API } from '@/garmin/client';
import { classify } from '@/router/intents';
import { garminTools } from '@/tools/garmin/tools';
import { vault } from './helpers/chat-hub';

// Responses use the field names of the official OpenAPI document (docs/garmin/personal-api-openapi.json).
const NOW = new Date('2026-10-29T01:00:00Z'); // 09:00 Taipei
const daily = { calendarDate: '2026-10-29', totalSteps: 6420, dailyStepGoal: 8000, totalDistanceMeters: 4980, restingHeartRate: 52, lastSevenDaysAvgRestingHeartRate: 54, bodyBatteryAtWakeTime: 71, bodyBatteryMostRecentValue: 64, averageStressLevel: 28, hydrationValueInML: 500, lastSyncTimestampGMT: '2026-10-29T00:52:00.0' };
const sleep = { calendarDate: '2026-10-29', sleepTimeSeconds: 25200, deepSleepSeconds: 5400, lightSleepSeconds: 13800, remSleepSeconds: 6000, awakeSleepSeconds: 900, awakeCount: 2, sleepQualityTypePK: 'good' };
const hrv = { hrvSummary: { calendarDate: '2026-10-29', lastNightAvg: 58, weeklyAvg: 61, status: 'BALANCED' } };
const activities = [
  { activityId: 101, activityName: '林口跑步', activityType: { typeKey: 'running' }, startTimeLocal: '2026-10-25 07:00:00', duration: 3600, distance: 10000, calories: 650, averageHR: 150, activityTrainingLoad: 120 },
  { activityId: 102, activityName: '羽球', activityType: { typeKey: 'badminton' }, startTimeLocal: '2026-10-27 19:00:00', duration: 5400, distance: null, calories: 700, averageHR: 138, activityTrainingLoad: 90 },
  { activityId: 90, activityName: '跑步', activityType: { typeKey: 'running' }, startTimeLocal: '2026-10-18 07:00:00', duration: 3000, distance: 8000, calories: 520, averageHR: 148, activityTrainingLoad: 100 }
];

function setup(options: { token?: unknown; expiresOn?: string | null; dataStatus?: number } = {}) {
  const store = new MemoryAgendaStore();
  const conns = new GarminConnectionStore(store, vault);
  const calls: Array<{ url: string; auth: string }> = [];
  let tokens = 0;
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    calls.push({ url, auth });
    if (url === GARMIN_TOKEN_URL) { tokens += 1; return new Response(JSON.stringify(options.token ?? { access_token: `tok-${tokens}`, token_type: 'Bearer', expires_in: 86400 }), { status: 200 }); }
    if (options.dataStatus) return new Response('{}', { status: options.dataStatus });
    const path = new URL(url).pathname;
    const body = path.endsWith('/usersummary/daily') ? daily : path.endsWith('/dailySleep') ? sleep : path.startsWith('/hrv-service/') ? hrv : path.endsWith('/search/activities') ? activities : path.startsWith('/activity-service/activity/') ? { activityId: 101, activityName: '林口跑步', activityTypeDTO: { typeKey: 'running' }, summaryDTO: { startTimeLocal: '2026-10-25T07:00:00.0', duration: 3600, distance: 10000, trainingEffect: 3.4 } } : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  });
  const client = new GarminClient(conns, store, vault, fetcher as unknown as typeof fetch, () => NOW);
  const connect = () => conns.save('owner', { apiKey: 'gpk-secret-0123456789abcdef', keyExpiresOn: options.expiresOn ?? null, now: NOW });
  return { store, conns, client, calls, connect, fetcher };
}

describe('Garmin Personal API client (official paths and fields)', () => {
  it('exchanges the key once, calls data endpoints with the bearer token, and maps documented fields', async () => {
    const { client, calls, connect, conns } = setup();
    await connect();
    const d = await client.daily('owner', '2026-10-29');
    expect(d).toMatchObject({ steps: 6420, step_goal: 8000, resting_hr: 52, resting_hr_7d_avg: 54, body_battery_at_wake: 71, hydration_ml: 500, last_device_sync: '2026-10-29T00:52:00.0' });
    expect(calls[0]).toEqual({ url: GARMIN_TOKEN_URL, auth: 'ApiKey gpk-secret-0123456789abcdef' });
    expect(calls[1]).toEqual({ url: `${GARMIN_API}/usersummary-service/usersummary/daily?calendarDate=2026-10-29`, auth: 'Bearer tok-1' });
    await client.sleep('owner', '2026-10-29');
    expect(calls.filter(c => c.url === GARMIN_TOKEN_URL)).toHaveLength(1); // cached, sealed
    expect(calls[2].url).toBe(`${GARMIN_API}/sleep-service/sleep/dailySleep?date=2026-10-29`);
    expect(await conns.status('owner', NOW)).toMatchObject({ last_sync_at: NOW.toISOString(), last_error: null });
  });

  it('reads recovery from HRV + daily + sleep, and says training readiness is not available', async () => {
    const { client, connect } = setup();
    await connect();
    expect(await client.recovery('owner', '2026-10-29')).toMatchObject({ hrv_last_night_avg: 58, hrv_weekly_avg: 61, hrv_status: 'BALANCED', body_battery_at_wake: 71, sleep_s: 25200, not_available: [expect.stringContaining('training_readiness')] });
  });

  it('lists activities and compares the last 7 days with the 7 before, per type', async () => {
    const { client, connect, calls } = setup();
    await connect();
    const list = await client.activities('owner', { from: '2026-10-16', to: '2026-10-29', limit: 99 });
    expect(new URL(calls.at(-1)!.url).searchParams.get('startDate')).toBe('2026-10-16');
    expect(list[0]).toMatchObject({ id: '101', type: 'running', duration_s: 3600, distance_m: 10000, training_load: 120 });
    const cmp = compareWeeks(list, '2026-10-29');
    const running = cmp.by_type.find(t => t.type === 'running')!;
    expect(running).toMatchObject({ this_week: { count: 1, km: 10, minutes: 60 }, last_week: { count: 1, km: 8, minutes: 50 }, change_pct: { km: 25, minutes: 20 } });
    expect(cmp.by_type.find(t => t.type === 'badminton')!.change_pct.minutes).toBeNull();
    expect(await client.activity('owner', '101')).toMatchObject({ type: 'running', aerobic_te: 3.4, distance_m: 10000 });
  });

  it('gets a fresh token once on 401 and reports rejected keys plainly', async () => {
    const { client, connect, store } = setup({ dataStatus: 403 });
    await connect();
    await expect(client.daily('owner', '2026-10-29')).rejects.toMatchObject({ code: 'NOT_CONNECTED', message: expect.stringContaining('金鑰可能已過期') });
    expect(store.settings.get('garmin:token:owner')).not.toContain('tok-');
  });

  it('never guesses an unexpected token format: reports field names only', async () => {
    const { client, connect } = setup({ token: { token: 'abc', validity: 1 } });
    await connect();
    const error = await client.daily('owner', '2026-10-29').catch(e => e);
    expect(error.message).toContain('欄位：token, validity');
    expect(error.message).not.toContain('abc');
  });

  it('refuses an expired key, and disconnecting removes the key and the cached token', async () => {
    const expired = setup({ expiresOn: '2026-10-01' });
    await expired.connect();
    await expect(expired.client.daily('owner', '2026-10-29')).rejects.toMatchObject({ message: expect.stringContaining('已在 2026-10-01 到期') });
    expect(expired.fetcher).not.toHaveBeenCalled();

    const { client, connect, conns, store } = setup();
    await connect();
    await client.daily('owner', '2026-10-29');
    await conns.disconnect('owner', NOW);
    expect(vault.open(store.settings.get('garmin:token:owner')!, 'garmin:token:owner')).not.toContain('tok-');
    await expect(client.daily('owner', '2026-10-29')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('tools add the data date and the not-a-diagnosis note; steps and sleep questions route locally', async () => {
    const { client, connect } = setup();
    await connect();
    const tool = garminTools(client).find(t => t.name === 'garmin.health.daily')!;
    const out = await tool.run({}, { userId: 'owner', now: () => NOW }, { idempotencyKey: 'x', startedAt: NOW });
    expect(out.data).toMatchObject({ date: '2026-10-29', steps: 6420, note: expect.stringContaining('不是醫療診斷') });
    expect(classify('今天走了幾步')).toEqual({ kind: 'garmin', which: 'steps' });
    expect(classify('昨晚睡得怎樣')).toEqual({ kind: 'garmin', which: 'sleep' });
  });
});
