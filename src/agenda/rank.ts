export interface AgendaItem {
  id: string;
  user_id: string;
  title: string;
  notes: string;
  due_date: string | null;
  due_time: string | null;
  importance: 1 | 2 | 3;
  status: 'open' | 'done' | 'cancelled';
  source: string;
  created_at: string;
  updated_at: string;
}

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_LABEL: Record<Priority, string> = { urgent: '緊急', high: '重要', normal: '一般', low: '不急' };
export const IMPORTANCE_LABEL: Record<1 | 2 | 3, string> = { 1: '低', 2: '中', 3: '高' };

function dayNumber(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function daysUntil(date: string | null, today: string): number | null {
  return date ? dayNumber(date) - dayNumber(today) : null;
}

/** Higher score = do first. Importance carries most weight; nearness and overdue raise it. */
export function priorityScore(item: Pick<AgendaItem, 'importance' | 'due_date'>, today: string): number {
  const days = daysUntil(item.due_date, today);
  let urgency = 0;
  if (days !== null) {
    if (days < 0) urgency = 35;
    else if (days === 0) urgency = 30;
    else if (days === 1) urgency = 22;
    else if (days <= 3) urgency = 14;
    else if (days <= 7) urgency = 7;
    else if (days <= 14) urgency = 3;
  }
  return item.importance * 12 + urgency;
}

export function priorityOf(item: Pick<AgendaItem, 'importance' | 'due_date'>, today: string): Priority {
  const score = priorityScore(item, today);
  if (score >= 50) return 'urgent';
  if (score >= 36) return 'high';
  if (score >= 20) return 'normal';
  return 'low';
}

export function rankItems<T extends Pick<AgendaItem, 'importance' | 'due_date' | 'due_time' | 'created_at'>>(items: T[], today: string): T[] {
  return [...items].sort((a, b) =>
    priorityScore(b, today) - priorityScore(a, today)
    || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999'))
    || String(a.due_time ?? '99').localeCompare(String(b.due_time ?? '99'))
    || a.created_at.localeCompare(b.created_at));
}

/** Taipei wall-clock time to a UTC instant. */
export function taipeiInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`);
}

/**
 * Default reminders: the evening before (20:00), the morning of (08:30), and one hour
 * before a timed item. Reminders already in the past are dropped.
 */
/**
 * Extra advance notices for an agenda item (not for explicit reminders, which fire once at
 * the time the user asked). Each kind can be switched off; there is no blanket "3 days
 * before" for important items any more — that sent many notices at once.
 */
export interface ReminderPrefs {
  /** 20:00 the evening before. */
  day_before: boolean;
  /** 08:30 on the day, for items without a time (timed items get the lead time instead). */
  morning_of: boolean;
  /** Minutes before a timed item; null = off. */
  lead_minutes: number | null;
}
export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { day_before: true, morning_of: true, lead_minutes: 60 };

export function reminderSchedule(item: Pick<AgendaItem, 'due_date' | 'due_time' | 'importance'>, now: Date, prefs: ReminderPrefs = DEFAULT_REMINDER_PREFS): Array<{ at: Date; label: string }> {
  if (!item.due_date) return [];
  const [y, m, d] = item.due_date.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const prevDate = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  const out: Array<{ at: Date; label: string }> = [];
  if (prefs.day_before) out.push({ at: taipeiInstant(prevDate, '20:00'), label: '明天' });
  if (item.due_time) {
    if (prefs.lead_minutes) out.push({ at: new Date(taipeiInstant(item.due_date, item.due_time).getTime() - prefs.lead_minutes * 60_000), label: prefs.lead_minutes >= 60 && prefs.lead_minutes % 60 === 0 ? `${prefs.lead_minutes / 60} 小時後` : `${prefs.lead_minutes} 分鐘後` });
  } else if (prefs.morning_of) {
    out.push({ at: taipeiInstant(item.due_date, '08:30'), label: '今天' });
  }
  return out.filter(r => r.at.getTime() > now.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
}
