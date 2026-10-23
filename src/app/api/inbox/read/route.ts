import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const parsed = z.object({ keys: z.union([z.literal('all'), z.array(z.string().max(200)).max(100)]) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '缺少要標示的通知。');
    await getHub().delivery.markRead(ctx.userId, parsed.data.keys);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
