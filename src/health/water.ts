// Daily water tracking and reminders. Pure functions here; storage in WaterService.
// Amounts are what the user reports. Targets are editable starting estimates for healthy
// adults, not medical advice; with a doctor's fluid restriction the automatic adjustments
// and nudges are switched off and only the user's own number is used.

export type Sweat = 'low' | 'medium' | 'high' | 'unknown';
export type Intensity = 'light' | 'moderate' | 'hard';

export interface WaterProfile { age: number; weight_kg: number; regular_exercise: boolean }
export interface WeeklyExercise { weekday: number; start: string; minutes: number; intensity: Intensity }

export interface WaterPrefs {
  enabled: boolean;
  /** Everyday (non-exercise) target. */
  goal_ml: number;
  /** Taipei wall-clock window for reminders, HH:MM. */
  start: string;
  end: string;
  interval_hours: number;
  profile?: WaterProfile | null;
  weekly_exercise?: WeeklyExercise[];
  /** Do-not-disturb window (may cross midnight), HH:MM. */
  quiet_start?: string | null;
  quiet_end?: string | null;
  /** No reminders until this instant (ISO). */
  paused_until?: string | null;
  /** A doctor's fluid limit: use goal_ml as is, no exercise extras, no catch-up nudges. */
  medical_restriction?: boolean;
}

export interface WaterEntry { at: string; ml: number }
export interface DayExercise { minutes: number; sweat: Sweat; end?: string | null; source: 'confirmed' | 'none' }
export interface WaterDay { date: string; total_ml: number; entries: WaterEntry[]; exercise?: DayExercise | null }

// Starting point for this owner (27, 74 kg, regular exercise): about 2,500 ml on a
// normal day. Every value is editable.
export const DEFAULT_WATER_PREFS: WaterPrefs = {
  enabled: true, goal_ml: 2500, start: '09:00', end: '21:00', interval_hours: 2,
  profile: { age: 27, weight_kg: 74, regular_exercise: true },
  weekly_exercise: [], quiet_start: '22:30', quiet_end: '08:00', paused_until: null, medical_restriction: false
};
export const WATER_LIMITS = { minLog: 10, maxLog: 3000, minGoal: 500, maxGoal: 6000 } as const;
/** Largest single amount ever suggested; large boluses are what to avoid. */
export const MAX_SUGGESTION_ML = 500;

/** Extra fluid per 30 minutes of exercise by sweat level (90 min: +600 / +900 / +1,200). */
const EXTRA_PER_30: Record<Exclude<Sweat, 'unknown'>, number> = { low: 200, medium: 300, high: 400 };
const INTENSITY_SWEAT: Record<Intensity, Exclude<Sweat, 'unknown'>> = { light: 'low', moderate: 'medium', hard: 'high' };

export type WaterCommand =
  | { action: 'status' }
  | { action: 'log'; ml: number; assumed?: string }
  | { action: 'goal'; ml: number }
  | { action: 'enable' | 'disable' | 'undo' | 'resume' | 'no_exercise' }
  | { action: 'exercise'; minutes: number; sweat: Sweat }
  | { action: 'pause'; minutes: number }
  | { action: 'quiet'; start: string; end: string }
  | { action: 'profile'; age: number; weight_kg: number }
  | { action: 'invalid'; message: string };

const CUPS: Array<[RegExp, number, string]> = [
  [/^(半杯)$/, 125, '以半杯 125 ml 計算'],
  [/^(一杯|1杯|一杯水)$/, 250, '以一杯 250 ml 計算'],
  [/^(兩杯|2杯)$/, 500, '以兩杯 500 ml 計算'],
  [/^(一瓶|1瓶)$/, 600, '以一瓶 600 ml 計算']
];

const pad = (n: number) => String(n).padStart(2, '0');
function hhmm(h: number, m = 0) { return h < 24 && m < 60 ? `${pad(h)}:${pad(m)}` : null; }

