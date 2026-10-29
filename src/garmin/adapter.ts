import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';
import { parseTokenResponse } from './token';

// Garmin Connect (feature 'garmin', off by default). Read-only, the owner's own data, through
// Garmin's official Personal API only — no scraping and never the Garmin password. Field names
// follow the official OpenAPI document (docs/garmin/personal-api-openapi.json). Summaries keep
// only the fields SASUKE needs and nothing is stored except the sealed key/token and the sync
// status (minimal retention). Device metrics are not a medical diagnosis.

export interface GarminActivity {
  id: string; name: string; type: string; start_local: string; duration_s: number; distance_m: number | null; calories: number | null;
  avg_hr: number | null; max_hr: number | null; aerobic_te: number | null; anaerobic_te: number | null; training_load: number | null; elevation_gain_m: number | null;
}
export interface GarminDaily {
  date: string; steps: number | null; step_goal: number | null; distance_m: number | null; active_kcal: number | null; total_kcal: number | null;
  resting_hr: number | null; resting_hr_7d_avg: number | null; min_hr: number | null; max_hr: number | null;
  stress_avg: number | null; stress_max: number | null; moderate_minutes: number | null; vigorous_minutes: number | null;
  body_battery_high: number | null; body_battery_low: number | null; body_battery_latest: number | null; body_battery_at_wake: number | null;
  hydration_ml: number | null; hydration_goal_ml: number | null; last_device_sync: string | null;
}
export interface GarminSleep {
  date: string; duration_s: number | null; deep_s: number | null; light_s: number | null; rem_s: number | null; awake_s: number | null;
  awake_count: number | null; quality: string | null; result: string | null; start_local: string | null; end_local: string | null; avg_hr: number | null; avg_sleep_stress: number | null;
}
export interface GarminRecovery {
  date: string; hrv_last_night_avg: number | null; hrv_weekly_avg: number | null; hrv_status: string | null;
  body_battery_at_wake: number | null; body_battery_latest: number | null; resting_hr: number | null; resting_hr_7d_avg: number | null; sleep_s: number | null;
  /** The Personal API has no training-readiness endpoint; said plainly instead of estimated. */
  not_available: string[];
}

export interface GarminAdapter {
  readonly configured: boolean;
  activities(userId: string, range: { from: string; to: string; limit?: number }): Promise<GarminActivity[]>;
  activity(userId: string, id: string): Promise<GarminActivity>;
  daily(userId: string, date: string): Promise<GarminDaily>;
  sleep(userId: string, date: string): Promise<GarminSleep>;
  recovery(userId: string, date: string): Promise<GarminRecovery>;
}

const NOT_CONFIGURED = 'Garmin 尚未設定。請到「設定與連線」貼上 Garmin Personal API Key。SASUKE 不會使用帳號密碼或非官方方式讀取。';

/** Used when the feature is on but no client exists (tests, misconfiguration): says so instead of returning made-up data. */
export class GarminNotConfigured implements GarminAdapter {
  readonly configured = false;
  private fail(): never { throw new ToolError('NOT_CONNECTED', NOT_CONFIGURED); }
  async activities(_userId: string, _range: { from: string; to: string; limit?: number }): Promise<GarminActivity[]> { this.fail(); }
  async activity(_userId: string, _id: string): Promise<GarminActivity> { this.fail(); }
  async daily(_userId: string, _date: string): Promise<GarminDaily> { this.fail(); }
  async sleep(_userId: string, _date: string): Promise<GarminSleep> { this.fail(); }
  async recovery(_userId: string, _date: string): Promise<GarminRecovery> { this.fail(); }
}

// Connection: the Garmin Connect Personal API. Per Garmin's own instructions the user creates
// a personal API key in Garmin Connect (Settings → Personal API Key, with an expiry they
// choose; shown once), and the key is exchanged for an access token at the endpoint below with
// the header "Authorization: ApiKey <key>". That is everything verified so far: the data
// endpoints and the token response fields come from the Swagger docs and are not used until
// they have been read. The key is sealed with the app's TokenVault and never shown again.
// The app role cannot delete settings rows, so disconnecting overwrites the record with a
// sealed tombstone that holds no key.

export const garminTokenKey = (userId: string) => `garmin:token:${userId}`;

export const GARMIN_TOKEN_URL = 'https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token';

