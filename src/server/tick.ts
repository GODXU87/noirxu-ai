import 'server-only';
import { buildBriefing, reminderMessage } from '@/agenda/briefing';
import { taipeiDate } from '@/lib/dates';
import { dueWaterSlot, waterReminder } from '@/health/water';
import type { PushMessage } from '@/push/service';
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

  for (const due of await hub.agenda.dueReminders(now)) {
    const record = await count(`reminder:${due.id}`, 'reminder', due.user_id, reminderMessage(due.item, due.label, today), new Date(Date.parse(due.remind_at) + 12 * 60 * 60_000));
    if (record.status === 'provider_accepted') reminders += 1;
    // Only finished deliveries leave the due list; failed attempts are retried next run.
    if (record.status === 'provider_accepted' || record.status === 'failed' || record.status === 'expired') await hub.agenda.markReminderSent(due.id, now);
  }

  let briefing = false;
  const hour = taipeiHour(now);
  const briefingKey = `briefing:${OWNER_ID}:${today}`;
  const briefingRecord = await hub.delivery.get(briefingKey);
  if (hour >= 8 && hour < 11 && !(briefingRecord && ['provider_accepted', 'failed', 'expired'].includes(briefingRecord.status))) {
    let message: PushMessage;
    if (briefingRecord) message = briefingRecord.message;
    else {
      const summary = await morningBriefing(hub, OWNER_ID, now);
      message = { title: summary.title, body: summary.body, url: '/overview', tag: `briefing-${today}` };
    }
    const record = await count(briefingKey, 'briefing', OWNER_ID, message, taipeiInstant(today, '11:00'));
    briefing = record.status === 'provider_accepted';
  }

  // Water: one notification per reminder slot, only when the user is behind pace.
  let water = false;
  if (hub.features?.water && hub.water) {
    const prefs = await hub.water.prefs(OWNER_ID);
    const slot = dueWaterSlot(prefs, now);
    if (slot) {
      const key = `water:${OWNER_ID}:${today}:${slot}`;
      const existing = await hub.delivery.get(key);
      const message = existing ? existing.message : waterReminder(prefs, await hub.water.day(OWNER_ID, today), now);
      if (message) {
        const record = await count(key, 'water', OWNER_ID, { ...message, url: '/', tag: `water-${today}` }, new Date(taipeiInstant(today, slot).getTime() + 60 * 60_000));
        water = record.status === 'provider_accepted';
      }
    }
  }
  return { reminders, briefing, pushed, water };
}
