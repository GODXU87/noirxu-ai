import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await requireContext(request, { mutating: true });
    const parsed = z.object({ endpoint: z.url() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '缺少通知端點。');
    await getHub().push.unsubscribe(parsed.data.endpoint);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
