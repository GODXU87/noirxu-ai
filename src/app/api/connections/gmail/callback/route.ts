import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { TokenVault } from '@/connections/vault';
import { getHub } from '@/server/hub';
import { appUrl } from '@/server/http';
import { currentUser } from '@/server/session';
import { GMAIL_OAUTH_COOKIE as OAUTH_COOKIE } from '@/server/oauth-cookie';

export const runtime = 'nodejs';

function back(request: Request, result: string) {
  const response = NextResponse.redirect(appUrl(request, `/connections?gmail=${result}`), 303);
  response.cookies.set({ name: OAUTH_COOKIE, value: '', path: '/api/connections/gmail', maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = await currentUser();
  const sealed = (await cookies()).get(OAUTH_COOKIE)?.value;
  if (!userId || !sealed) return back(request, 'error');
  if (url.searchParams.get('error')) return back(request, 'denied');

  const hub = getHub();
  try {
    const flow = JSON.parse(new TokenVault(hub.config.tokenEncryptionKey ?? undefined).open(sealed, 'gmail-oauth'));
    const state = Buffer.from(String(url.searchParams.get('state') ?? ''));
    const expected = Buffer.from(String(flow.state));
    if (flow.userId !== userId || Date.now() > flow.exp || state.length !== expected.length || !timingSafeEqual(state, expected)) return back(request, 'error');
    await hub.gmail.completeAuthorization(userId, String(url.searchParams.get('code') ?? ''), flow.verifier);
    return back(request, 'connected');
  } catch {
    return back(request, 'error');
  }
}
