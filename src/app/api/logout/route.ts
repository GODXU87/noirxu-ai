import { NextResponse } from 'next/server';
import { appUrl, sameOrigin } from '@/server/http';
import { sessionCookie } from '@/server/session';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });
  const response = NextResponse.redirect(appUrl(request, '/login'), 303);
  response.cookies.set(sessionCookie(''));
  return response;
}