/** Parses what follows /喝水. */
export function parseWaterCommand(input: string): WaterCommand {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text || /^(進度|狀態|今天|查詢)$/.test(text)) return { action: 'status' };
  if (/^(開啟|打開|開|啟用|on)$/i.test(text)) return { action: 'enable' };
  if (/^(關閉|關掉|關|停止|停用|off)$/i.test(text)) return { action: 'disable' };
  if (/^(復原|撤銷|刪除上一筆|取消上一筆|undo)$/i.test(text)) return { action: 'undo' };
  if (/^(恢復|恢復提醒|繼續提醒)$/.test(text)) return { action: 'resume' };
  if (/^(今天)?(沒|沒有|不)運動$/.test(text)) return { action: 'no_exercise' };

  let m = /^運動\s*(\d{1,3})\s*(分鐘|分|min)?\s*(大汗|很多汗|爆汗|中等|普通|少汗|微汗|一點汗)?$/.exec(text);
  if (m) {
    const minutes = Number(m[1]);
    if (minutes < 5 || minutes > 300) return { action: 'invalid', message: '運動時間需在 5～300 分鐘之間。' };
    const sweat: Sweat = !m[3] ? 'unknown' : /大汗|很多汗|爆汗/.test(m[3]) ? 'high' : /中等|普通/.test(m[3]) ? 'medium' : 'low';
    return { action: 'exercise', minutes, sweat };
  }
  m = /^暫停\s*(\d{1,2})\s*(小時|個小時|h)$/i.exec(text);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 24 ? { action: 'pause', minutes: Number(m[1]) * 60 } : { action: 'invalid', message: '暫停時間需在 1～24 小時之間。' };
  if (/^暫停(到明天|今天)$/.test(text)) return { action: 'pause', minutes: -1 };
  m = /^免打擾\s*(\d{1,2})[:：](\d{2})\s*[-~～到至]\s*(\d{1,2})[:：](\d{2})$/.exec(text);
  if (m) {
    const start = hhmm(Number(m[1]), Number(m[2])); const end = hhmm(Number(m[3]), Number(m[4]));
    return start && end ? { action: 'quiet', start, end } : { action: 'invalid', message: '時間格式需為 22:30-08:00。' };
  }
  m = /^個人(資料)?\s*(\d{2})\s*(歲)?\s*(\d{2,3}(?:\.\d)?)\s*(公斤|kg)?$/i.exec(text);
  if (m) {
    const age = Number(m[2]); const weight = Number(m[4]);
    if (age < 16 || age > 90 || weight < 35 || weight > 200) return { action: 'invalid', message: '年齡或體重超出可估算的範圍，請直接用「/喝水 目標 數字」設定。' };
    return { action: 'profile', age, weight_kg: weight };
  }

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
  return { action: 'invalid', message: '看不懂這個指令。可以寫「/喝水 300」「/喝水 運動 90 大汗」「/喝水 今天沒運動」「/喝水 暫停 2 小時」「/喝水 免打擾 22:30-08:00」「/喝水 目標 2500」。' };
}

/** Starting everyday target from a profile (~34 ml/kg, rounded to 100 ml). Editable. */
export function suggestedBase(profile: WaterProfile) {
  return Math.min(WATER_LIMITS.maxGoal, Math.max(1500, Math.round(profile.weight_kg * 34 / 100) * 100));
}

function minutes(hhmmText: string) {
  const [h, m] = hhmmText.split(':').map(Number);
  return h * 60 + m;
}

