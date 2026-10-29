// Garmin's token endpoint response. The documentation only says it "returns an access token";
// in practice (first live check, 2026-10-29) the body is not JSON, i.e. the token itself.
// Accepted forms, in order: JSON with access_token (OAuth2 standard), or a single opaque token
// as plain text (optionally quoted). A JWT's own exp claim sets the expiry. Anything else is
// described by shape only — never by its content.

export type TokenParse = { ok: true; token: string; expiresInMs: number | null } | { ok: false; shape: string };

const TOKEN_TEXT = /^[A-Za-z0-9\-._~+/=]{20,4096}$/;

function jwtExpiry(token: string, nowMs: number): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 - nowMs : null;
  } catch {
    return null;
  }
}

export function parseTokenResponse(text: string, contentType: string | null, nowMs: number): TokenParse {
  const trimmed = text.trim();
  try {
    const body = JSON.parse(trimmed) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      if (typeof b.access_token === 'string' && b.access_token) {
        const expiresIn = typeof b.expires_in === 'number' ? b.expires_in * 1000 : jwtExpiry(b.access_token, nowMs);
        return { ok: true, token: b.access_token, expiresInMs: expiresIn };
      }
      return { ok: false, shape: `JSON 欄位：${Object.keys(b).join(', ') || '（空）'}` };
    }
    if (typeof body === 'string' && TOKEN_TEXT.test(body)) return { ok: true, token: body, expiresInMs: jwtExpiry(body, nowMs) };
  } catch { /* plain text */ }
  if (TOKEN_TEXT.test(trimmed)) return { ok: true, token: trimmed, expiresInMs: jwtExpiry(trimmed, nowMs) };
  const kind = trimmed.startsWith('<') ? 'HTML' : trimmed.includes(' ') ? '含空白的文字' : '其他文字';
  return { ok: false, shape: `${contentType ?? '未標示類型'}，${kind}，長度 ${trimmed.length}` };
}
