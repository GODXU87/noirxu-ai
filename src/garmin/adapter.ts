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

// Connection state: OAuth tokens (sealed with the app's TokenVault, never in plain text),
// expiry, last sync and last error. Stored in the settings table under the existing grants;
// the app role cannot delete settings rows, so disconnecting overwrites the record with a
// sealed tombstone that holds no token.

export interface GarminConnection { access_token: string; refresh_token?: string; expires_at: string; scopes: string[]; connected_at: string; last_sync_at?: string; last_error?: string }
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
    return value && 'access_token' in value ? value : null;
  }

  async save(userId: string, connection: GarminConnection) {
    await this.store.putSetting(this.key(userId), this.vault.seal(JSON.stringify(connection), this.key(userId)));
  }

  /** What the settings page shows: never the token itself. */
  async status(userId: string, now: Date) {
    const c = await this.get(userId);
    if (!c) return { connected: false as const };
    return { connected: true as const, expired: Date.parse(c.expires_at) <= now.getTime(), expires_at: c.expires_at, scopes: c.scopes, last_sync_at: c.last_sync_at ?? null, last_error: c.last_error ?? null };
  }

  async recordSync(userId: string, now: Date, error?: string) {
    const k = this.key(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { sealed, value } = await this.read(userId);
      if (!value || !('access_token' in value)) return;
      const next: GarminConnection = error ? { ...value, last_error: error.slice(0, 200) } : { ...value, last_sync_at: now.toISOString(), last_error: undefined };
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(next), k))) return;
    }
  }

  async disconnect(userId: string, now: Date) {
    await this.store.putSetting(this.key(userId), this.vault.seal(JSON.stringify({ disconnected_at: now.toISOString() }), this.key(userId)));
  }
}
