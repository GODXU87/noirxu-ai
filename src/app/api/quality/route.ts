import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

// Quality self-check: 👍 / 👎 on a reply, the last 7 days' summary, and clearing the log.

function log() {
  const quality = getHub().quality;
  if (!quality) throw new ToolError('NOT_CONFIGURED', '品質自我檢查已關閉（feature quality）。');
  return quality;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const now = ctx.now();
    const quality = log();
    return json({ ok: true, summary: await quality.summary(ctx.userId, new Date(now.getTime() - 7 * 86_400_000), now), recent: await quality.list(ctx.userId, 30) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const body = z.object({ rating: z.enum(['up', 'down']), text: z.string().max(4000).default(''), source: z.string().max(60).optional(), note: z.string().trim().max(200).optional() }).safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ToolError('INVALID_INPUT', '評分格式不正確。');
    const { rating, text, source, note } = body.data;
    await log().record(ctx.userId, [{ kind: rating === 'up' ? 'thumbs_up' : 'thumbs_down', text, source, note: note || undefined }], ctx.now());
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Clears the log — the user's own action on their own data, confirmed in the page. */
export async function DELETE(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    await log().clear(ctx.userId);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
