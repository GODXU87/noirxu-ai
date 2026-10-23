import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@/history/privacy';
import { ToolError } from '@/hub/errors';
import { historyHub } from '@/server/history-guard';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const params = new URL(request.url).searchParams;
    const memories = await historyHub('memory').history.listMemories(ctx.userId, { query: params.get('q')?.slice(0, 100) ?? undefined, includeInactive: params.get('all') === '1' });
    return json({ ok: true, memories });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const parsed = z.object({ content: z.string().max(600), category: z.enum(MEMORY_CATEGORIES).optional() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '格式不正確。');
    return json({ ok: true, memory: await historyHub('memory').history.remember(ctx.userId, { ...parsed.data, source: 'manual' }) });
  } catch (error) {
    return errorResponse(error);
  }
}
