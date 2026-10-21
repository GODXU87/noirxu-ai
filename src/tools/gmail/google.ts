import { createHash, randomBytes } from 'node:crypto';
import { ToolError } from '@/hub/errors';
import type { CredentialStore } from '@/connections/credentials';

export const GMAIL_SCOPES = {
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  send: 'https://www.googleapis.com/auth/gmail.send'
} as const;
export type GmailGrant = keyof typeof GMAIL_SCOPES;

const IDENTITY_SCOPES = ['openid', 'email'];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GoogleOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
}

interface GmailSecret {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface GmailConnectionInfo {
  email: string | null;
  scopes: string[];
  connectedAt: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

function base64url(buffer: Buffer) {
  return buffer.toString('base64url');
}

/** Email claim from an ID token received directly from Google's token endpoint over TLS. */
function emailFromIdToken(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

export class GmailService {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly credentials: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  private requireConfig() {
    if (!this.configured) throw new ToolError('NOT_CONFIGURED', 'Google OAuth 尚未設定，請依 Connections 頁面的說明完成 Google Cloud 設定。');
    return this.config as Required<{ [K in keyof GoogleOAuthConfig]: string }>;
  }

  /** Starts an incremental-consent flow for one grant. The returned state/verifier must be kept server-side until the callback. */
  beginAuthorization(grant: GmailGrant): { url: string; state: string; codeVerifier: string } {
    const config = this.requireConfig();
    const state = base64url(randomBytes(24));
    const codeVerifier = base64url(randomBytes(48));
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: [...IDENTITY_SCOPES, GMAIL_SCOPES[grant]].join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
      code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256'
    });
    return { url: `${AUTH_ENDPOINT}?${params}`, state, codeVerifier };
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) throw new ToolError('UNAUTHORIZED', 'Google 授權失敗或已失效，請重新連接 Gmail。');
    return json as TokenResponse;
  }

  async completeAuthorization(userId: string, code: string, codeVerifier: string): Promise<GmailConnectionInfo> {
    const config = this.requireConfig();
    const tokens = await this.tokenRequest({
      code, code_verifier: codeVerifier, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: 'authorization_code'
    });
    const previous = await this.credentials.load<GmailSecret>(userId, 'gmail');
    const refreshToken = tokens.refresh_token ?? previous?.secret.refreshToken;
    if (!refreshToken) throw new ToolError('UNAUTHORIZED', 'Google 沒有回傳 refresh token，請斷開後重新連接。');
    const info: GmailConnectionInfo = {
      email: emailFromIdToken(tokens.id_token) ?? (previous?.metadata.email as string | null) ?? null,
      scopes: String(tokens.scope ?? '').split(' ').filter(scope => scope.startsWith('https://www.googleapis.com/auth/gmail.')),
      connectedAt: new Date().toISOString()
    };
    await this.credentials.save<GmailSecret>(userId, 'gmail', {
      refreshToken, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000
    }, { ...info });
    return info;
  }

  async connection(userId: string): Promise<GmailConnectionInfo | null> {
    const metadata = await this.credentials.metadata(userId, 'gmail');
    return metadata ? { email: (metadata.email as string) ?? null, scopes: (metadata.scopes as string[]) ?? [], connectedAt: String(metadata.connectedAt) } : null;
  }

  async hasGrant(userId: string, grant: GmailGrant): Promise<boolean> {
    return Boolean((await this.connection(userId))?.scopes.includes(GMAIL_SCOPES[grant]));
  }

  /** Revokes the grant at Google, then deletes the stored tokens. */
  async disconnect(userId: string): Promise<void> {
    const stored = await this.credentials.load<GmailSecret>(userId, 'gmail');
    if (stored) {
      try {
        await this.fetchImpl(`${REVOKE_ENDPOINT}?${new URLSearchParams({ token: stored.secret.refreshToken })}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch {
        // Local deletion still proceeds; the user can also revoke at myaccount.google.com/permissions.
      }
    }
    await this.credentials.remove(userId, 'gmail');
  }

  private async accessToken(userId: string): Promise<string> {
    const config = this.requireConfig();
    const stored = await this.credentials.load<GmailSecret>(userId, 'gmail');
    if (!stored) throw new ToolError('NOT_CONNECTED', '尚未連接 Gmail。');
    if (stored.secret.expiresAt - 60_000 > Date.now()) return stored.secret.accessToken;
    const tokens = await this.tokenRequest({
      refresh_token: stored.secret.refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token'
    });
    await this.credentials.save<GmailSecret>(userId, 'gmail', {
      refreshToken: tokens.refresh_token ?? stored.secret.refreshToken,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000
    }, stored.metadata);
    return tokens.access_token;
  }

  async api<T>(userId: string, path: string, init: RequestInit = {}, mode: 'read' | 'write' = 'read'): Promise<T> {
    const token = await this.accessToken(userId);
    let response: Response;
    try {
      response = await this.fetchImpl(`${GMAIL_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) }
      });
    } catch {
      throw mode === 'write'
        ? new ToolError('OUTCOME_UNKNOWN', '連線中斷，無法確認信件是否已寄出，請先查看 Gmail 寄件備份，不要重複寄送。')
        : new ToolError('UPSTREAM_UNAVAILABLE', 'Gmail 暫時無法連線。');
    }
    if (response.status === 401) throw new ToolError('UNAUTHORIZED', 'Gmail 授權已失效，請重新連接。');
    if (response.status === 403) throw new ToolError('FORBIDDEN', 'Gmail 拒絕這個操作（授權範圍不足）。');
    if (response.status === 404) throw new ToolError('NOT_FOUND', '找不到這封信。');
    if (!response.ok) {
      if (mode === 'write' && response.status >= 500) throw new ToolError('OUTCOME_UNKNOWN', 'Gmail 回傳伺服器錯誤，無法確認是否已寄出，請先查看寄件備份。');
      throw new ToolError('UPSTREAM_REJECTED', `Gmail 回傳錯誤（${response.status}）。`);
    }
    return response.json() as Promise<T>;
  }
}
