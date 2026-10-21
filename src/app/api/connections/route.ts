import { connectionStatuses } from '@/server/connections';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const hub = getHub();
    return json({ ok: true, storageMode: hub.storageMode, connections: await connectionStatuses(hub, ctx.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}
