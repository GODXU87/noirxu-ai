import type { GarminActivity, GarminDaily, GarminRecovery, GarminSleep } from './adapter';

// Body-status analysis from Garmin data, by fixed rules (no AI model). Every statement is tied
// to a number and its baseline (your own 7-night average, Garmin's balanced HRV range, your
// 7-day resting heart rate). It is training guidance, not a medical judgement: with several
// low signals it says so and points to a doctor if it persists.

export interface HealthProfile {
  /** Weekday (0 = Sunday) → planned session. The user's stated routine; editable later. */
  plan: Record<string, string>;
  goal: string | null;
}
export const HEALTH_PROFILE_KEY = 'health:profile';
export const DEFAULT_PROFILE: HealthProfile = { plan: { 0: '健身', 1: '羽球', 2: '健身', 3: '羽球', 4: '健身', 5: '羽球', 6: '跑步耐力' }, goal: 'HYROX' };

/** Typical session length for the hydration estimate (minutes). */
const SESSION_MIN: Record<string, number> = { 羽球: 90, 健身: 60, 跑步耐力: 60 };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export type Tone = 'good' | 'watch' | 'low';
export interface Signal { key: string; tone: Tone; text: string }
export interface Insight {
  when: 'morning' | 'evening';
  date: string;
  headline: string;
  lines: string[];
  suggestion: string;
  readiness: 'go' | 'moderate' | 'easy' | null;
  hydration_ml: number | null;
  signals: Signal[];
  /** One short line for the lock screen. */
  push_line: string;
  gaps: string[];
}

