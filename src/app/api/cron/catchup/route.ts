import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { lastTick, recordTick, runTick, tickHealthy } from '@/server/tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

const STALE_MS = 5 * 60_000;
const DUE_MIN_GAP_MS = 15_000;

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
    // `due`: the app's own timer says a reminder is due now; run even if a run was recent
    // (delivery is idempotent, so an extra run cannot send twice).
    const due = new URL(request.url).searchParams.get('due') === '1';
    const recent = last ? Date.now() - Date.parse(last.at) : Infinity;
    if (recent < (due ? DUE_MIN_GAP_MS : STALE_MS)) {
      const ok = last!.ok && (!last!.result || tickHealthy(last!.result!));
      return json({ ok, ran: false, last_at: last!.at }, ok ? 200 : 503);
    }
    let result;
    try { result = await runTick(hub); }
    catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : 'tick failed';
      await recordTick(hub, { at: new Date().toISOString(), source: 'app-catchup', ok: false, error: message }).catch(() => undefined);
      throw error;
    }
    const ok = tickHealthy(result);
    await recordTick(hub, { at: new Date().toISOString(), source: 'app-catchup', ok, result });
    return json({ ok, ran: true, ...result }, ok ? 200 : 503);
  } catch (error) {
    return errorResponse(error);
  }
}