export interface GarminConnection { api_key: string; key_expires_on: string | null; connected_at: string; last_check_at?: string; last_check_status?: number; last_sync_at?: string; last_error?: string }
type Stored = GarminConnection | { disconnected_at: string };

export class GarminConnectionStore {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}
  private key(userId: string) { return `garmin:connection:${userId}`; }

  private async read(userId: string): Promise<{ sealed: string | null; value: Stored | null }> {
    const k = this.key(userId);
    const sealed = await this.store.getSetting(k);
    return { sealed, value: sealed ? JSON.parse(this.vault.open(sealed, k)) as Stored : null };
  }

  async get(userId: string): Promise<GarminConnection | null> {
    const { value } = await this.read(userId);
    return value && 'api_key' in value ? value : null;
  }

  async save(userId: string, input: { apiKey: string; keyExpiresOn: string | null; now: Date }) {
    const connection: GarminConnection = { api_key: input.apiKey, key_expires_on: input.keyExpiresOn, connected_at: input.now.toISOString() };
    await this.store.putSetting(this.key(userId), this.vault.seal(JSON.stringify(connection), this.key(userId)));
  }

  /** What the settings page shows: never the key itself. */
  async status(userId: string, now: Date) {
    const c = await this.get(userId);
    if (!c) return { connected: false as const };
    const expired = c.key_expires_on ? Date.parse(`${c.key_expires_on}T23:59:59+08:00`) < now.getTime() : false;
    return {
      connected: true as const, key_hint: `…${c.api_key.slice(-4)}`, key_expires_on: c.key_expires_on, key_expired: expired, connected_at: c.connected_at,
      last_check_at: c.last_check_at ?? null, last_check_status: c.last_check_status ?? null, last_sync_at: c.last_sync_at ?? null, last_error: c.last_error ?? null
    };
  }

  async update(userId: string, change: (c: GarminConnection) => GarminConnection) {
    const k = this.key(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { sealed, value } = await this.read(userId);
      if (!value || !('api_key' in value)) return;
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(change(value)), k))) return;
    }
  }

  async disconnect(userId: string, now: Date) {
    await this.store.putSetting(this.key(userId), this.vault.seal(JSON.stringify({ disconnected_at: now.toISOString() }), this.key(userId)));
    // The cached access token goes too, so nothing usable is left behind.
    const tokenKey = garminTokenKey(userId);
    await this.store.putSetting(tokenKey, this.vault.seal(JSON.stringify({ revoked_at: now.toISOString() }), tokenKey));
  }
}

/**
 * Checks the stored key against Garmin's token endpoint. Only the HTTP status is used — the
 * token in the response is not kept or interpreted until the Swagger docs confirm its fields.
 */
export async function verifyGarminKey(conns: GarminConnectionStore, userId: string, now: Date, fetcher: typeof fetch = fetch) {
  const c = await conns.get(userId);
  if (!c) return { ok: false as const, message: 'Garmin 尚未設定 API Key。' };
  let status = 0;
  let message: string;
  try {
    const response = await fetcher(GARMIN_TOKEN_URL, { method: 'POST', headers: { Authorization: `ApiKey ${c.api_key}` }, signal: AbortSignal.timeout(15_000) });
    status = response.status;
    let shape: string | null = null;
    if (response.ok) { const parsed = parseTokenResponse(await response.text(), response.headers.get('content-type'), now.getTime()); shape = parsed.ok ? null : parsed.shape; }
    else await response.body?.cancel().catch(() => undefined);
    // The token itself is never kept here; only whether it is in a form SASUKE can use.
    message = response.ok ? (shape === null ? 'Garmin 已接受這組 API Key。' : `Garmin 接受了金鑰，但授權格式和預期不同（${shape}）。請把這段訊息告訴 SASUKE 的開發者。`) : status === 401 || status === 403 ? 'Garmin 拒絕這組 API Key（可能已過期或被撤銷），請到 Garmin Connect 重新建立。' : status === 429 ? 'Garmin 暫時限制請求次數，請稍後再試。' : `Garmin 回應 HTTP ${status}。`;
  } catch (error) {
    message = `無法連到 Garmin：${error instanceof Error ? error.message.slice(0, 120) : '網路錯誤'}`;
  }
  const ok = status >= 200 && status < 300 && message.startsWith('Garmin 已接受');
  await conns.update(userId, x => ({ ...x, last_check_at: now.toISOString(), last_check_status: status, last_error: ok ? undefined : message }));
  return { ok, status, message };
}