export function taipeiClock(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

function taipeiWeekday(date: string) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** Today's exercise: what the user confirmed, otherwise the weekly plan (marked as planned). */
export function todaysExercise(prefs: WaterPrefs, day: WaterDay): { minutes: number; sweat: Sweat; status: 'confirmed' | 'none' | 'planned' | 'unknown'; end: string | null } {
  if (day.exercise?.source === 'none') return { minutes: 0, sweat: 'unknown', status: 'none', end: null };
  if (day.exercise?.source === 'confirmed') return { minutes: day.exercise.minutes, sweat: day.exercise.sweat, status: 'confirmed', end: day.exercise.end ?? null };
  const planned = (prefs.weekly_exercise ?? []).filter(e => e.weekday === taipeiWeekday(day.date));
  if (planned.length) {
    const total = planned.reduce((s, e) => s + e.minutes, 0);
    const last = planned.reduce((a, b) => (minutes(a.start) + a.minutes >= minutes(b.start) + b.minutes ? a : b));
    const endMin = minutes(last.start) + last.minutes;
    return { minutes: total, sweat: INTENSITY_SWEAT[last.intensity], status: 'planned', end: hhmm(Math.floor(endMin / 60), endMin % 60) };
  }
  return { minutes: 0, sweat: 'unknown', status: 'unknown', end: null };
}

/** Today's target with its basis. Exercise with unknown sweat gives a range, not a fake exact number. */
export function dailyTarget(prefs: WaterPrefs, day: WaterDay) {
  const base = prefs.goal_ml;
  const exercise = todaysExercise(prefs, day);
  const notes: string[] = [];
  if (prefs.medical_restriction) {
    notes.push('依醫囑限水：只使用你設定的目標，不自動增加。');
    return { target_ml: base, base_ml: base, extra: { min: 0, max: 0, used: 0 }, exercise, notes };
  }
  let extra = { min: 0, max: 0, used: 0 };
  if (exercise.minutes > 0) {
    const blocks = exercise.minutes / 30;
    if (exercise.sweat === 'unknown') {
      extra = { min: Math.round(blocks * EXTRA_PER_30.low / 50) * 50, max: Math.round(blocks * EXTRA_PER_30.high / 50) * 50, used: Math.round(blocks * EXTRA_PER_30.medium / 50) * 50 };
      notes.push(`運動 ${exercise.minutes} 分鐘，出汗量未知：估計多需要 ${extra.min}～${extra.max} ml，先以中間值 ${extra.used} ml 計。告訴我流汗程度會更準。`);
    } else {
      const v = Math.round(blocks * EXTRA_PER_30[exercise.sweat] / 50) * 50;
      extra = { min: v, max: v, used: v };
      notes.push(`運動 ${exercise.minutes} 分鐘（${exercise.sweat === 'high' ? '大量出汗' : exercise.sweat === 'medium' ? '中等出汗' : '少量出汗'}）：估計多需要 ${v} ml。`);
    }
    if (exercise.status === 'planned') notes.push('這是依每週排程估計，今天還沒確認有沒有運動。');
  }
  return { target_ml: base + extra.used, base_ml: base, extra, exercise, notes };
}

/** How much a steady pace through the reminder window would have reached by now. */
export function expectedByNow(prefs: WaterPrefs, now: Date, target = prefs.goal_ml): number {
  const start = minutes(prefs.start);
  const end = minutes(prefs.end);
  const clock = taipeiClock(now);
  if (end <= start || clock <= start) return 0;
  if (clock >= end) return target;
  return Math.round(target * (clock - start) / (end - start) / 10) * 10;
}

/** Reminder times for a day: start, start + interval, … up to end. */
export function waterSlots(prefs: WaterPrefs): string[] {
  const out: string[] = [];
  const step = Math.max(1, prefs.interval_hours) * 60;
  for (let t = minutes(prefs.start); t <= minutes(prefs.end); t += step) out.push(hhmm(Math.floor(t / 60), t % 60)!);
  return out;
}

export function inQuietHours(prefs: WaterPrefs, now: Date) {
  if (!prefs.quiet_start || !prefs.quiet_end) return false;
  const c = taipeiClock(now); const s = minutes(prefs.quiet_start); const e = minutes(prefs.quiet_end);
  return s <= e ? c >= s && c < e : c >= s || c < e;
}

export function isPaused(prefs: WaterPrefs, now: Date) {
  return Boolean(prefs.paused_until && new Date(prefs.paused_until).getTime() > now.getTime());
}

/** The slot that is due now (within the hour after its time), if any. */
export function dueWaterSlot(prefs: WaterPrefs, now: Date): string | null {
  if (!prefs.enabled || isPaused(prefs, now) || inQuietHours(prefs, now)) return null;
  const clock = taipeiClock(now);
  return waterSlots(prefs).find(slot => clock >= minutes(slot) && clock < minutes(slot) + 60) ?? null;
}

export function waterProgress(prefs: WaterPrefs, day: WaterDay, now: Date) {
  const plan = dailyTarget(prefs, day);
  const expected = expectedByNow(prefs, now, plan.target_ml);
  return {
    date: day.date,
    total_ml: day.total_ml,
    goal_ml: plan.target_ml,
    base_goal_ml: plan.base_ml,
    exercise_extra: plan.extra,
    exercise: plan.exercise,
    basis: plan.notes,
    percent: Math.min(100, Math.round(day.total_ml / plan.target_ml * 100)),
    remaining_ml: Math.max(0, plan.target_ml - day.total_ml),
    expected_ml: expected,
    behind_ml: Math.max(0, expected - day.total_ml),
    paused: isPaused(prefs, now),
    quiet: inQuietHours(prefs, now),
    entries: day.entries,
    prefs
  };
}

/** Suggest a sip, never a bolus: 200–500 ml whatever the deficit. */
function suggestion(behind: number) {
  return Math.min(MAX_SUGGESTION_ML, Math.max(200, Math.round(behind / 2 / 50) * 50));
}

/** Null when the user is on pace (or restricted), so nobody gets nagged for no reason. */
export function waterReminder(prefs: WaterPrefs, day: WaterDay, now: Date): { title: string; body: string } | null {
  if (prefs.medical_restriction) return null;
  const p = waterProgress(prefs, day, now);
  if (p.behind_ml < 150 || p.remaining_ml === 0) return null;
  const late = taipeiClock(now) >= minutes(prefs.end) - 90;
  const fmt = (n: number) => n.toLocaleString('en-US');
  return {
    title: '該喝水了',
    body: late
      ? `今天 ${fmt(p.total_ml)} / ${fmt(p.goal_ml)} ml。睡前不必一次補足，先喝 ${suggestion(p.behind_ml)} ml 就好，其餘明天照常喝。`
      : `今天 ${fmt(p.total_ml)} / ${fmt(p.goal_ml)} ml，照進度現在應到 ${fmt(p.expected_ml)} ml。建議先喝 ${suggestion(p.behind_ml)} ml，分次慢慢喝。`
  };
}

/** One reminder about 15 minutes after a known exercise end time. */
export function postExerciseReminder(prefs: WaterPrefs, day: WaterDay, now: Date): { key: string; title: string; body: string } | null {
  if (!prefs.enabled || prefs.medical_restriction || isPaused(prefs, now) || inQuietHours(prefs, now)) return null;
  const ex = todaysExercise(prefs, day);
  if (!ex.end || ex.minutes <= 0) return null;
  const due = minutes(ex.end) + 15; const clock = taipeiClock(now);
  if (clock < due || clock >= due + 60) return null;
  const plan = dailyTarget(prefs, day);
  return {
    key: `water-post-exercise:${day.date}`,
    title: '運動後補水',
    body: `${ex.status === 'planned' ? '如果今天照排程運動了，' : ''}接下來一小時分次喝 ${Math.min(MAX_SUGGESTION_ML, Math.max(250, plan.extra.used / 2))} ml 左右，不用一次喝完。`
  };
}
