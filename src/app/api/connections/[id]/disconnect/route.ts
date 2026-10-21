import { ToolError } from '@/hub/errors';
import { assertConnectionId } from '@/server/connections';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const id = assertConnectionId((await params).id);
    const hub = getHub();
    if (id === 'ledger' || id === 'journal') await hub[id].disconnect(ctx.userId);
    else if (id === 'gmail') await hub.gmail.disconnect(ctx.userId);
    else throw new ToolError('INVALID_INPUT', 'RADAR 由伺服器設定連線，請移除 RADAR_INTEGRATION_TOKEN。');
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
