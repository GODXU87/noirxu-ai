import { NextResponse } from 'next/server';
import { appUrl, sameOrigin } from '@/server/http';
import { issueSessionToken, passwordMatches, sessionCookie } from '@/server/session';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });
  const form = await request.formData();
  if (!passwordMatches(String(form.get('password') ?? ''))) return NextResponse.redirect(appUrl(request, '/login?error=1'), 303);
  const response = NextResponse.redirect(appUrl(request, '/'), 303);
  response.cookies.set(sessionCookie(issueSessionToken()));
  return response;
}
