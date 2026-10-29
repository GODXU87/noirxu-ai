import { describe, expect, it } from 'vitest';
import { buildWeekly, weeklyPushBody } from '@/briefing/weekly';
import type { GarminAdapter, GarminSleep } from '@/garmin/adapter';
import { parseCommand } from '@/assistant/commands';

const TODAY = '2026-11-01'; // Sunday
const night = (date: string, h: number): GarminSleep => ({ date, duration_s: h * 3600, deep_s: null, light_s: null, rem_s: null, awake_s: null, awake_count: null, quality: null, result: null, start_local: null, end_local: null, avg_hr: null, avg_sleep_stress: null, tonight_bedtime: null });
const garmin = (nights: GarminSleep[]): GarminAdapter => ({ configured: true, sleepRange: async () => nights, sleep: async () => { throw new Error(); }, daily: async () => { throw new Error(); }, recovery: async () => { throw new Error(); }, activities: async () => [], activity: async () => { throw new Error(); } });
const ctx = { userId: 'owner', now: () => new Date('2026-11-01T12:00:00Z') };

function invoke(spend: Record<string, number>) {
  return async (name: string, input: any) => {
    if (name === 'garmin.training.compare') return { status: 'ok', tool: name, links: [], data: { by_type: [
      { type: 'running', this_week: { count: 2, minutes: 130, km: 21 }, last_week: { minutes: 60 }, change_pct: { minutes: 117 } },
      { type: 'badminton', this_week: { count: 3, minutes: 270, km: 0 }, last_week: { minutes: 240 }, change_pct: { minutes: 13 } }
    ] } };
    if (name === 'ledger.transactions.list') return { status: 'ok', tool: name, links: [], data: { currency: 'TWD', transactions: Object.entries(spend).map(([d, a]) => ({ occurred_on: d, amount: a, category_name: a > 1000 ? '購物' : '餐飲' })) } };
    if (name === 'journal.performance.summary') return { status: 'ok', tool: name, links: [], data: { by_currency: input.from === '2026-10-26' ? [{ currency: 'TWD', closed_trades: 3, win_rate_pct: 66.7, net_pnl: 4200 }] : [{ currency: 'TWD', closed_trades: 2, win_rate_pct: 50, net_pnl: -800 }] } };
    return { status: 'error', tool: name, code: 'UNKNOWN_TOOL', message: '' };
  };
}

describe('weekly review', () => {
  it('compares this week with last across training, sleep, spending, trading and tasks, with supported observations', async () => {
    // Last week ~7.5 h a night; this week shorter, with short nights on the expensive days.
    const nights = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map(d => night(d, 7.5))
      .concat([night('2026-10-26', 6), night('2026-10-27', 7.2), night('2026-10-28', 6.2), night('2026-10-29', 7), night('2026-10-30', 7.1), night('2026-10-31', 6), night('2026-11-01', 7.3)]);
    const spend = { '2026-10-20': 400, '2026-10-22': 500, '2026-10-26': 1800, '2026-10-27': 300, '2026-10-28': 1500, '2026-10-29': 250, '2026-10-30': 300, '2026-10-31': 1600, '2026-11-01': 200 };
    const items: any[] = [{ id: '1', status: 'done', updated_at: '2026-10-30T10:00:00Z', due_date: null }, { id: '2', status: 'open', updated_at: '', due_date: '2026-10-28' }];
    const w = await buildWeekly({ invoke: invoke(spend) as any, ctx, today: TODAY, garmin: garmin(nights), items, connected: async () => true });
    expect(w.range).toEqual({ from: '2026-10-26', to: '2026-11-01', prev_from: '2026-10-19', prev_to: '2026-10-25' });
    expect(w.training?.[0]).toMatchObject({ label: '羽球', this_minutes: 270, last_minutes: 240 });
    expect(w.sleep).toMatchObject({ nights: 7, short_nights: 3, last_avg_s: 27000 });
    expect(w.spending).toMatchObject({ currency: 'TWD', this_total: 5950, last_total: 900, top: [{ name: '購物', amount: 4900 }, { name: '餐飲', amount: 1050 }] });
    expect(w.trading).toEqual([{ currency: 'TWD', closed: 3, win_rate: 66.7, net_pnl: 4200, last_net_pnl: -800 }]);
    expect(w.tasks).toEqual({ done: 1, open_overdue: 1 });
    expect(w.insights[0]).toMatch(/^訓練量比上週多了 33%，睡眠卻平均少了 \d+ 分鐘/);
    expect(w.insights.some(i => i.startsWith('睡不到 6.5 小時的那幾天，平均花費是其他天的'))).toBe(true);
    expect(w.insights).toContain('這週有 3 晚睡不到 6.5 小時。');
    expect(weeklyPushBody(w).split('\n')[0]).toMatch(/^訓練 400 分 · 平均睡 \d 小時 \d+ 分 · 支出 TWD 5,950（\+561%） · 完成 1 件事$/);
  });

  it('makes no observation without enough data, and leaves missing sources out', async () => {
    const w = await buildWeekly({ invoke: invoke({}) as any, ctx, today: TODAY, garmin: null, items: [], connected: async () => false });
    expect(w).toMatchObject({ training: null, sleep: null, spending: null, trading: null, insights: [] });
    expect(parseCommand('週報')).toMatchObject({ name: 'weekly' });
    expect(parseCommand('/週報')).toMatchObject({ name: 'weekly', via: 'slash' });
  });
});
