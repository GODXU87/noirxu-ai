import { z } from 'zod';
import { GarminConnectionStore, verifyGarminKey } from '@/garmin/adapter';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

// Garmin Connect Personal API key: save (sealed), check against Garmin, status, disconnect.
// Off unless the 'garmin' feature is enabled. The key is never returned to the browser.

function store() {
  const hub = getHub();
  if (!hub.features.garmin) throw new ToolError('NOT_CONFIGURED', 'Garmin 功能尚未啟用。');
  return new GarminConnectionStore(hub.agenda, hub.vault);
}

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    return json({ ok: true, garmin: await store().status(ctx.userId, ctx.now()) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const conns = store();
    const body = await request.json().catch(() => null);
    if (body?.action === 'verify') return json({ ok: true, check: await verifyGarminKey(conns, ctx.userId, ctx.now()), garmin: await conns.status(ctx.userId, ctx.now()) });
    const parsed = z.object({ api_key: z.string().trim().min(16).max(512).regex(/^[\x21-\x7e]+$/), key_expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).safeParse(body);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', 'API Key 格式不正確（請貼上 Garmin 顯示的完整金鑰，不含空白）。');
    await conns.save(ctx.userId, { apiKey: parsed.data.api_key, keyExpiresOn: parsed.data.key_expires_on, now: ctx.now() });
    return json({ ok: true, check: await verifyGarminKey(conns, ctx.userId, ctx.now()), garmin: await conns.status(ctx.userId, ctx.now()) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const conns = store();
    await conns.disconnect(ctx.userId, ctx.now());
    return json({ ok: true, garmin: await conns.status(ctx.userId, ctx.now()) });
  } catch (error) {
    return errorResponse(error);
  }
}
