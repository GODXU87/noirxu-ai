import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/** Service worker receipt: a notification was shown on this device, or tapped. */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const parsed = z.object({ key: z.string().min(1).max(200), event: z.enum(['displayed', 'opened']) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '回報格式不正確。');
    const ok = await getHub().delivery.markReceipt(ctx.userId, parsed.data.key, parsed.data.event, ctx.now());
    // Kind only (e.g. "reminder"), never the title: lets the owner check receipts in the Vercel logs.
    console.info('[noirxu-ai:receipt]', parsed.data.event, parsed.data.key.split(':')[0], ok ? 'recorded' : 'unknown');
    return json({ ok });
  } catch (error) {
    return errorResponse(error);
  }
}
