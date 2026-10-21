import { NextResponse } from 'next/server';
import { appUrl } from '@/server/http';
import { sessionCookie } from '@/server/session';

export async function POST(request: Request) {
  const response = NextResponse.redirect(appUrl(request, '/login'), 303);
  response.cookies.set(sessionCookie(''));
  return response;
}
