import { rankItems, daysUntil } from '@/agenda/rank';
import { ToolError } from '@/hub/errors';
import { taipeiDate } from '@/lib/dates';
import { agendaView } from '@/tools/agenda/tools';
import { cachedWeather } from '@/weather/open-meteo';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';
export const maxDuration = 30;

// The home screen's "today at a glance", one light part per request so each section shows
// as soon as its own source answers: agenda (own DB), weather (Open-Meteo), body (Garmin),
// water. Nothing here calls the paid AI or the slow cross-system briefing.

const PARTS = ['agenda', 'weather', 'body', 'water'] as const;
type Part = (typeof PARTS)[number];

const hourIn = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(now));

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const part = new URL(request.url).searchParams.get('part') as Part | null;
    if (!part || !PARTS.includes(part)) throw new ToolError('INVALID_INPUT', `part 需為 ${PARTS.join(' / ')}`);
    const hub = getHub();
    const now = ctx.now();
    const today = taipeiDate(now);

    if (part === 'agenda') {
      const open = rankItems((await hub.agenda.listItems(ctx.userId, { status: 'open' })).filter(i => i.status === 'open'), today);
      const days = (d: string | null) => daysUntil(d, today);
      return json({
        ok: true, part,
        today: open.filter(i => days(i.due_date) === 0).length,
        overdue: open.filter(i => (days(i.due_date) ?? 0) < 0).length,
        next: open.slice(0, 3).map(i => { const v = agendaView(i, today); return { id: v.id, title: v.title, priority: v.priority, due_label: v.due_label }; })
      });
    }

    if (part === 'weather') {
      if (!hub.features.weather) return json({ ok: true, part, off: true });
      // After 18:00 the useful forecast is tomorrow's.
      const day = hourIn(now) >= 18 ? 1 : 0;
      let weather;
      try { weather = await cachedWeather(day, today); } catch (error) { return json({ ok: true, part, error: { message: error instanceof Error ? error.message : '天氣服務暫時連不上。' } }); }
      return json({ ok: true, part, tomorrow: day === 1, weather });
    }

    if (part === 'body') {
      if (!hub.garmin) return json({ ok: true, part, off: true });
      const when = hourIn(now) >= 17 ? 'evening' : 'morning';
      const result = await hub.executor.invoke('garmin.health.insight', { when, hydration: false }, ctx);
      if (result.status !== 'ok') return json({ ok: true, part, error: result.status === 'error' ? { code: result.code, message: result.message } : { code: 'UNKNOWN', message: '讀不到 Garmin 資料' } });
      const d = result.data as { headline: string; push_line?: string; signals?: Array<{ key: string; tone: string; text: string }>; narrative?: string[] };
      return json({ ok: true, part, when, headline: d.headline, line: d.push_line ?? null, signals: d.signals ?? [], narrative: d.narrative ?? [] });
    }

    if (!hub.features.water) return json({ ok: true, part, off: true });
    const water = await hub.executor.invoke('health.water.status', {}, ctx);
    return json({ ok: true, part, water: water.status === 'ok' ? water.data : null });
  } catch (error) {
    return errorResponse(error);
  }
}
