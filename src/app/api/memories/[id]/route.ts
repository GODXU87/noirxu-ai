import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@/history/privacy';
import { ToolError } from '@/hub/errors';
import { historyHub, uuidParam } from '@/server/history-guard';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const id = uuidParam((await params).id);
    const parsed = z.object({ content: z.string().max(600).optional(), category: z.enum(MEMORY_CATEGORIES).optional(), active: z.boolean().optional() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '格式不正確。');
    return json({ ok: true, memory: await historyHub('memory').history.editMemory(ctx.userId, id, parsed.data) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    await historyHub('memory').history.forget(ctx.userId, uuidParam((await params).id));
    return json({ ok: true, purgeAfterDays: 30 });
  } catch (error) {
    return errorResponse(error);
  }
}
