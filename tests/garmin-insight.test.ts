import { describe, expect, it } from 'vitest';
import type { GarminActivity, GarminRecovery, GarminSleep } from '@/garmin/adapter';
import { DEFAULT_PROFILE, eveningInsight, morningInsight } from '@/garmin/insight';
import { classify } from '@/router/intents';

const night = (date: string, h: number, extra: Partial<GarminSleep> = {}): GarminSleep => ({
  date, duration_s: Math.round(h * 3600), deep_s: 4320, light_s: null, rem_s: 4560, awake_s: 600, awake_count: 0, quality: null, result: null,
  start_local: '23:40', end_local: '07:16', avg_hr: null, avg_sleep_stress: null, tonight_bedtime: null, ...extra
});
const history = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].map(d => night(d, 7.17));
const recovery = (r: Partial<GarminRecovery> = {}): GarminRecovery => ({
  date: '2026-10-29', hrv_last_night_avg: 58, hrv_weekly_avg: 61, hrv_status: 'BALANCED', hrv_balanced_low: 52, hrv_balanced_high: 70,
  body_battery_at_wake: 71, body_battery_latest: 64, resting_hr: 52, resting_hr_7d_avg: 54, sleep_s: 27360, not_available: [], ...r
});

describe('morning body-status analysis (fixed rules)', () => {
  it('compares against your own baselines and keeps a Thursday gym session on plan when recovered', () => {
    // 2026-10-29 is a Thursday: 健身 in the stated routine.
    const r = morningInsight({ date: '2026-10-29', sleep: night('2026-10-29', 7.6), history, recovery: recovery(), profile: DEFAULT_PROFILE, waterGoalMl: 2000 });
    expect(r.readiness).toBe('go');
    expect(r.lines[0]).toBe('睡眠：23:40–07:16，7 小時 36 分（近 7 晚平均 7 小時 10 分，多 26 分）；深睡 1 小時 12 分、REM 1 小時 16 分、醒來 0 次。');
    expect(r.lines[1]).toBe('恢復：HRV 58（你的平衡範圍 52–70）；起床 Body Battery 71；靜息心率 52（7 日平均 54）。');
    expect(r.lines[2]).toContain('週四，健身日');
    expect(r.suggestion).toContain('今天健身照計畫進行');
    expect(r.hydration_ml).toBe(2500);
    expect(r.push_line).toBe('睡 7h36m · HRV 平衡 · BB 71 → 健身照計畫');
    expect(r.lines.join()).not.toContain('醫師');
  });

  it('turns it down with one low signal, and suggests recovery (with the doctor note) with several', () => {
    const one = morningInsight({ date: '2026-10-29', sleep: night('2026-10-29', 5.5), history, recovery: recovery(), profile: DEFAULT_PROFILE, waterGoalMl: 2000 });
    expect(one.readiness).toBe('moderate');
    expect(one.suggestion).toContain('重量降到平常約八成');
    const many = morningInsight({ date: '2026-10-31', sleep: night('2026-10-31', 5.2), history, recovery: recovery({ hrv_status: 'LOW', hrv_last_night_avg: 41, body_battery_at_wake: 32, resting_hr: 60 }), profile: DEFAULT_PROFILE, waterGoalMl: 2000 });
    expect(many.readiness).toBe('easy');
    expect(many.headline).toBe('身體還在恢復，今天以輕量為主。');
    expect(many.suggestion).toContain('跑步耐力改成輕量或恢復課');
    expect(many.lines.at(-1)).toContain('不是醫療判斷');
  });

  it('says what is missing instead of guessing', () => {
    const r = morningInsight({ date: '2026-10-29', sleep: null, history: [], recovery: null, profile: DEFAULT_PROFILE, waterGoalMl: 2000 });
    expect(r.readiness).toBeNull();
    expect(r.gaps).toEqual(['昨晚睡眠（手錶可能還沒同步）', '恢復指標']);
    expect(r.suggestion).toContain('等手錶同步後再判斷');
  });
});

