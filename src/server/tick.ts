import 'server-only';
import { buildBriefing, reminderMessage } from '@/agenda/briefing';
import { taipeiDate } from '@/lib/dates';
import { dueWaterSlot, waterReminder } from '@/health/water';
import type { Hub } from './hub';
import { OWNER_ID } from './session';

export interface TickResult { reminders: number; briefing: boolean; pushed: number; water?: boolean }

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
  return buildBriefing({ today, items, ledger, openPositions });
}

/**
 * Runs every few minutes from the scheduler. Each reminder and each day's briefing is
 * claimed in notification_log first, so overlapping runs never send twice.
 */
export async function runTick(hub: Hub, now = new Date()): Promise<TickResult> {
  let reminders = 0;
  let pushed = 0;
  const today = taipeiDate(now);
  for (const due of await hub.agenda.dueReminders(now)) {
    if (await hub.agenda.claimNotification(`reminder:${due.id}`, due.user_id, 'reminder')) {
      const result = await hub.push.send(due.user_id, reminderMessage(due.item, due.label, today));
      pushed += result.sent;
      reminders += 1;
    }
    await hub.agenda.markReminderSent(due.id, now);
  }

  let briefing = false;
  const hour = taipeiHour(now);
  if (hour >= 8 && hour < 11 && await hub.agenda.claimNotification(`briefing:${OWNER_ID}:${today}`, OWNER_ID, 'briefing')) {
    const summary = await morningBriefing(hub, OWNER_ID, now);
    const result = await hub.push.send(OWNER_ID, { title: summary.title, body: summary.body, url: '/overview', tag: `briefing-${today}` });
    pushed += result.sent;
    briefing = true;
  }
  // Water: one check per reminder slot; nothing is sent when the user is on pace.
  let water = false;
  if (hub.features?.water && hub.water) {
    const prefs = await hub.water.prefs(OWNER_ID);
    const slot = dueWaterSlot(prefs, now);
    if (slot && await hub.agenda.claimNotification(`water:${OWNER_ID}:${today}:${slot}`, OWNER_ID, 'water')) {
      const message = waterReminder(prefs, await hub.water.day(OWNER_ID, today), now);
      if (message) {
        const result = await hub.push.send(OWNER_ID, { ...message, url: '/', tag: `water-${today}` });
        pushed += result.sent;
        water = true;
      }
    }
  }
  // C2 retention: rows deleted more than 30 days ago are removed once a day.
  if ((hub.features?.server_history || hub.features?.memory) && hub.history && await hub.agenda.claimNotification(`purge:${today}`, OWNER_ID, 'purge')) {
    await hub.history.purge(now);
  }
  return { reminders, briefing, pushed, water };
}
