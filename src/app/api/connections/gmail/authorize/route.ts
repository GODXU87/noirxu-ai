import { NextResponse } from 'next/server';
import { TokenVault } from '@/connections/vault';
import { getHub } from '@/server/hub';
import { errorResponse, requireContext } from '@/server/http';
import { GMAIL_OAUTH_COOKIE as OAUTH_COOKIE } from '@/server/oauth-cookie';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const grant = new URL(request.url).searchParams.get('grant') === 'send' ? 'send' : 'read';
    const hub = getHub();
    const flow = hub.gmail.beginAuthorization(grant);
    const sealed = new TokenVault(hub.config.tokenEncryptionKey ?? undefined)
      .seal(JSON.stringify({ state: flow.state, verifier: flow.codeVerifier, userId: ctx.userId, exp: Date.now() + 10 * 60_000 }), 'gmail-oauth');
    const response = NextResponse.redirect(flow.url, 303);
    response.cookies.set({ name: OAUTH_COOKIE, value: sealed, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/connections/gmail', maxAge: 600 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
