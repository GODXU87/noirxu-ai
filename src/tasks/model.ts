import { z } from 'zod';

// SASUKE tasks: one-off reminders, background jobs, recurring automations and conditional
// watches, run by the server scheduler (never by an open browser). Steps reuse the
// existing tools through the executor, so confirmations, idempotency keys and the audit log
// stay exactly as they are; a step that needs confirmation pauses the task in
// waiting_approval until the user decides.

export const TASK_STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'outcome_unknown', 'paused'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskKind = 'reminder' | 'background' | 'recurring' | 'conditional';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: z.iso.datetime() }),
  z.object({ type: z.literal('daily'), time: hhmm }),
  z.object({ type: z.literal('weekly'), time: hhmm, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  z.object({ type: z.literal('monthly'), time: hhmm, day: z.number().int().min(1).max(31) }),
  /** Every N minutes; at least 30 so a task can never hammer a source system. */
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(30).max(7 * 24 * 60) })
]);
export type TaskSchedule = z.infer<typeof scheduleSchema>;

export const conditionSchema = z.discriminatedUnion('type', [
  /** This month's Ledger spending (optionally one category) above an amount, in the Ledger currency. */
  z.object({ type: z.literal('ledger_month_expense_over'), amount: z.number().positive(), category: z.string().max(40).optional() })
]);
export type TaskCondition = z.infer<typeof conditionSchema>;

export const stepSchema = z.discriminatedUnion('type', [
  /** include_results: the body lists what the earlier tool steps of this run found. */
  z.object({ type: z.literal('notify'), title: z.string().min(1).max(80), body: z.string().max(200).default(''), include_results: z.boolean().default(false) }),
  /** only_if_important: notify only when the briefing has something urgent (otherwise the run is recorded, no push). */
  z.object({ type: z.literal('briefing'), which: z.enum(['morning', 'evening']), only_if_important: z.boolean().default(false) }),
  z.object({ type: z.literal('tool'), tool: z.string().min(3).max(80), input: z.record(z.string(), z.unknown()).default({}) })
]);
export type TaskStep = z.input<typeof stepSchema>;

export interface StepResult { step: number; type: TaskStep['type']; tool?: string; status: 'ok' | 'error' | 'waiting_approval' | 'skipped'; summary: string; proposal_id?: string; delivery_key?: string; delivery_status?: string; delivery_summary?: string }
export interface TaskRun { id: string; slot: string; started_at: string; finished_at?: string; status: 'completed' | 'failed' | 'waiting_approval' | 'outcome_unknown' | 'skipped' | 'not_met'; steps: StepResult[]; error?: string; late_minutes?: number; tool_calls?: number; llm_tokens?: number }

export interface Task {
  id: string;
  user_id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  schedule: TaskSchedule;
  condition?: TaskCondition;
  steps: TaskStep[];
  /** Next time the scheduler should act (UTC ISO), or null when finished. */
  next_at: string | null;
  created_at: string;
  updated_at: string;
  /** How the task was described (original words), for the user's reference. */
  source_text?: string;
  attempts: number;
  lease_until?: string;
  /** Token of the run that holds the lease. */
  claim?: string;
  last_slot?: string;
  waiting_proposal?: string;
  last_error?: string;
  /** Condition already notified for this period (e.g. "2026-10"), so it fires once. */
  condition_fired_for?: string;
  /** Pending delivery keys survive bounded run-history retention. */
  pending_delivery_keys?: string[];
  runs: TaskRun[];
}

export const MAX_RUNS_KEPT = 20;
/** A recurring slot missed by more than this is skipped rather than run late. */
export const MISSED_SLOT_MS = 6 * 60 * 60_000;
export const LEASE_MS = 2 * 60_000;
/** A single tool step longer than this is stopped (a Vercel request cannot run forever). */
export const STEP_TIMEOUT_MS = 45_000;

function taipeiParts(at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, weekday: 'short' }).formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

function instant(date: string, time: string) { return new Date(`${date}T${time}:00+08:00`); }

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first run strictly after `after` (UTC), or null for a one-off that has passed. */
export function nextRun(schedule: TaskSchedule, after: Date): Date | null {
  if (schedule.type === 'once') { const at = new Date(schedule.at); return at.getTime() > after.getTime() ? at : null; }
  if (schedule.type === 'interval') return new Date(after.getTime() + schedule.minutes * 60_000);
  const { date } = taipeiParts(after);
  for (let i = 0; i <= 62; i += 1) {
    const day = addDays(date, i);
    const candidate = instant(day, schedule.time);
    if (candidate.getTime() <= after.getTime()) continue;
    if (schedule.type === 'daily') return candidate;
    if (schedule.type === 'weekly' && schedule.weekdays.includes(taipeiParts(candidate).weekday)) return candidate;
    if (schedule.type === 'monthly') {
      const [y, m] = day.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      // Day 31 in a 30-day month runs on the last day.
      if (Number(day.slice(8)) === Math.min(schedule.day, last)) return candidate;
    }
  }
  return null;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.type) {
    case 'once': return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(schedule.at));
    case 'daily': return `每天 ${schedule.time}`;
    case 'weekly': return `每週${schedule.weekdays.map(d => WEEKDAY[d]).join('、')} ${schedule.time}`;
    case 'monthly': return `每月 ${schedule.day} 日 ${schedule.time}`;
    case 'interval': return schedule.minutes % 60 === 0 ? `每 ${schedule.minutes / 60} 小時` : `每 ${schedule.minutes} 分鐘`;
  }
}
