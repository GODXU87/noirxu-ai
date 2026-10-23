import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';

// Garmin Connect (V0.4 Phase 3, feature 'garmin', off by default). Read-only, the owner's
// own data, through Garmin's official API only — no scraping and never the Garmin password.
//
// This file is the verified interface, not the integration: the HTTP client is written only
// after the official API documentation (Swagger) and the user's developer credentials are
// available, so no endpoint or field name here is guessed. Until then every call returns an
// honest "not configured" error. Summaries keep only the few fields SASUKE needs (minimal
// retention); nothing here gives medical advice.

export interface GarminActivity { id: string; type: string; start: string; duration_s: number; distance_m?: number; calories?: number; avg_hr?: number }
export interface GarminDaily { date: string; steps?: number; resting_hr?: number; stress_avg?: number; body_battery_high?: number; body_battery_low?: number }
export interface GarminSleep { date: string; duration_s?: number; deep_s?: number; light_s?: number; rem_s?: number; awake_s?: number; score?: number }
export interface GarminRecovery { date: string; hrv_status?: string; training_readiness?: number; recovery_hours?: number }

/** Matches the tool names in the V0.4 spec: garmin.activities.list, garmin.activity.summary, garmin.health.daily, garmin.sleep.summary, garmin.recovery.overview. */
export interface GarminAdapter {
  readonly configured: boolean;
  activities(userId: string, range: { from: string; to: string }): Promise<GarminActivity[]>;
  activity(userId: string, id: string): Promise<GarminActivity>;
  daily(userId: string, date: string): Promise<GarminDaily>;
  sleep(userId: string, date: string): Promise<GarminSleep>;
  recovery(userId: string, date: string): Promise<GarminRecovery>;
}

const NOT_CONFIGURED = 'Garmin 尚未設定：需要 Garmin 官方開發者 API 的授權與文件後才能連接。SASUKE 不會使用帳號密碼或非官方方式讀取。';

/** The only adapter until the official API is approved: every call says so instead of returning made-up data. */
export class GarminNotConfigured implements GarminAdapter {
  readonly configured = false;
  private fail(): never { throw new ToolError('NOT_CONNECTED', NOT_CONFIGURED); }
  async activities(_userId: string, _range: { from: string; to: string }): Promise<GarminActivity[]> { this.fail(); }
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
    await response.body?.cancel().catch(() => undefined);
    message = response.ok ? 'Garmin 已接受這組 API Key。' : status === 401 || status === 403 ? 'Garmin 拒絕這組 API Key（可能已過期或被撤銷），請到 Garmin Connect 重新建立。' : status === 429 ? 'Garmin 暫時限制請求次數，請稍後再試。' : `Garmin 回應 HTTP ${status}。`;
  } catch (error) {
    message = `無法連到 Garmin：${error instanceof Error ? error.message.slice(0, 120) : '網路錯誤'}`;
  }
  const ok = status >= 200 && status < 300;
  await conns.update(userId, x => ({ ...x, last_check_at: now.toISOString(), last_check_status: status, last_error: ok ? undefined : message }));
  return { ok, status, message };
}
