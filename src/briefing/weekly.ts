import type { AgendaItem } from '@/agenda/rank';
import type { GarminAdapter, GarminSleep } from '@/garmin/adapter';
import type { InvokeResult, ToolContext } from '@/hub/types';
import type { QualitySummary } from '@/quality/log';

// Weekly review (Sunday evening, or '週報' any time): the last 7 days against the 7 before,
// across Garmin, Ledger, Journal and the agenda, plus a few cross-system observations. All
// fixed arithmetic; an observation is only made when there is enough data for it, and each
// source that is missing is simply left out.

type Invoke = (name: string, input: unknown, ctx: ToolContext) => Promise<InvokeResult>;

export interface WeeklyCard {
  kind: 'weekly';
  range: { from: string; to: string; prev_from: string; prev_to: string };
  training: Array<{ type: string; label: string; this_minutes: number; last_minutes: number; this_count: number; change_pct: number | null; km: number }> | null;
  sleep: { this_avg_s: number; last_avg_s: number | null; nights: number; short_nights: number } | null;
  spending: { currency: string; this_total: number; last_total: number; change_pct: number | null; top: Array<{ name: string; amount: number }> } | null;
  trading: Array<{ currency: string; closed: number; win_rate: number | null; net_pnl: number; last_net_pnl: number | null }> | null;
  tasks: { done: number; open_overdue: number } | null;
  insights: string[];
  /** SASUKE's own quality self-check for the week (feature 'quality'). */
  quality?: QualitySummary | null;
}

export const TYPE_LABEL: Record<string, string> = { running: '跑步', strength_training: '重訓', badminton: '羽球', indoor_cardio: '室內有氧', cycling: '騎車', walking: '走路', hiit: 'HIIT', treadmill_running: '跑步機' };

function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ok = <T,>(r: InvokeResult) => (r.status === 'ok' ? r.data as T : null);
const hm = (s: number) => `${Math.floor(s / 3600)} 小時 ${Math.round((s % 3600) / 60)} 分`;

