import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { lastTick, recordTick, runTick } from '@/server/tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

const STALE_MS = 5 * 60_000;

/**
 * Runs the scheduler when the signed-in user opens the app and the last run is older than
 * five minutes. A safety net for the unreliable GitHub schedule, not a replacement for it:
 * nothing runs while the app is closed.
 */
export async function POST(request: Request) {
  try {
    await requireContext(request, { mutating: true });
    const hub = getHub();
    const last = await lastTick(hub);
    if (last && Date.now() - Date.parse(last.at) < STALE_MS) return json({ ok: true, ran: false, last_at: last.at });
    const result = await runTick(hub);
    await recordTick(hub, { at: new Date().toISOString(), source: 'app-catchup', ok: true, result });
    return json({ ok: true, ran: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
