import { NextResponse } from 'next/server';
import { verifyGithubScheduler } from '@/server/github-oidc';
import { getHub } from '@/server/hub';
import { runTick } from '@/server/tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await verifyGithubScheduler(request.headers.get('authorization')))) {
    return NextResponse.json({ ok: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runTick(getHub())) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[noirxu-ai:tick]', error instanceof Error ? error.message.slice(0, 200) : 'error');
    return NextResponse.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