describe('evening body-status analysis', () => {
  it('reports the day, the training, Garmin\'s bedtime window, tomorrow\'s plan and hydration against what was logged', () => {
    const badminton: GarminActivity = { id: '1', name: '羽球', type: 'badminton', start_local: '2026-10-29 19:00:00', duration_s: 5400, distance_m: null, calories: 700, avg_hr: 138, max_hr: 170, aerobic_te: 3.1, anaerobic_te: 1.2, training_load: 90, elevation_gain_m: null };
    const r = eveningInsight({
      date: '2026-10-29',
      daily: { date: '2026-10-29', steps: 9120, step_goal: 8000, distance_m: 7000, active_kcal: 900, total_kcal: 2700, resting_hr: 52, resting_hr_7d_avg: 54, min_hr: 48, max_hr: 170, stress_avg: 31, stress_max: 90, moderate_minutes: 40, vigorous_minutes: 55, body_battery_high: 85, body_battery_low: 22, body_battery_latest: 24, body_battery_at_wake: 71, hydration_ml: null, hydration_goal_ml: null, last_device_sync: null },
      activities: [badminton], sleepToday: night('2026-10-29', 7.6, { tonight_bedtime: { start_min: 1380, end_min: 1410 } }), profile: DEFAULT_PROFILE, waterGoalMl: 2000, waterTodayMl: 1800
    });
    expect(r.lines[0]).toBe('今天：步數 9,120（目標 8,000，114%）、強度分鐘 中 40／高 55、平均壓力 31、Body Battery 現在 24（今天最低 22）。');
    expect(r.lines[1]).toBe('運動：羽球 90 分（平均心率 138），負荷 90。');
    expect(r.suggestion).toBe('Garmin 建議今晚 23:00–23:30 上床，明天（週五）是羽球日。');
    expect(r.hydration_ml).toBe(2750);
    expect(r.lines.at(-1)).toContain('睡前可再補 500 ml');
    expect(r.push_line).toBe('9,120 步 · 運動 90 分 · BB 24 → 23:00 前上床');
  });

  it('routes body-status questions to the local analysis', () => {
    expect(classify('我今天身體狀況如何')).toEqual({ kind: 'garmin', which: 'status' });
    expect(classify('今天適合運動嗎')).toEqual({ kind: 'garmin', which: 'status' });
    expect(classify('昨晚睡得怎樣')).toEqual({ kind: 'garmin', which: 'sleep' });
  });
});

describe("SASUKE's voice", () => {
  it('reads like a butler: Sir, the meaning, the evidence and a caring close (real numbers from 2026-10-29)', () => {
    const base = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].map(d => night(d, 7.917));
    const r = morningInsight({
      date: '2026-10-29', hour: 9, history: base, profile: DEFAULT_PROFILE, waterGoalMl: 2000,
      sleep: night('2026-10-29', 7.6, { start_local: '22:09', end_local: '05:48' }),
      recovery: recovery({ hrv_last_night_avg: 66, hrv_balanced_low: 62, hrv_balanced_high: 81, body_battery_at_wake: 63, resting_hr: 53, resting_hr_7d_avg: 49 })
    });
    expect(r.narrative).toEqual([
      '早安，Sir。昨晚睡了 7 小時 36 分（22:09–05:48），和平常差不多，中間沒有醒來，深睡也夠。',
      'HRV 66 在你的平衡範圍內，神經系統恢復得不錯；但靜息心率 53 比這週平均高了 4，起床 Body Battery 只有 63，身體可能還在消化前幾天的訓練。',
      '所以今天的健身照練，但收一點：重量抓平常八成、少一組，把動作做乾淨就好。',
      '水今天喝到 2,500 ml 左右，訓練時每 15–20 分鐘喝幾口。今晚若能早點上床，明天的狀態會更好。'
    ]);
  });
});