export function hm(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小時 ${m} 分` : `${m} 分`;
}
const short = (sec: number) => `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}m`;
const round50 = (ml: number) => Math.round(ml / 50) * 50;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clockOf = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const weekdayOf = (date: string) => new Date(`${date}T12:00:00+08:00`).getUTCDay();

/** How intense today's planned session should be, per readiness. */
function sessionAdvice(session: string | undefined, readiness: Insight['readiness']) {
  if (!session) return readiness === 'easy' ? '今天以恢復為主，散步或伸展就好。' : '今天沒有排定訓練，想動的話中低強度即可。';
  const lighter: Record<string, string> = {
    羽球: '少打一兩局，避免連續高強度對抗，局間多補水',
    健身: '重量降到平常約八成、減一組，動作做乾淨',
    跑步耐力: '改成輕鬆的 Zone 2 慢跑，距離縮短三成'
  };
  if (readiness === 'go') return `今天${session}照計畫進行，狀態允許安排高強度${session === '跑步耐力' ? '或 HYROX 節奏段' : ''}。`;
  if (readiness === 'moderate') return `今天${session}可以照常，但收一點：${lighter[session] ?? '強度降一級'}。`;
  return `建議今天${session}改成輕量或恢復課（伸展、活動度 20–30 分鐘），把高強度留到恢復後。`;
}

export function morningInsight(input: { date: string; sleep: GarminSleep | null; history: GarminSleep[]; recovery: GarminRecovery | null; profile: HealthProfile; waterGoalMl: number }): Insight {
  const signals: Signal[] = [];
  const lines: string[] = [];
  const gaps: string[] = [];
  const { sleep, recovery } = input;
  const past = input.history.filter(n => n.date < input.date && n.duration_s).map(n => n.duration_s!) ;
  const base = past.length >= 3 ? avg(past.slice(-7)) : null;

  if (sleep?.duration_s) {
    const diff = base !== null ? Math.round((sleep.duration_s - base) / 60) : null;
    const tone: Tone = sleep.duration_s < 6 * 3600 || (diff !== null && diff <= -60) ? 'low' : sleep.duration_s >= 7 * 3600 && (diff === null || diff > -30) ? 'good' : 'watch';
    signals.push({ key: 'sleep', tone, text: `睡 ${hm(sleep.duration_s)}` });
    const vs = base !== null && diff !== null ? `（近 ${Math.min(7, past.length)} 晚平均 ${hm(base)}，${diff >= 0 ? `多 ${diff}` : `少 ${-diff}`} 分）` : '（歷史資料不足，暫不比較平均）';
    const stages = [sleep.deep_s !== null ? `深睡 ${hm(sleep.deep_s)}` : null, sleep.rem_s !== null ? `REM ${hm(sleep.rem_s)}` : null, sleep.awake_count !== null ? `醒來 ${sleep.awake_count} 次` : null].filter(Boolean).join('、');
    const window = sleep.start_local && sleep.end_local ? `${sleep.start_local}–${sleep.end_local}，` : '';
    lines.push(`睡眠：${window}${hm(sleep.duration_s)}${vs}${stages ? `；${stages}` : ''}。`);
  } else gaps.push('昨晚睡眠（手錶可能還沒同步）');

  if (recovery) {
    const parts: string[] = [];
    const hrv = recovery.hrv_last_night_avg;
    if (hrv !== null) {
      const low = recovery.hrv_balanced_low;
      const high = recovery.hrv_balanced_high;
      const status = (recovery.hrv_status ?? '').toUpperCase();
      const tone: Tone = status === 'BALANCED' || (low !== null && hrv >= low) ? 'good' : status === 'UNBALANCED' ? 'watch' : status ? 'low' : low !== null && hrv < low ? 'low' : 'watch';
      signals.push({ key: 'hrv', tone, text: `HRV ${tone === 'good' ? '平衡' : tone === 'watch' ? '偏離' : '偏低'}` });
      parts.push(`HRV ${hrv}${low !== null && high !== null ? `（你的平衡範圍 ${low}–${high}）` : recovery.hrv_weekly_avg !== null ? `（7 日平均 ${recovery.hrv_weekly_avg}）` : ''}`);
    } else gaps.push('HRV');
    const bb = recovery.body_battery_at_wake;
    if (bb !== null) {
      const tone: Tone = bb >= 70 ? 'good' : bb >= 40 ? 'watch' : 'low';
      signals.push({ key: 'body_battery', tone, text: `Body Battery ${bb}` });
      parts.push(`起床 Body Battery ${bb}`);
    } else gaps.push('起床 Body Battery');
    const rhr = recovery.resting_hr;
    const rhr7 = recovery.resting_hr_7d_avg;
    if (rhr !== null) {
      const up = rhr7 !== null ? rhr - rhr7 : 0;
      const tone: Tone = up >= 5 ? 'low' : up >= 3 ? 'watch' : 'good';
      signals.push({ key: 'resting_hr', tone, text: `靜息心率 ${rhr}` });
      parts.push(`靜息心率 ${rhr}${rhr7 !== null ? `（7 日平均 ${rhr7}${up >= 3 ? `，高 ${up}` : ''}）` : ''}`);
    }
    if (parts.length) lines.push(`恢復：${parts.join('；')}。`);
  } else gaps.push('恢復指標');

  const lows = signals.filter(s => s.tone === 'low').length;
  const watches = signals.filter(s => s.tone === 'watch').length;
  const readiness: Insight['readiness'] = signals.length === 0 ? null : lows >= 2 ? 'easy' : lows === 1 || watches >= 2 ? 'moderate' : 'go';
  const session = input.profile.plan[String(weekdayOf(input.date))];
  const suggestion = readiness === null ? '今天的 Garmin 資料還沒進來，等手錶同步後再判斷。' : sessionAdvice(session, readiness);
  const planned = session ? SESSION_MIN[session] ?? 60 : 0;
  const hydration = round50(input.waterGoalMl + planned * 8.3);
  lines.push(`今天（週${WEEKDAY[weekdayOf(input.date)]}${session ? `，${session}日` : ''}）：${suggestion}`);
  lines.push(`補水：今天約 ${hydration.toLocaleString('en-US')} ml${planned ? `（日常目標加上訓練約 ${round50(planned * 8.3)} ml，運動中每 15–20 分鐘喝幾口）` : ''}。`);
  if (lows >= 2) lines.push('以上是手錶趨勢，不是醫療判斷；若持續幾天偏低或身體不適，請諮詢醫師。');

  const headline = readiness === 'go' ? '狀態不錯，今天可以照計畫練。' : readiness === 'moderate' ? '恢復普通，今天練但收一點。' : readiness === 'easy' ? '身體還在恢復，今天以輕量為主。' : 'Garmin 還沒有今天的完整資料。';
  const pushParts = [sleep?.duration_s ? `睡 ${short(sleep.duration_s)}` : null, signals.find(s => s.key === 'hrv')?.text, recovery?.body_battery_at_wake != null ? `BB ${recovery.body_battery_at_wake}` : null].filter(Boolean);
  const pushAdvice = readiness === 'go' ? `${session ?? '訓練'}照計畫` : readiness === 'moderate' ? `${session ?? '訓練'}收一點` : readiness === 'easy' ? '今天以恢復為主' : '';
  return { when: 'morning', date: input.date, headline, lines, suggestion, readiness, hydration_ml: hydration, signals, push_line: [pushParts.join(' · '), pushAdvice].filter(Boolean).join(' → '), gaps };
}

export function eveningInsight(input: { date: string; daily: GarminDaily | null; activities: GarminActivity[]; sleepToday: GarminSleep | null; profile: HealthProfile; waterGoalMl: number; waterTodayMl: number | null }): Insight {
  const lines: string[] = [];
  const gaps: string[] = [];
  const signals: Signal[] = [];
  const d = input.daily;
  if (d) {
    const parts: string[] = [];
    if (d.steps !== null) parts.push(`步數 ${d.steps.toLocaleString('en-US')}${d.step_goal ? `（目標 ${d.step_goal.toLocaleString('en-US')}，${Math.round((d.steps / d.step_goal) * 100)}%）` : ''}`);
    if (d.moderate_minutes !== null || d.vigorous_minutes !== null) parts.push(`強度分鐘 中 ${d.moderate_minutes ?? 0}／高 ${d.vigorous_minutes ?? 0}`);
    if (d.stress_avg !== null) { parts.push(`平均壓力 ${d.stress_avg}`); signals.push({ key: 'stress', tone: d.stress_avg >= 50 ? 'low' : d.stress_avg >= 35 ? 'watch' : 'good', text: `壓力 ${d.stress_avg}` }); }
    if (d.body_battery_latest !== null) { parts.push(`Body Battery 現在 ${d.body_battery_latest}${d.body_battery_low !== null ? `（今天最低 ${d.body_battery_low}）` : ''}`); signals.push({ key: 'body_battery', tone: d.body_battery_latest >= 40 ? 'good' : d.body_battery_latest >= 20 ? 'watch' : 'low', text: `BB ${d.body_battery_latest}` }); }
    if (parts.length) lines.push(`今天：${parts.join('、')}。`);
  } else gaps.push('今天的活動摘要');

  const minutes = Math.round(input.activities.reduce((a, x) => a + x.duration_s, 0) / 60);
  if (input.activities.length) {
    lines.push(`運動：${input.activities.map(a => `${a.name || a.type} ${Math.round(a.duration_s / 60)} 分${a.avg_hr ? `（平均心率 ${a.avg_hr}）` : ''}${a.training_load ? `，負荷 ${Math.round(a.training_load)}` : ''}`).join('；')}。`);
  } else lines.push('運動：今天沒有 Garmin 運動紀錄。');

  const tomorrow = new Date(`${input.date}T12:00:00+08:00`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextSession = input.profile.plan[String(tomorrow.getUTCDay())];
  const tired = signals.some(s => s.tone === 'low');
  const bedtime = input.sleepToday?.tonight_bedtime;
  const sleepLine = bedtime ? `Garmin 建議今晚 ${clockOf(bedtime.start_min)}–${clockOf(bedtime.end_min)} 上床` : '今晚盡量睡滿 7–8 小時';
  const suggestion = `${tired ? '今天消耗偏大，' : ''}${sleepLine}${nextSession ? `，明天（週${WEEKDAY[tomorrow.getUTCDay()]}）是${nextSession}日` : ''}。`;
  lines.push(`今晚：${suggestion}`);

  const hydration = round50(input.waterGoalMl + minutes * 8.3);
  const drank = input.waterTodayMl ?? d?.hydration_ml ?? null;
  lines.push(`補水：今天建議約 ${hydration.toLocaleString('en-US')} ml${minutes ? `（含運動 ${minutes} 分）` : ''}${drank !== null ? `，目前記錄 ${Math.round(drank).toLocaleString('en-US')} ml${drank < hydration ? `，睡前可再補 ${Math.min(500, round50(hydration - drank)).toLocaleString('en-US')} ml，不要一次灌完` : ''}` : ''}。`);

  const headline = tired ? '今天消耗不小，今晚好好恢復。' : input.activities.length ? '今天練得紮實，收尾做好就好。' : '今天比較輕鬆，維持節奏。';
  const push = [d?.steps != null ? `${d.steps.toLocaleString('en-US')} 步` : null, minutes ? `運動 ${minutes} 分` : null, d?.body_battery_latest != null ? `BB ${d.body_battery_latest}` : null].filter(Boolean).join(' · ');
  return { when: 'evening', date: input.date, headline, lines, suggestion, readiness: null, hydration_ml: hydration, signals, push_line: [push, bedtime ? `${clockOf(bedtime.start_min)} 前上床` : null].filter(Boolean).join(' → '), gaps };
}
