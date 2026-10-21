import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

const COOKIE = 'noirxu_ai_session';
const MAX_AGE_S = 60 * 60 * 24 * 7;

/** V0.1 is single-owner: every request acts for this user id. */
export const OWNER_ID = 'owner';

function secret(): string {
  const value = process.env.NOIRXU_AI_SESSION_SECRET ?? '';
  if (value.length < 32) throw new Error('NOIRXU_AI_SESSION_SECRET must be at least 32 characters');
  return value;
}

function sign(payload: string) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function passwordMatches(supplied: string): boolean {
  const expected = process.env.NOIRXU_AI_OWNER_PASSWORD ?? '';
  return Boolean(expected) && equal(supplied, expected);
}

export function issueSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: OWNER_ID, exp: Date.now() + MAX_AGE_S * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token?.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!equal(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.v === 1 && Number(data.exp) > Date.now() ? String(data.sub) : null;
  } catch {
    return null;
  }
}

export async function currentUser(): Promise<string | null> {
  return verifySessionToken((await cookies()).get(COOKIE)?.value);
}

export const sessionCookie = (value: string) => ({
  name: COOKIE, value, httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: value ? MAX_AGE_S : 0
});
