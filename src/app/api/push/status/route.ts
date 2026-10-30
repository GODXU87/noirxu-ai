import { deviceId } from '@/push/service';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { lastTick, lastExternalTick, lastCatchupTick, tickHealthy, type TickHealth } from '@/server/tick';

export const runtime = 'nodejs';

const HEALTHY_MS = 20 * 60_000;

/** Server side of the notification diagnostics: devices, scheduler health, recent deliveries. */
export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const hub = getHub();
    const endpoint = new URL(request.url).searchParams.get('endpoint');
    const thisDevice = endpoint ? deviceId(endpoint) : null;
    const [devices, tick, catchup, latest, history, publicKey] = await Promise.all([
      hub.push.devices(ctx.userId), lastExternalTick(hub), lastCatchupTick(hub), lastTick(hub), hub.delivery.history(ctx.userId, 20), hub.push.publicKey()
    ]);
    const health = (record: TickHealth | null) => {
      const age = record ? Date.now() - Date.parse(record.at) : null;
      return { last: record, age_minutes: age === null ? null : Math.round(age / 60_000), healthy: age !== null && age >= 0 && age < HEALTHY_MS && record!.ok && (!record!.result || tickHealthy(record!.result)) };
    };
    const taskError = latest?.result?.tasks?.error ?? latest?.error ?? null;
    return json({
      ok: true,
      publicKey,
      this_device: thisDevice,
      server_has_this_device: thisDevice ? devices.some(d => d.device === thisDevice) : false,
      devices: devices.map(d => ({ ...d, is_this: d.device === thisDevice })),
      scheduler: health(tick),
      catchup: health(catchup),
      task_subsystem: { healthy: Boolean(latest?.result?.tasks) && health(latest).healthy && !taskError, error: taskError, last_at: latest?.at ?? null },
      history: history.map(h => ({
        key: h.key, kind: h.kind, title: h.title, created_at: h.created_at, read: h.read,
        status: h.delivery?.status ?? 'pending', attempts: h.delivery?.attempts ?? 0, last_error: h.delivery?.last_error ?? null,
        next_retry_at: h.delivery?.next_retry_at ?? null, accepted_at: h.delivery?.accepted_at ?? null, displayed_at: h.delivery?.displayed_at ?? null, opened_at: h.delivery?.opened_at ?? null, devices: h.delivery?.devices ?? []
      }))
    });
  } catch (error) {
    return errorResponse(error);
  }
}
