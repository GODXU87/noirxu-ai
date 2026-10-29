// Proactive body-state alerts (feature 'health_alerts', with Garmin). Fixed rules on the same
// signals the briefings use; at most one morning and one afternoon alert a day, sent through
// the proactive limits (daily cap, quiet hours). Caring advice, never a medical diagnosis.

import type { GarminDaily } from '@/garmin/adapter';
import { pick } from '@/notify/phrasing';

interface MorningSignals {
  readiness: 'go' | 'moderate' | 'easy' | null;
  signals: Array<{ key: string; tone: string; text: string }>;
  suggestion?: string;
}

export interface BodyAlert { title: string; body: string }

const MORNING_TITLES = ['Sir，今天身體需要多照顧', 'Sir，昨晚的恢復不太夠', 'Sir，今天請對自己溫柔一點'];
const AFTERNOON_TITLES = ['Sir，該休息一下了', 'Sir，今天消耗得有點多', 'Sir，喘口氣吧'];

/** Morning: alert only when recovery is clearly poor (two or more low signals, or very short sleep). */
export function morningBodyAlert(insight: MorningSignals | null, seed: string): BodyAlert | null {
  if (!insight || insight.readiness === null) return null;
  const lows = insight.signals.filter(s => s.tone === 'low');
  const sleep = insight.signals.find(s => s.key === 'sleep');
  const slept = sleep ? /睡 (?:(\d+) 小時 )?(\d+) 分/.exec(sleep.text) : null;
  const veryShortSleep = slept !== null && Number(slept[1] ?? 0) * 60 + Number(slept[2]) < 5.5 * 60;
  if (insight.readiness !== 'easy' && !veryShortSleep) return null;
  const reasons = (lows.length ? lows : sleep ? [sleep] : []).map(s => s.text).join('、');
  const advice = insight.suggestion ?? '今天以恢復為主，散步或伸展就好。';
  return {
    title: pick(MORNING_TITLES, seed),
    body: `${reasons ? `${reasons}。` : ''}${advice}今晚也請早點休息。`
  };
}

/** Afternoon: alert when the day is draining fast (low Body Battery or high average stress). */
export function afternoonBodyAlert(daily: GarminDaily | null, seed: string): BodyAlert | null {
  if (!daily) return null;
  const bb = daily.body_battery_latest;
  const stress = daily.stress_avg;
  const lowBattery = bb !== null && bb <= 25;
  const highStress = stress !== null && stress >= 50;
  if (!lowBattery && !highStress) return null;
  const facts = [lowBattery ? `Body Battery 只剩 ${bb}` : null, highStress ? `今天平均壓力 ${stress}` : null].filter(Boolean).join('、');
  const advice = lowBattery
    ? '找 10 分鐘離開螢幕走一走、喝口水；今晚的訓練可以收一點，早點睡。'
    : '先深呼吸幾次、起來走動一下；重要的事一件一件來，我幫您盯著。';
  return { title: pick(AFTERNOON_TITLES, seed), body: `${facts}。${advice}` };
}
