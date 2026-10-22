import { NextResponse } from 'next/server';
import { configuredFeatures, databaseHealth } from '@/server/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public status: database state, which features are configured (booleans), and build version. */
export async function GET() {
  const db = await databaseHealth();
  const features = configuredFeatures();
  return NextResponse.json({
    ok: db === 'ok' || db === 'memory',
    db,
    features,
    version: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7)
  }, { status: db === 'ok' || db === 'memory' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
