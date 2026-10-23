import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/** In-app notification inbox: every reminder is kept here, delivered to a device or not. */
export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const items = await getHub().delivery.history(ctx.userId, 50);
    return json({ ok: true, unread: items.filter(i => !i.read).length, items: items.map(i => ({ key: i.key, kind: i.kind, title: i.title, body: i.body, url: i.url, created_at: i.created_at, read: i.read, status: i.delivery?.status ?? 'pending' })) });
  } catch (error) {
    return errorResponse(error);
  }
}
