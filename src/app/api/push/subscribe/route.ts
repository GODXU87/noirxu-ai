import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { isAllowedPushEndpoint } from '@/push/endpoints';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

const body = z.object({
  subscription: z.object({ endpoint: z.url().refine(isAllowedPushEndpoint, 'unsupported push service'), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) }).loose()
});

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '通知訂閱資料不正確。');
    await getHub().push.subscribe(ctx.userId, parsed.data.subscription, request.headers.get('user-agent') ?? '');
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
