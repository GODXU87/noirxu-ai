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
  /** The same analysis in SASUKE's voice: Sir, the meaning first, numbers as evidence, a caring close. */
  narrative: string[];
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

export function morningInsight(input: { date: string; sleep: GarminSleep | null; history: GarminSleep[]; recovery: GarminRecovery | null; profile: HealthProfile; waterGoalMl: number; hour?: number; includeWater?: boolean }): Insight {
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
  const water = input.includeWater !== false;
  const narrative = morningNarrative({ ...input, base, readiness, session, hydration, planned, lows, includeWater: water });
  return { when: 'morning', date: input.date, headline, lines: water ? lines : lines.filter(l => !l.startsWith('補水：')), suggestion, readiness, hydration_ml: water ? hydration : null, signals, narrative, push_line: [pushParts.join(' · '), pushAdvice].filter(Boolean).join(' → '), gaps };
}

export function eveningInsight(input: { date: string; daily: GarminDaily | null; activities: GarminActivity[]; sleepToday: GarminSleep | null; profile: HealthProfile; waterGoalMl: number; waterTodayMl: number | null; includeWater?: boolean }): Insight {
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
  const water = input.includeWater !== false;
  const narrative = eveningNarrative({ d, activities: input.activities, minutes, tired, bedtime: bedtime ?? null, nextSession, tomorrowDay: WEEKDAY[tomorrow.getUTCDay()], hydration, drank: water ? drank : null });
  return { when: 'evening', date: input.date, headline, lines: water ? lines : lines.filter(l => !l.startsWith('補水：')), suggestion, readiness: null, hydration_ml: water ? hydration : null, signals, narrative, push_line: [push, bedtime ? `${clockOf(bedtime.start_min)} 前上床` : null].filter(Boolean).join(' → '), gaps };
}

// ---- SASUKE's voice -------------------------------------------------------------------------
// Fixed phrasing chosen by the numbers, so it stays honest and costs no model call. Sir once,
// at the start; no jokes when the body is struggling.

const LIGHTER: Record<string, string> = {
  羽球: '少打一兩局、避開連續的高強度對抗，局間記得補水',
  健身: '重量抓平常八成、少一組，把動作做乾淨就好',
  跑步耐力: '改成輕鬆的 Zone 2，距離縮短三成'
};

