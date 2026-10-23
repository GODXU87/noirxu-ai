import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { historyHub, uuidParam } from '@/server/history-guard';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const conversationId = uuidParam((await params).id);
    const loaded = await historyHub('server_history').history.load(ctx.userId, conversationId);
    if (!loaded) throw new ToolError('NOT_FOUND', '找不到這段對話。');
    return json({ ok: true, ...loaded });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const conversationId = uuidParam((await params).id);
    const parsed = z.object({ title: z.string() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '格式不正確。');
    const row = await historyHub('server_history').history.rename(ctx.userId, conversationId, parsed.data.title);
    if (!row) throw new ToolError('NOT_FOUND', '找不到這段對話。');
    return json({ ok: true, conversation: row });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const conversationId = uuidParam((await params).id);
    if (!(await historyHub('server_history').history.remove(ctx.userId, conversationId))) throw new ToolError('NOT_FOUND', '找不到這段對話。');
    return json({ ok: true, purgeAfterDays: 30 });
  } catch (error) {
    return errorResponse(error);
  }
}
