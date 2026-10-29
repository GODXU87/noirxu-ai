import 'server-only';
import { createHash } from 'node:crypto';
import { buildBriefing, digestMessage, reminderMessage } from '@/agenda/briefing';
import { buildEveningReport } from '@/assistant/reports';
import { taipeiDate } from '@/lib/dates';
import { dueWaterSlot, waterReminder } from '@/health/water';
import type { PushMessage } from '@/push/service';
import type { Hub } from './hub';
import { OWNER_ID } from './session';

export interface TickResult { reminders: number; briefing: boolean; evening?: boolean; pushed: number; water?: boolean; tasks?: { ran: number; waiting: number; error?: string } }

function taipeiHour(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(now));
}

/** Builds the morning summary from the agenda plus whatever source systems are connected. */
export async function morningBriefing(hub: Hub, userId: string, now: Date) {
  const today = taipeiDate(now);
  const ctx = { userId, now: () => now };
  const items = await hub.agenda.listItems(userId, { status: 'open' });
  let ledger: Parameters<typeof buildBriefing>[0]['ledger'] = null;
  if (await hub.isConnected(userId, 'ledger')) {
    const month = today.slice(0, 7);
    const [analytics, budget] = await Promise.all([
      hub.executor.invoke('ledger.analytics.get', { month }, ctx),
      hub.executor.invoke('ledger.budget.summary', { month }, ctx)
    ]);
    if (analytics.status === 'ok') {
      const a = analytics.data as { currency: string; summary: { expense: number } };
      const b = budget.status === 'ok' ? budget.data as { categories: Array<{ name: string; percentage: number; status: string }> } : { categories: [] };
      ledger = { expense: a.summary.expense, currency: a.currency, budgetWarnings: b.categories.filter(c => c.status === 'warning' || c.status === 'over') };
    }
  }
  let openPositions: number | null = null;
  if (await hub.isConnected(userId, 'journal')) {
    const trades = await hub.executor.invoke('journal.trades.list', { status: 'open', limit: 1 }, ctx);
    if (trades.status === 'ok') openPositions = (trades.data as { total_matching: number }).total_matching;
  }
  const brief = buildBriefing({ today, items, ledger, openPositions });
  const health = await healthLine(hub, userId, now, 'morning');
  return health ? { ...brief, body: `${health}\n${brief.body}`, lines: [health, ...brief.lines] } : brief;
}

/** One body-status line from Garmin for the briefings; null when Garmin is off, not set up or unavailable. */
async function healthLine(hub: Hub, userId: string, now: Date, when: 'morning' | 'evening') {
  if (!hub.garmin) return null;
  const result = await hub.executor.invoke('garmin.health.insight', { when }, { userId, now: () => now });
  if (result.status !== 'ok') return null;
  const line = (result.data as { push_line?: string }).push_line;
  return line ? `身體：${line}` : null;
}

/** Evening summary for a scheduled task: what is still open today and what comes tomorrow. */
export async function eveningBriefing(hub: Hub, userId: string, now: Date) {
  const report = buildEveningReport({ today: taipeiDate(now), items: await hub.agenda.listItems(userId, { status: 'all' }) });
  const lines = [
    report.done_today.length ? `今天完成 ${report.done_today.length} 件` : null,
    report.still_open_today.length ? `今天還沒完成：${report.still_open_today.slice(0, 3).map(i => i.title).join('、')}` : null,
    report.overdue.length ? `逾期 ${report.overdue.length} 件` : null,
    report.tomorrow.length ? `明天：${report.tomorrow.slice(0, 3).map(i => i.title).join('、')}` : '明天沒有排定的事'
  ].filter(Boolean);
  const urgent = (i: { priority: string }) => i.priority === 'urgent' || i.priority === 'high';
  const health = await healthLine(hub, userId, now, 'evening');
  if (health) lines.unshift(health);
  return { title: 'Sir，今日晚報', body: lines.join('\n'), important: report.overdue.length > 0 || report.tomorrow.some(urgent) || report.still_open_today.some(urgent) };
}

