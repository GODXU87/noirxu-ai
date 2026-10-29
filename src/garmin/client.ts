import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';
import { parseTokenResponse } from './token';
import { GARMIN_TOKEN_URL, garminTokenKey, type GarminActivity, type GarminAdapter, type GarminConnectionStore, type GarminDaily, type GarminRecovery, type GarminSleep } from './adapter';

// Garmin Connect Personal API client. Per Garmin's FAQ, the personal API key is exchanged for
// an OAuth2 access token (valid 24 hours, no refresh tokens); data calls carry that token.
// Paths and field names are from the official OpenAPI document. The token response fields are
// not in that document; see token.ts for the accepted forms.

export const GARMIN_API = 'https://personal.connectapi.garmin.com';
const TOKEN_MAX_MS = 24 * 60 * 60_000;
const TOKEN_MARGIN_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export class GarminClient implements GarminAdapter {
  readonly configured = true;

  constructor(
    private readonly conns: GarminConnectionStore,
    private readonly store: AgendaStore,
    private readonly vault: TokenVault,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async cachedToken(userId: string): Promise<{ token: string; expires_at: string } | null> {
    const k = garminTokenKey(userId);
    const sealed = await this.store.getSetting(k);
    if (!sealed) return null;
    const value = JSON.parse(this.vault.open(sealed, k)) as { token?: string; expires_at?: string };
    return value.token && value.expires_at ? { token: value.token, expires_at: value.expires_at } : null;
  }

  /** A valid access token, from the sealed cache or a fresh exchange of the stored key. */
  async token(userId: string, force = false): Promise<string> {
    const now = this.clock();
    if (!force) {
      const cached = await this.cachedToken(userId);
      if (cached && Date.parse(cached.expires_at) - TOKEN_MARGIN_MS > now.getTime()) return cached.token;
    }
    const conn = await this.conns.get(userId);
    if (!conn) throw new ToolError('NOT_CONNECTED', 'Garmin 尚未設定。請到「設定與連線」貼上 Garmin Personal API Key。');
    if (conn.key_expires_on && Date.parse(`${conn.key_expires_on}T23:59:59+08:00`) < now.getTime()) {
      throw new ToolError('NOT_CONNECTED', `Garmin API Key 已在 ${conn.key_expires_on} 到期。請到 Garmin Connect 建立新金鑰，再貼到「設定與連線」。`);
    }
    let response: Response;
    try {
      // Exactly the headers of Garmin's documented curl call: the endpoint answers in plain text,
      // so asking for JSON gets HTTP 406.
      response = await this.fetcher(GARMIN_TOKEN_URL, { method: 'POST', headers: { Authorization: `ApiKey ${conn.api_key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new ToolError('UPSTREAM_UNAVAILABLE', `連不到 Garmin：${error instanceof Error ? error.message.slice(0, 120) : '網路錯誤'}`);
    }
    if (!response.ok) throw this.httpError(response.status, '取得授權');
    const parsed = parseTokenResponse(await response.text(), response.headers.get('content-type'), now.getTime());
    if (!parsed.ok) throw new ToolError('UPSTREAM_REJECTED', `Garmin 回傳的授權格式和預期不同（${parsed.shape}）。資料沒有讀取。`);
    const token = parsed.token;
    const lifetime = Math.max(60_000, Math.min(TOKEN_MAX_MS, parsed.expiresInMs ?? 23 * 3600_000));
    const k = garminTokenKey(userId);
    await this.store.putSetting(k, this.vault.seal(JSON.stringify({ token, expires_at: new Date(now.getTime() + lifetime).toISOString() }), k));
    return token;
  }

  private httpError(status: number, what: string) {
    if (status === 401 || status === 403) return new ToolError('NOT_CONNECTED', `Garmin 拒絕${what}（HTTP ${status}）：金鑰可能已過期或被刪除，請到 Garmin Connect 建立新金鑰。`);
    if (status === 429) return new ToolError('UPSTREAM_UNAVAILABLE', 'Garmin 暫時限制請求次數，請稍後再試。');
    if (status === 404) return new ToolError('NOT_FOUND', 'Garmin 沒有這筆資料（可能手錶還沒同步這一天）。');
    return new ToolError('UPSTREAM_UNAVAILABLE', `Garmin ${what}時回應 HTTP ${status}。`);
  }

  /** GET with the access token; one fresh token on 401. Records sync success or the error. */
  private async get<T>(userId: string, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, GARMIN_API);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const call = async (token: string, accept = true) => this.fetcher(url, { headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: 'application/json' } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    try {
      let token = await this.token(userId);
      let response = await call(token);
      if (response.status === 401) { token = await this.token(userId, true); response = await call(token); }
      // The spec declares JSON; if a server still refuses the Accept header, ask once without it.
      if (response.status === 406) response = await call(token, false);
      if (!response.ok) throw this.httpError(response.status, '讀取資料');
      const data = response.status === 204 ? null : await response.json();
      await this.conns.update(userId, c => ({ ...c, last_sync_at: this.clock().toISOString(), last_error: undefined }));
      return data as T;
    } catch (error) {
      const message = error instanceof ToolError ? error.message : `連不到 Garmin：${error instanceof Error ? error.message.slice(0, 120) : '網路錯誤'}`;
      await this.conns.update(userId, c => ({ ...c, last_error: message })).catch(() => undefined);
      throw error instanceof ToolError ? error : new ToolError('UPSTREAM_UNAVAILABLE', message);
    }
  }

  async daily(userId: string, date: string): Promise<GarminDaily> {
    const d = (await this.get<Json | null>(userId, '/usersummary-service/usersummary/daily', { calendarDate: date })) ?? {};
    return {
      date, steps: num(d.totalSteps), step_goal: num(d.dailyStepGoal), distance_m: num(d.totalDistanceMeters),
      active_kcal: num(d.activeKilocalories), total_kcal: num(d.totalKilocalories),
      resting_hr: num(d.restingHeartRate), resting_hr_7d_avg: num(d.lastSevenDaysAvgRestingHeartRate), min_hr: num(d.minHeartRate), max_hr: num(d.maxHeartRate),
      stress_avg: num(d.averageStressLevel), stress_max: num(d.maxStressLevel),
      moderate_minutes: num(d.moderateIntensityMinutes), vigorous_minutes: num(d.vigorousIntensityMinutes),
      body_battery_high: num(d.bodyBatteryHighestValue), body_battery_low: num(d.bodyBatteryLowestValue),
      body_battery_latest: num(d.bodyBatteryMostRecentValue), body_battery_at_wake: num(d.bodyBatteryAtWakeTime),
      hydration_ml: num(d.hydrationValueInML), hydration_goal_ml: num(d.hydrationGoalInML), last_device_sync: str(d.lastSyncTimestampGMT)
    };
  }

  async sleep(userId: string, date: string): Promise<GarminSleep> {
    const d = (await this.get<Json | null>(userId, '/sleep-service/sleep/dailySleep', { date })) ?? {};
    return {
      date, duration_s: num(d.sleepTimeSeconds), deep_s: num(d.deepSleepSeconds), light_s: num(d.lightSleepSeconds), rem_s: num(d.remSleepSeconds),
      awake_s: num(d.awakeSleepSeconds), awake_count: num(d.awakeCount), quality: str(d.sleepQualityTypePK), result: str(d.sleepResultTypePK),
      start_local: str(d.sleepStartTimestampLocal), end_local: str(d.sleepEndTimestampLocal), avg_hr: num(d.avgHeartRate), avg_sleep_stress: num(d.avgSleepStress)
    };
  }

  async recovery(userId: string, date: string): Promise<GarminRecovery> {
    const [hrv, daily, sleep] = await Promise.all([
      this.get<Json | null>(userId, `/hrv-service/hrv/${encodeURIComponent(date)}`).catch(error => (error instanceof ToolError && error.code === 'NOT_FOUND' ? null : Promise.reject(error))),
      this.daily(userId, date),
      this.sleep(userId, date).catch(error => (error instanceof ToolError && error.code === 'NOT_FOUND' ? null : Promise.reject(error)))
    ]);
    const summary = ((hrv ?? {}) as Json).hrvSummary as Json | undefined;
    return {
      date, hrv_last_night_avg: num(summary?.lastNightAvg), hrv_weekly_avg: num(summary?.weeklyAvg), hrv_status: str(summary?.status),
      body_battery_at_wake: daily.body_battery_at_wake, body_battery_latest: daily.body_battery_latest,
      resting_hr: daily.resting_hr, resting_hr_7d_avg: daily.resting_hr_7d_avg, sleep_s: sleep?.duration_s ?? null,
      not_available: ['training_readiness（Personal API 沒有提供）']
    };
  }

  async activities(userId: string, range: { from: string; to: string; limit?: number }): Promise<GarminActivity[]> {
    const rows = (await this.get<Json[] | null>(userId, '/activitylist-service/activities/search/activities', { startDate: range.from, endDate: range.to, limit: range.limit ?? 50, start: 0 })) ?? [];
    return rows.map(r => activityView(r, r));
  }

  async activity(userId: string, id: string): Promise<GarminActivity> {
    const d = (await this.get<Json | null>(userId, `/activity-service/activity/${encodeURIComponent(id)}`)) ?? {};
    return activityView(d, (d.summaryDTO as Json | undefined) ?? {}, (d.activityTypeDTO as Json | undefined));
  }
}

/** List rows carry the measurements at the top level; the single-activity endpoint nests them in summaryDTO. */
function activityView(meta: Json, m: Json, type = meta.activityType as Json | undefined): GarminActivity {
  return {
    id: String(meta.activityId ?? ''), name: str(meta.activityName) ?? '', type: str(type?.typeKey) ?? 'unknown', start_local: str(m.startTimeLocal) ?? '',
    duration_s: num(m.duration) ?? 0, distance_m: num(m.distance), calories: num(m.calories), avg_hr: num(m.averageHR), max_hr: num(m.maxHR),
    aerobic_te: num(m.aerobicTrainingEffect ?? m.trainingEffect), anaerobic_te: num(m.anaerobicTrainingEffect), training_load: num(m.activityTrainingLoad), elevation_gain_m: num(m.elevationGain)
  };
}

/** Last 7 days vs the 7 days before, per activity type. Deterministic, no model. */
export function compareWeeks(activities: GarminActivity[], today: string) {
  const day = (offset: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  const thisFrom = day(-6);
  const lastFrom = day(-13);
  const totals = (list: GarminActivity[]) => {
    const byType: Record<string, { count: number; minutes: number; km: number; load: number }> = {};
    for (const a of list) {
      const t = (byType[a.type] ??= { count: 0, minutes: 0, km: 0, load: 0 });
      t.count += 1; t.minutes += a.duration_s / 60; t.km += (a.distance_m ?? 0) / 1000; t.load += a.training_load ?? 0;
    }
    for (const t of Object.values(byType)) { t.minutes = Math.round(t.minutes); t.km = Math.round(t.km * 10) / 10; t.load = Math.round(t.load); }
    return byType;
  };
  const date = (a: GarminActivity) => a.start_local.slice(0, 10);
  const current = totals(activities.filter(a => date(a) >= thisFrom && date(a) <= today));
  const previous = totals(activities.filter(a => date(a) >= lastFrom && date(a) < thisFrom));
  const types = [...new Set([...Object.keys(current), ...Object.keys(previous)])];
  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  return {
    this_week: { from: thisFrom, to: today }, last_week: { from: lastFrom, to: day(-7) },
    by_type: types.map(type => {
      const c = current[type] ?? { count: 0, minutes: 0, km: 0, load: 0 };
      const p = previous[type] ?? { count: 0, minutes: 0, km: 0, load: 0 };
      return { type, this_week: c, last_week: p, change_pct: { minutes: pct(c.minutes, p.minutes), km: pct(c.km, p.km), load: pct(c.load, p.load) } };
    })
  };
}