function morningNarrative(x: { sleep: GarminSleep | null; recovery: GarminRecovery | null; base: number | null; readiness: Insight['readiness']; session: string | undefined; hydration: number; planned: number; lows: number; hour?: number; includeWater?: boolean }): string[] {
  const out: string[] = [];
  const greet = (x.hour ?? 8) < 11 ? '早安，Sir。' : 'Sir，';
  const s = x.sleep;
  if (s?.duration_s) {
    const diff = x.base !== null ? Math.round((s.duration_s - x.base) / 60) : null;
    const window = s.start_local && s.end_local ? `（${s.start_local}–${s.end_local}）` : '';
    const vs = diff === null ? '' : diff <= -30 ? `，比你這週的平均少了約 ${-diff} 分鐘` : diff >= 30 ? `，比平常多睡了 ${diff} 分鐘` : '，和平常差不多';
    const good = [s.awake_count === 0 ? '中間沒有醒來' : s.awake_count ? `中間醒來 ${s.awake_count} 次` : null, s.deep_s !== null && s.deep_s >= 3600 ? '深睡也夠' : s.deep_s !== null ? '深睡偏少' : null].filter(Boolean);
    const join = diff !== null && diff <= -30 && s.awake_count === 0 ? '，不過' : '，';
    out.push(`${greet}昨晚睡了 ${hm(s.duration_s)}${window}${vs}${good.length ? `${join}${good.join('，')}` : ''}。`);
  } else out.push(`${greet}昨晚的睡眠資料還沒同步過來，我先看其他指標。`);

  const r = x.recovery;
  if (r) {
    const parts: string[] = [];
    const hrv = r.hrv_last_night_avg;
    const inRange = hrv !== null && r.hrv_balanced_low !== null && hrv >= r.hrv_balanced_low;
    if (hrv !== null) parts.push(inRange ? `HRV ${hrv} 在你的平衡範圍內，神經系統恢復得不錯` : `HRV ${hrv} 低於你平常的範圍，身體還有點緊繃`);
    const up = r.resting_hr !== null && r.resting_hr_7d_avg !== null ? r.resting_hr - r.resting_hr_7d_avg : 0;
    const bb = r.body_battery_at_wake;
    const tiredBits = [up >= 3 ? `靜息心率 ${r.resting_hr} 比這週平均高了 ${up}` : null, bb !== null && bb < 70 ? `起床 Body Battery 只有 ${bb}` : null].filter(Boolean);
    if (tiredBits.length) parts.push(`${parts.length ? '但' : ''}${tiredBits.join('，')}，身體可能還在消化前幾天的訓練`);
    else if (bb !== null) parts.push(`起床 Body Battery ${bb}，電量充足`);
    if (parts.length) out.push(`${parts.join('；')}。`);
  }

  const sess = x.session;
  if (x.readiness === 'go') out.push(sess ? `今天的${sess}可以放心照計畫來，狀態允許拉高強度${sess === '跑步耐力' ? '，想練 HYROX 節奏段也行' : ''}。` : '今天沒有排課，狀態不錯，想動的話可以安排一次有質量的訓練。');
  else if (x.readiness === 'moderate') out.push(sess ? `所以今天的${sess}照練，但收一點：${LIGHTER[sess] ?? '強度降一級'}。` : '今天沒有排課，動一動可以，強度放中低就好。');
  else if (x.readiness === 'easy') out.push(sess ? `今天建議別硬練：${sess}改成伸展或活動度 20–30 分鐘，高強度留到恢復之後。` : '今天就以休息為主，散步、伸展就很好。');

  const water = `水今天喝到 ${x.hydration.toLocaleString('en-US')} ml 左右${x.planned ? '，訓練時每 15–20 分鐘喝幾口' : ''}`;
  const close = x.readiness === 'go' ? '難得狀態這麼好，別浪費了。' : x.readiness === 'moderate' ? '今晚若能早點上床，明天的狀態會更好。' : x.readiness === 'easy' ? '今天別勉強，練習中有任何不舒服就先停下來。' : '';
  if (x.includeWater !== false) out.push(`${water}。${close}`);
  else if (close) out.push(close);
  if (x.lows >= 2) out.push('這些是手錶的趨勢，不是醫療判斷；如果連續幾天都這樣，或身體覺得不對，請找醫師看看。');
  return out;
}

function eveningNarrative(x: { d: GarminDaily | null; activities: GarminActivity[]; minutes: number; tired: boolean; bedtime: { start_min: number; end_min: number } | null; nextSession: string | undefined; tomorrowDay: string; hydration: number; drank: number | null }): string[] {
  const out: string[] = [];
  const d = x.d;
  const steps = d?.steps != null ? `今天走了 ${d.steps.toLocaleString('en-US')} 步${d.step_goal ? (d.steps >= d.step_goal ? '，目標達成' : `，離目標還差 ${(d.step_goal - d.steps).toLocaleString('en-US')} 步`) : ''}` : null;
  const workout = x.activities.length ? x.activities.map(a => `${a.name || a.type} ${Math.round(a.duration_s / 60)} 分鐘${a.avg_hr ? `（平均心率 ${a.avg_hr}）` : ''}`).join('、') : null;
  out.push(`Sir，${x.activities.length ? '今天辛苦了。' : '今天過得還好嗎？'}${[steps, workout ? `練了${workout}` : '今天沒有運動紀錄'].filter(Boolean).join('；')}。`);
  if (d?.body_battery_latest != null || d?.stress_avg != null) {
    const bb = d?.body_battery_latest;
    const feel = x.tired ? '消耗確實不小' : bb != null && bb >= 50 ? '電量還算充足' : '在正常範圍';
    out.push(`${[bb != null ? `Body Battery 現在剩 ${bb}` : null, d?.stress_avg != null ? `平均壓力 ${d.stress_avg}` : null].filter(Boolean).join('，')}，${feel}。`);
  }
  const bed = x.bedtime ? `Garmin 建議今晚 ${clockOf(x.bedtime.start_min)}–${clockOf(x.bedtime.end_min)} 上床` : '今晚盡量睡滿 7–8 小時';
  out.push(`${bed}${x.nextSession ? `，明天（週${x.tomorrowDay}）是${x.nextSession}日，${x.tired ? '早點睡會比較撐得住' : '睡好就能有好表現'}` : ''}。`);
  if (x.drank !== null && x.drank < x.hydration) out.push(`睡前再補約 ${Math.min(500, round50(x.hydration - x.drank)).toLocaleString('en-US')} ml 水，分幾口喝，別一次灌完。`);
  return out;
}
