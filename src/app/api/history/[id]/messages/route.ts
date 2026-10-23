import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { historyHub, uuidParam } from '@/server/history-guard';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

const body = z.object({
  fromSeq: z.number().int().min(0),
  items: z.array(z.object({ kind: z.string().max(20) }).loose()).max(200),
  context: z.object({ history: z.array(z.unknown()).max(2000), notes: z.array(z.string()).max(200), expectedVersion: z.number().int().min(1) }).strict().optional()
}).strict();

/** Appends messages; 409 when another device wrote first (the client reloads and retries). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const conversationId = uuidParam((await params).id);
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '格式不正確。');
    const { fromSeq, items, context } = parsed.data;
    const result = await historyHub('server_history').history.append(ctx.userId, conversationId, fromSeq, items as never,
      context ? { value: { history: context.history, notes: context.notes }, expectedVersion: context.expectedVersion } : undefined);
    if (result.status === 'not_found') throw new ToolError('NOT_FOUND', '找不到這段對話。');
    if (result.status !== 'ok') return json({ ok: false, conflict: result.status, nextSeq: result.nextSeq, error: { code: 'CONFLICT', message: '這段對話在另一台裝置有更新。' } }, 409);
    return json({ ok: true, nextSeq: result.nextSeq, version: result.version });
  } catch (error) {
    return errorResponse(error);
  }
}
