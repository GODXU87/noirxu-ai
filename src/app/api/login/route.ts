import { NextResponse } from 'next/server';
import { appUrl, sameOrigin } from '@/server/http';
import { clearFailures, clientKey, isLockedOut, recordFailure } from '@/server/login-throttle';
import { issueSessionToken, passwordMatches, sessionCookie } from '@/server/session';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });
  const key = clientKey(request);
  if (isLockedOut(key)) return NextResponse.redirect(appUrl(request, '/login?error=locked'), 303);
  const form = await request.formData();
  const password = String(form.get('password') ?? '').slice(0, 256);
  if (!passwordMatches(password)) {
    await recordFailure(key);
    return NextResponse.redirect(appUrl(request, '/login?error=1'), 303);
  }
  clearFailures(key);
  const response = NextResponse.redirect(appUrl(request, '/'), 303);
  response.cookies.set(sessionCookie(issueSessionToken()));
  return response;
}
