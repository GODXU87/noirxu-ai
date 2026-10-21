import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ToolError, safeUpstreamMessage } from '@/hub/errors';
import type { CredentialStore } from './credentials';

export interface SupabaseProjectConfig {
  url: string;
  anonKey: string;
}

interface SessionSecret {
  refreshToken: string;
  accessToken: string;
  /** Epoch seconds. */
  expiresAt: number;
}

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

/**
 * Acts on a source system as the signed-in user: anon key + that user's JWT, so the source
 * system's RLS policies and `auth.uid()` checks apply unchanged. No service-role key is used.
 */
export class SupabaseUserConnection {
  constructor(
    private readonly connection: 'ledger' | 'journal',
    private readonly config: SupabaseProjectConfig | null,
    private readonly credentials: CredentialStore
  ) {}

  get configured(): boolean {
    return Boolean(this.config?.url && this.config.anonKey);
  }

  private requireConfig(): SupabaseProjectConfig {
    if (!this.config?.url || !this.config.anonKey) throw new ToolError('NOT_CONFIGURED', `${this.connection} 的 Supabase 連線設定尚未填寫。`);
    return this.config;
  }

  /** Signs in with the user's own account. The password is used once and never stored. */
  async connect(userId: string, email: string, password: string): Promise<{ email: string }> {
    const config = this.requireConfig();
    const client = createClient(config.url, config.anonKey, CLIENT_OPTIONS);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new ToolError('UNAUTHORIZED', '登入失敗，請確認帳號密碼。');
    await this.credentials.save<SessionSecret>(userId, this.connection, {
      refreshToken: data.session.refresh_token,
      accessToken: data.session.access_token,
      expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in
    }, { email: data.user.email ?? email, accountId: data.user.id, connectedAt: new Date().toISOString() });
    return { email: data.user.email ?? email };
  }

  /** Revokes the stored session at the source system, then deletes it locally. */
  async disconnect(userId: string): Promise<void> {
    const stored = await this.credentials.load<SessionSecret>(userId, this.connection);
    if (stored && this.configured) {
      const config = this.requireConfig();
      const client = createClient(config.url, config.anonKey, CLIENT_OPTIONS);
      try {
        await client.auth.setSession({ access_token: stored.secret.accessToken, refresh_token: stored.secret.refreshToken });
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // Local removal still proceeds; the session then simply expires.
      }
    }
    await this.credentials.remove(userId, this.connection);
  }

  async isConnected(userId: string): Promise<boolean> {
    return this.configured && Boolean(await this.credentials.metadata(userId, this.connection));
  }

  /** A client carrying the user's current access token, refreshing (and re-storing the rotated refresh token) when needed. */
  async client(userId: string): Promise<{ client: SupabaseClient; accountId: string }> {
    const config = this.requireConfig();
    const stored = await this.credentials.load<SessionSecret>(userId, this.connection);
    if (!stored) throw new ToolError('NOT_CONNECTED', `尚未連接 ${this.connection}。`);
    let secret = stored.secret;

    if (secret.expiresAt - 60 <= Math.floor(Date.now() / 1000)) {
      const refresher = createClient(config.url, config.anonKey, CLIENT_OPTIONS);
      const { data, error } = await refresher.auth.refreshSession({ refresh_token: secret.refreshToken });
      if (error || !data.session) throw new ToolError('UNAUTHORIZED', `${this.connection} 的登入已失效，請到 Connections 重新連接。`);
      secret = {
        refreshToken: data.session.refresh_token,
        accessToken: data.session.access_token,
        expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in
      };
      await this.credentials.save(userId, this.connection, secret, stored.metadata);
    }

    const client = createClient(config.url, config.anonKey, {
      ...CLIENT_OPTIONS,
      global: { headers: { Authorization: `Bearer ${secret.accessToken}` } }
    });
    return { client, accountId: String(stored.metadata.accountId ?? '') };
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

function isNetworkFailure(error: PostgrestLikeError): boolean {
  return !error.code && /fetch failed|network|ECONNRESET|ETIMEDOUT|aborted/i.test(String(error.message ?? ''));
}

/**
 * Maps a Supabase error to a ToolError. For writes, a network failure means we cannot know
 * whether the source system committed the record, so it becomes OUTCOME_UNKNOWN.
 */
export function mapSupabaseError(error: PostgrestLikeError, mode: 'read' | 'write'): ToolError {
  const code = String(error.code ?? '');
  const message = safeUpstreamMessage(error.message);
  if (isNetworkFailure(error)) {
    return mode === 'write'
      ? new ToolError('OUTCOME_UNKNOWN', '連線中斷，無法確認來源系統是否已寫入，請先到原網站確認，不要重複送出。')
      : new ToolError('UPSTREAM_UNAVAILABLE', '來源系統暫時無法連線。');
  }
  if (code === '28000' || code === 'PGRST301' || code === 'PGRST302') return new ToolError('UNAUTHORIZED', '來源系統登入已失效，請重新連接。');
  if (code === '42501') return new ToolError('FORBIDDEN', '來源系統拒絕這個操作（權限不足）。');
  if (code === 'P0002') return new ToolError('NOT_FOUND', message || '找不到指定的紀錄。');
  if (/^(22|23|P0)/.test(code)) return new ToolError('UPSTREAM_REJECTED', message || '來源系統拒絕了這筆資料。', { upstreamCode: code });
  return new ToolError(mode === 'write' ? 'OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE', message || '來源系統回傳錯誤。', { upstreamCode: code });
}
