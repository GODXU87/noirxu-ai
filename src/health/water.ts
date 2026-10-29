// Daily water tracking and reminders. Pure functions here; storage in WaterService.
// Amounts are what the user reports; the daily goal is the user's own setting
// (default 2000 ml), a general habit target rather than medical advice.
import { waterWords } from '@/notify/phrasing';

export interface WaterPrefs {
  enabled: boolean;
  goal_ml: number;
  /** Taipei wall-clock window for reminders, HH:MM. */
  start: string;
  end: string;
  interval_hours: number;
}

export interface WaterEntry { at: string; ml: number }
export interface WaterDay { date: string; total_ml: number; entries: WaterEntry[] }

export const DEFAULT_WATER_PREFS: WaterPrefs = { enabled: true, goal_ml: 2000, start: '09:00', end: '21:00', interval_hours: 2 };
export const WATER_LIMITS = { minLog: 10, maxLog: 3000, minGoal: 500, maxGoal: 6000 } as const;

export type WaterCommand =
  | { action: 'status' }
  | { action: 'log'; ml: number; assumed?: string }
  | { action: 'goal'; ml: number }
  | { action: 'enable' | 'disable' | 'undo' }
  | { action: 'invalid'; message: string };

const CUPS: Array<[RegExp, number, string]> = [
  [/^(半杯)$/, 125, '以半杯 125 ml 計算'],
  [/^(一杯|1杯|一杯水)$/, 250, '以一杯 250 ml 計算'],
  [/^(兩杯|2杯)$/, 500, '以兩杯 500 ml 計算'],
  [/^(一瓶|1瓶)$/, 600, '以一瓶 600 ml 計算']
];

/** Parses what follows /喝水. */
export function parseWaterCommand(input: string): WaterCommand {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text || /^(進度|狀態|今天|查詢)$/.test(text)) return { action: 'status' };
  if (/^(開啟|打開|開|啟用|on)$/i.test(text)) return { action: 'enable' };
  if (/^(關閉|關掉|關|停止|停用|off)$/i.test(text)) return { action: 'disable' };
  if (/^(復原|撤銷|刪除上一筆|取消上一筆|undo)$/i.test(text)) return { action: 'undo' };

  const goal = /^目標\s*(\d+(?:\.\d+)?)\s*(ml|cc|毫升|l|公升)?$/i.exec(text);
  if (goal) {
    const ml = Math.round(Number(goal[1]) * (/^(l|公升)$/i.test(goal[2] ?? '') ? 1000 : 1));
    if (ml < WATER_LIMITS.minGoal || ml > WATER_LIMITS.maxGoal) return { action: 'invalid', message: `每日目標需在 ${WATER_LIMITS.minGoal}～${WATER_LIMITS.maxGoal} ml 之間。` };
    return { action: 'goal', ml };
  }

  for (const [re, ml, assumed] of CUPS) if (re.test(text)) return { action: 'log', ml, assumed };

  const amount = /^\+?(\d+(?:\.\d+)?)\s*(ml|cc|毫升|l|公升)?$/i.exec(text);
  if (amount) {
    const ml = Math.round(Number(amount[1]) * (/^(l|公升)$/i.test(amount[2] ?? '') ? 1000 : 1));
    if (ml < WATER_LIMITS.minLog || ml > WATER_LIMITS.maxLog) return { action: 'invalid', message: `一次記錄需在 ${WATER_LIMITS.minLog}～${WATER_LIMITS.maxLog} ml 之間。` };
    return { action: 'log', ml };
  }
  return { action: 'invalid', message: '看不懂這個數量。可以寫「/喝水 300」「/喝水 一杯」「/喝水 目標 2500」「/喝水 關閉」。' };
}

function minutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function taipeiClock(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** How much a steady pace through the reminder window would have reached by now. */
export function expectedByNow(prefs: WaterPrefs, now: Date): number {
  const start = minutes(prefs.start);
  const end = minutes(prefs.end);
  const clock = taipeiClock(now);
  if (end <= start || clock <= start) return 0;
  if (clock >= end) return prefs.goal_ml;
  return Math.round(prefs.goal_ml * (clock - start) / (end - start) / 10) * 10;
}

/** Reminder times for a day: start, start + interval, … up to end. */
export function waterSlots(prefs: WaterPrefs): string[] {
  const out: string[] = [];
  const step = Math.max(1, prefs.interval_hours) * 60;
  for (let t = minutes(prefs.start); t <= minutes(prefs.end); t += step) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

/** The slot that is due now (within the hour after its time), if any. */
export function dueWaterSlot(prefs: WaterPrefs, now: Date): string | null {
  if (!prefs.enabled) return null;
  const clock = taipeiClock(now);
  return waterSlots(prefs).find(slot => clock >= minutes(slot) && clock < minutes(slot) + 60) ?? null;
}

export function waterProgress(prefs: WaterPrefs, day: WaterDay, now: Date) {
  const expected = expectedByNow(prefs, now);
  return {
    date: day.date,
    total_ml: day.total_ml,
    goal_ml: prefs.goal_ml,
    percent: Math.min(100, Math.round(day.total_ml / prefs.goal_ml * 100)),
    remaining_ml: Math.max(0, prefs.goal_ml - day.total_ml),
    expected_ml: expected,
    behind_ml: Math.max(0, expected - day.total_ml),
    entries: day.entries,
    prefs
  };
}

/** Null when the user is on pace, so nobody gets nagged for no reason. */
export function waterReminder(prefs: WaterPrefs, day: WaterDay, now: Date): { title: string; body: string } | null {
  const p = waterProgress(prefs, day, now);
  if (p.behind_ml < 150 || p.remaining_ml === 0) return null;
  const suggest = Math.min(500, Math.max(200, Math.round(p.behind_ml / 50) * 50));
  // Wording varies by day and slot; a retry of the same slot keeps the same words.
  const slot = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(now);
  return waterWords({ total: p.total_ml, goal: p.goal_ml, behind: p.behind_ml, suggest, seed: `water:${slot}` });
}
