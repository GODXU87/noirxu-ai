import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/**
 * Sends a test notification to every subscribed device and reports each result honestly:
 * accepted by the push service, rejected (with the reason), or no subscription. Whether the
 * device actually displayed it cannot be verified from the server.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const hub = getHub();
    const now = ctx.now();
    const time = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const report = await hub.push.send(ctx.userId, { title: 'SASUKE 測試通知', body: `${time} 送出。看到這則代表這台裝置可以收到提醒。`, url: '/connections', tag: `test-${now.getTime()}` }, now);
    return json({ ok: true, ...report });
  } catch (error) {
    return errorResponse(error);
  }
}