export async function buildWeekly(deps: { invoke: Invoke; ctx: ToolContext; today: string; garmin: GarminAdapter | null; items: AgendaItem[]; connected: (c: 'ledger' | 'journal') => Promise<boolean>; quality?: QualitySummary | null }): Promise<WeeklyCard> {
  const { invoke, ctx, today } = deps;
  const range = { from: addDays(today, -6), to: today, prev_from: addDays(today, -13), prev_to: addDays(today, -7) };
  const settle = <T,>(p: Promise<T>) => p.catch(() => null);
  const [compare, sleeps, tx, perfThis, perfLast] = await Promise.all([
    deps.garmin ? settle(invoke('garmin.training.compare', {}, ctx)) : null,
    deps.garmin ? settle(deps.garmin.sleepRange(ctx.userId, range.prev_from, today)) : null,
    (await deps.connected('ledger')) ? settle(invoke('ledger.transactions.list', { from: range.prev_from, to: today, type: 'expense', limit: 500 }, ctx)) : null,
    (await deps.connected('journal')) ? settle(invoke('journal.performance.summary', { from: range.from, to: today }, ctx)) : null,
    (await deps.connected('journal')) ? settle(invoke('journal.performance.summary', { from: range.prev_from, to: range.prev_to }, ctx)) : null
  ]);

  // Training (Garmin, per activity type).
  const cmp = compare ? ok<{ by_type: Array<{ type: string; this_week: { count: number; minutes: number; km: number }; last_week: { minutes: number }; change_pct: { minutes: number | null } }> }>(compare) : null;
  const training = cmp ? cmp.by_type.map(t => ({ type: t.type, label: TYPE_LABEL[t.type] ?? t.type, this_minutes: t.this_week.minutes, last_minutes: t.last_week.minutes, this_count: t.this_week.count, change_pct: t.change_pct.minutes, km: t.this_week.km })).sort((a, b) => b.this_minutes - a.this_minutes) : null;

  // Sleep (Garmin; wake-day dates).
  const nights = (sleeps ?? []).filter((n): n is GarminSleep & { duration_s: number } => Boolean(n.duration_s));
  const thisNights = nights.filter(n => n.date >= range.from);
  const lastNights = nights.filter(n => n.date < range.from);
  const sleep = thisNights.length ? {
    this_avg_s: Math.round(avg(thisNights.map(n => n.duration_s))!),
    last_avg_s: lastNights.length >= 3 ? Math.round(avg(lastNights.map(n => n.duration_s))!) : null,
    nights: thisNights.length,
    short_nights: thisNights.filter(n => n.duration_s < 6.5 * 3600).length
  } : null;

  // Spending (Ledger expenses, one currency as Ledger reports it).
  const ledger = tx ? ok<{ currency: string; transactions: Array<{ amount: number | string; occurred_on: string; category_name?: string }> }>(tx) : null;
  let spending: WeeklyCard['spending'] = null;
  const perDay = new Map<string, number>();
  if (ledger) {
    let thisTotal = 0, lastTotal = 0;
    const byCat = new Map<string, number>();
    for (const t of ledger.transactions) {
      const amount = Number(t.amount) || 0;
      if (t.occurred_on >= range.from) {
        thisTotal += amount;
        byCat.set(t.category_name ?? '未分類', (byCat.get(t.category_name ?? '未分類') ?? 0) + amount);
        perDay.set(t.occurred_on, (perDay.get(t.occurred_on) ?? 0) + amount);
      } else lastTotal += amount;
    }
    spending = { currency: ledger.currency, this_total: Math.round(thisTotal), last_total: Math.round(lastTotal), change_pct: pct(thisTotal, lastTotal), top: [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, amount]) => ({ name, amount: Math.round(amount) })) };
  }

  // Trading (Journal, per currency — never added across currencies).
  type Perf = { by_currency: Array<{ currency: string; closed_trades: number; win_rate_pct: number | null; net_pnl: number }> };
  const pThis = perfThis ? ok<Perf>(perfThis) : null;
  const pLast = perfLast ? ok<Perf>(perfLast) : null;
  const trading = pThis ? pThis.by_currency.map(c => ({ currency: c.currency, closed: c.closed_trades, win_rate: c.win_rate_pct, net_pnl: c.net_pnl, last_net_pnl: pLast?.by_currency.find(x => x.currency === c.currency)?.net_pnl ?? null })) : null;

  // Agenda.
  const inWeek = (iso: string) => iso.slice(0, 10) >= range.from;
  const tasks = { done: deps.items.filter(i => i.status === 'done' && inWeek(i.updated_at)).length, open_overdue: deps.items.filter(i => i.status === 'open' && i.due_date !== null && i.due_date < today).length };

  // Cross-system observations: only with enough data on both sides.
  const insights: string[] = [];
  const trainedMore = training ? training.reduce((a, t) => a + t.this_minutes, 0) - training.reduce((a, t) => a + t.last_minutes, 0) : 0;
  const lastMinutes = training ? training.reduce((a, t) => a + t.last_minutes, 0) : 0;
  if (sleep?.last_avg_s && training && lastMinutes > 0) {
    const sleepDiff = Math.round((sleep.this_avg_s - sleep.last_avg_s) / 60);
    if (trainedMore / lastMinutes >= 0.3 && sleepDiff <= -20) insights.push(`訓練量比上週多了 ${Math.round((trainedMore / lastMinutes) * 100)}%，睡眠卻平均少了 ${-sleepDiff} 分鐘。下週先把睡眠補回來，訓練量不要再往上加。`);
    else if (sleepDiff >= 20) insights.push(`這週平均多睡了 ${sleepDiff} 分鐘，恢復條件比上週好。`);
  }
  if (nights.length && perDay.size) {
    const short = thisNights.filter(n => n.duration_s < 6.5 * 3600).map(n => perDay.get(n.date) ?? 0);
    const normal = thisNights.filter(n => n.duration_s >= 6.5 * 3600).map(n => perDay.get(n.date) ?? 0);
    const s = avg(short), n = avg(normal);
    if (short.length >= 2 && normal.length >= 2 && s !== null && n !== null && n > 0 && s / n >= 1.3) insights.push(`睡不到 6.5 小時的那幾天，平均花費是其他天的 ${(s / n).toFixed(1)} 倍。可能只是巧合，但值得留意。`);
  }
  if (spending && spending.change_pct !== null && spending.change_pct >= 30 && spending.top[0]) insights.push(`支出比上週多 ${spending.change_pct}%，最大宗是${spending.top[0].name}（${spending.currency} ${spending.top[0].amount.toLocaleString('en-US')}）。`);
  if (sleep && sleep.short_nights >= 3) insights.push(`這週有 ${sleep.short_nights} 晚睡不到 6.5 小時。`);

  return { kind: 'weekly', range, training, sleep, spending, trading, tasks, insights, quality: deps.quality ?? null };
}

export function weeklyPushBody(w: WeeklyCard): string {
  const parts = [
    w.training?.length ? `訓練 ${w.training.reduce((a, t) => a + t.this_minutes, 0)} 分` : null,
    w.sleep ? `平均睡 ${hm(w.sleep.this_avg_s)}` : null,
    w.spending ? `支出 ${w.spending.currency} ${w.spending.this_total.toLocaleString('en-US')}${w.spending.change_pct !== null ? `（${w.spending.change_pct >= 0 ? '+' : ''}${w.spending.change_pct}%）` : ''}` : null,
    w.tasks?.done ? `完成 ${w.tasks.done} 件事` : null
  ].filter(Boolean);
  return [parts.join(' · '), w.insights[0]].filter(Boolean).join('\n');
}
