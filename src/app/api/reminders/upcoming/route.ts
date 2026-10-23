import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/** Reminder times in the next 12 hours, so the open app can trigger delivery on time. */
export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const now = ctx.now();
    const rows = await getHub().agenda.upcomingReminders(ctx.userId, now, new Date(now.getTime() + 12 * 60 * 60_000));
    return json({ ok: true, now: now.toISOString(), reminders: rows.map(r => ({ at: r.remind_at })) });
  } catch (error) {
    return errorResponse(error);
  }
}