/** Taipei wall-clock HH:MM on `date` as an instant. */
function taipeiInstant(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00+08:00`);
}

export interface TickHealth { at: string; source: string; ok: boolean; result?: TickResult; error?: string }
const TICK_KEY = 'tick:last';

export async function recordTick(hub: Hub, health: TickHealth) {
  await hub.agenda.putSetting(TICK_KEY, hub.vault.seal(JSON.stringify(health), TICK_KEY));
}

export async function lastTick(hub: Hub): Promise<TickHealth | null> {
  const sealed = await hub.agenda.getSetting(TICK_KEY);
  return sealed ? JSON.parse(hub.vault.open(sealed, TICK_KEY)) as TickHealth : null;
}

export const LATE_PUSH_MS = 30 * 60_000;
export const REMINDER_EXPIRE_MS = 12 * 60 * 60_000;
export const MAX_PUSHES_PER_RUN = 3;

/**
 * Due reminders → as few notifications as possible, nothing lost:
 * - on time (≤ 30 min late): one notification per task; several reminders of the same task
 *   that are due together become one combined notification; more than three notifications in
 *   one run collapse into a single summary;
 * - 30 min – 12 h late (scheduler delay, app reopened): one "missed" summary, not a burst;
 * - over 12 h late: kept in the in-app inbox only.
 * Every reminder keeps its own record and inbox entry; a reminder leaves the due list only
 * when its notification is finished (accepted, failed after retries, or expired).
 */
async function deliverReminders(hub: Hub, due: Awaited<ReturnType<Hub['agenda']['dueReminders']>>, now: Date, today: string, onPushed: (n: number) => void) {
  let delivered = 0;
  const lateness = (d: (typeof due)[number]) => now.getTime() - Date.parse(d.remind_at);
  const expiry = (d: (typeof due)[number]) => new Date(Date.parse(d.remind_at) + REMINDER_EXPIRE_MS);
  const finished = (status: string) => status === 'provider_accepted' || status === 'failed' || status === 'expired';
  const accepted = (record: { status: string; devices?: Array<{ outcome: string }> }, before: string | undefined) => {
    if (record.status === 'provider_accepted' && before !== 'provider_accepted') onPushed(record.devices?.filter(d => d.outcome === 'accepted').length ?? 0);
  };

  for (const d of due.filter(d => lateness(d) > REMINDER_EXPIRE_MS)) {
    await hub.delivery.deliver({ key: `reminder:${d.id}`, kind: 'reminder', userId: d.user_id, message: reminderMessage(d.item, d.label, today), expiresAt: expiry(d), now });
    await hub.agenda.markReminderSent(d.id, now);
  }

  const onTime = due.filter(d => lateness(d) <= LATE_PUSH_MS);
  const late = due.filter(d => lateness(d) > LATE_PUSH_MS && lateness(d) <= REMINDER_EXPIRE_MS);
  const byTask = new Map<string, typeof due>();
  for (const d of onTime) byTask.set(`${d.user_id}|${d.item.title.trim()}`, [...(byTask.get(`${d.user_id}|${d.item.title.trim()}`) ?? []), d]);
  let batches: Array<{ members: typeof due; missed: boolean }> = [...byTask.values()].map(members => ({ members, missed: false }));
  if (batches.length > MAX_PUSHES_PER_RUN) batches = [{ members: onTime, missed: false }];
  if (late.length) batches.push({ members: late, missed: true });

  for (const { members, missed } of batches) {
    const userId = members[0].user_id;
    if (members.length === 1 && !missed) {
      const d = members[0];
      const key = `reminder:${d.id}`;
      const before = (await hub.delivery.get(key))?.status;
      const record = await hub.delivery.deliver({ key, kind: 'reminder', userId, message: reminderMessage(d.item, d.label, today), expiresAt: expiry(d), now });
      accepted(record, before);
      if (record.status !== before) console.info('[noirxu-ai:deliver]', 'reminder', record.status, `late ${Math.round(lateness(d) / 1000)}s`, record.last_error ?? '');
      if (record.status === 'provider_accepted') delivered += 1;
      if (record.status === 'provider_accepted') await hub.agenda.claimNotification(key, userId, 'reminder').catch(() => false);
      if (finished(record.status)) await hub.agenda.markReminderSent(d.id, now);
      continue;
    }
    const ids = members.map(m => m.id).sort();
    const digestKey = `digest:${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16)}`;
    const expiresAt = new Date(Math.min(...members.map(m => expiry(m).getTime())));
    for (const m of members) await hub.delivery.recordGrouped({ key: `reminder:${m.id}`, kind: 'reminder', userId, message: reminderMessage(m.item, m.label, today), digestKey, expiresAt: expiry(m), now });
    const before = (await hub.delivery.get(digestKey))?.status;
    const record = await hub.delivery.deliver({ key: digestKey, kind: 'digest', userId, message: digestMessage(members.map(m => m.item), today, { missed }), expiresAt, now, inbox: false });
    accepted(record, before);
    if (record.status === 'provider_accepted') delivered += members.length;
    if (record.status === 'provider_accepted') for (const m of members) await hub.agenda.claimNotification(`reminder:${m.id}`, userId, 'reminder').catch(() => false);
    if (finished(record.status)) for (const m of members) await hub.agenda.markReminderSent(m.id, now);
  }
  return delivered;
}

/**
 * Runs from the scheduler (and as a catch-up when the app is opened). Every notification goes
 * through the delivery service: it is filed in the inbox, sent when due, retried with backoff
 * if no device accepted it, and given up only after it expires.
 */
export async function runTick(hub: Hub, now = new Date()): Promise<TickResult> {
  let reminders = 0;
  let pushed = 0;
  const today = taipeiDate(now);
  const count = async (key: string, kind: string, userId: string, message: PushMessage, expiresAt: Date) => {
    const before = await hub.delivery.get(key);
    const record = await hub.delivery.deliver({ key, kind, userId, message, expiresAt, now });
    if (record.status === 'provider_accepted' && before?.status !== 'provider_accepted') {
      pushed += record.devices?.filter(d => d.outcome === 'accepted').length ?? 0;
      await hub.agenda.claimNotification(key, userId, kind).catch(() => false);
    }
    return record;
  };

  const result = await deliverReminders(hub, await hub.agenda.dueReminders(now), now, today, (n: number) => { pushed += n; });
  reminders += result;

  // Daily briefings: morning 08:00–11:00, evening 21:00–23:00 (Taipei). Each is built once per
  // day and then retried with the same text until a device accepts it or the window closes.
  const hour = taipeiHour(now);
  const briefingsOn = hub.features?.briefings !== false;
  const daily = async (key: string, kind: string, from: number, to: number, build: () => Promise<{ title: string; body: string }>) => {
    if (!briefingsOn || hour < from || hour >= to) return false;
    const existing = await hub.delivery.get(key);
    if (existing && ['provider_accepted', 'failed', 'expired'].includes(existing.status)) return false;
    const message: PushMessage = existing ? existing.message : { url: '/', ...(await build()), tag: `${kind}-${today}` };
    const record = await count(key, kind, OWNER_ID, message, taipeiInstant(today, `${String(to).padStart(2, '0')}:00`));
    return record.status === 'provider_accepted';
  };
  // With Garmin, tapping the briefing opens the full body-status analysis (answered locally, no model).
  const askBody = (q: string) => (hub.garmin ? { url: `/?c=new&ask=${encodeURIComponent(q)}` } : {});
  const briefing = await daily(`briefing:${OWNER_ID}:${today}`, 'briefing', 8, 11, async () => { const b = await morningBriefing(hub, OWNER_ID, now); return { title: b.title, body: b.body, ...askBody('昨晚睡得怎樣') }; });
  const evening = await daily(`evening:${OWNER_ID}:${today}`, 'evening', 21, 23, async () => { const b = await eveningBriefing(hub, OWNER_ID, now); return { title: b.title, body: b.body, ...askBody('今天身體狀況如何') }; });

  // Water: one notification per reminder slot, only when the user is behind pace.
  let water = false;
  if (hub.features?.water && hub.water) {
    const prefs = await hub.water.prefs(OWNER_ID);
    const slot = dueWaterSlot(prefs, now);
    if (slot) {
      const key = `water:${OWNER_ID}:${today}:${slot}`;
      // Always from current totals; once the user is back on pace, nothing more is sent.
      const message = waterReminder(prefs, await hub.water.day(OWNER_ID, today), now);
      if (message) {
        const record = await count(key, 'water', OWNER_ID, { ...message, url: '/', tag: `water-${today}` }, new Date(taipeiInstant(today, slot).getTime() + 60 * 60_000));
        water = record.status === 'provider_accepted';
      }
    }
  }
  // Background tasks run after the reminders, so a failing task never delays a reminder.
  let tasks: TickResult['tasks'];
  if (hub.tasks) {
    try { tasks = await hub.tasks.runDue(now); }
    catch (error) { tasks = { ran: 0, waiting: 0, error: error instanceof Error ? error.message.slice(0, 200) : 'task run failed' }; }
  }
  return { reminders, briefing, evening, pushed, water, ...(tasks ? { tasks } : {}) };
}
