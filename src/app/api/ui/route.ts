import { NextResponse } from 'next/server';
import { appUrl } from '@/server/http';
import { UI_COOKIE } from '@/server/ui-mode';

export const runtime = 'nodejs';

/** /api/ui?mode=sasuke or ?mode=classic switches this browser's interface (display only). */
export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get('mode');
  const response = NextResponse.redirect(appUrl(request, '/'), 303);
  if (mode === 'sasuke' || mode === 'classic') {
    response.cookies.set(UI_COOKIE, mode, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  }
  return response;
}
