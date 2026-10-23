import 'server-only';
import { NextResponse } from 'next/server';
import { isToolError, ToolError, toToolError } from '@/hub/errors';
import type { ToolContext } from '@/hub/types';
import { currentUser } from './session';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function errorResponse(error: unknown) {
  const failure = toToolError(error);
  const status = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, PROPOSAL_NOT_FOUND: 404, INVALID_INPUT: 400, PROPOSAL_EXPIRED: 410, PROPOSAL_NOT_PENDING: 409, CONFLICT: 409, NOT_CONFIGURED: 503 }[failure.code as string] ?? 500;
  if (status === 500 && !isToolError(error)) console.error('[noirxu-ai]', error instanceof Error ? error.name : 'error');
  return json({ ok: false, error: { code: failure.code, message: failure.message } }, status);
}

/** Rejects cross-site POSTs: the Origin header must match the request host. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Next.js normalises request.url, so compare against the Host the browser actually used.
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function requireContext(request: Request, { mutating }: { mutating: boolean }): Promise<ToolContext> {
  if (mutating && !sameOrigin(request)) throw new ToolError('FORBIDDEN', '來源不符，已拒絕。');
  const userId = await currentUser();
  if (!userId) throw new ToolError('UNAUTHORIZED', '請先登入 NOIRXU AI。');
  return { userId, now: () => new Date() };
}

/** Absolute URL on the host the browser used (request.url is normalised by Next.js). */
export function appUrl(request: Request, path: string): URL {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  return host ? new URL(path, `${proto}://${host}`) : new URL(path, request.url);
}
