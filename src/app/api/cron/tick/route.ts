import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyGithubScheduler } from '@/server/github-oidc';
import { getHub } from '@/server/hub';
import { databaseHealth } from '@/server/health';
import { recordTick, runTick } from '@/server/tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Optional second scheduler (e.g. an external cron service) authenticated with CRON_SECRET. */
function cronSecretMatches(header: string | null) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  const source = cronSecretMatches(authorization) ? 'cron-secret' : (await verifyGithubScheduler(authorization)) ? 'github-actions' : null;
  if (!source) return NextResponse.json({ ok: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const hub = getHub();
  try {
    const result = await runTick(hub);
    await recordTick(hub, { at: new Date().toISOString(), source, ok: true, result }).catch(() => undefined);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : 'error';
    console.error('[noirxu-ai:tick]', message);
    await recordTick(hub, { at: new Date().toISOString(), source, ok: false, error: message }).catch(() => undefined);
    return NextResponse.json({ ok: false, db: await databaseHealth() }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
