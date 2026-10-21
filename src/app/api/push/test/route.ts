import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { morningBriefing } from '@/server/tick';

export const runtime = 'nodejs';

/** Sends today's summary right now, so the user can see what notifications look like. */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const hub = getHub();
    const summary = await morningBriefing(hub, ctx.userId, ctx.now());
    const result = await hub.push.send(ctx.userId, { title: `（測試）${summary.title}`, body: summary.body, url: '/overview', tag: 'test' });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
