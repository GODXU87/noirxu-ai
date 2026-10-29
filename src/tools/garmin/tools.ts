import { z } from 'zod';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { isCalendarDate, taipeiDate } from '@/lib/dates';
import type { GarminAdapter } from '@/garmin/adapter';
import { compareWeeks } from '@/garmin/client';
import { DEFAULT_PROFILE, eveningInsight, morningInsight, type HealthProfile } from '@/garmin/insight';

// Read-only Garmin tools. Every result carries the data date and the device's last sync, and
// says that device metrics are a reference, not a medical diagnosis.

const date = z.string().refine(isCalendarDate, '日期需為 YYYY-MM-DD').optional().describe('台灣日期 YYYY-MM-DD；預設今天。睡眠與 HRV 以「醒來那天」為日期。');
const anyRecord = z.record(z.string(), z.unknown());
const NOTE = 'Garmin 裝置指標僅供參考，不是醫療診斷；數值以手錶最後一次同步為準。';
const CACHE_MS = 5 * 60_000;

function addDays(day: string, offset: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export interface GarminToolDeps {
  /** The user's training routine (weekday plan, goal); defaults to the stated routine. */
  profile?: () => Promise<HealthProfile>;
  /** Water goal and today's logged total from the WaterService, when the feature is on. */
  water?: (userId: string, date: string) => Promise<{ goal_ml: number; total_ml: number }>;
}

const settle = async <T>(p: Promise<T>) => { try { return await p; } catch { return null; } };

export function garminTools(garmin: GarminAdapter, deps: GarminToolDeps = {}): ToolDefinition[] {
  const day = (value: string | undefined, now: Date) => value ?? taipeiDate(now);
  return [
    defineTool({
      name: 'garmin.health.daily',
      description: 'Garmin 單日健康摘要：步數與目標、距離、卡路里、靜息心率（含 7 日平均）、最低/最高心率、平均壓力、中高強度分鐘、Body Battery（最高/最低/最新/起床時）、Garmin 記錄的飲水量，以及手錶最後同步時間。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ date }).strict(), output: anyRecord,
      async run(value, ctx) { return { data: { ...(await garmin.daily(ctx.userId, day(value.date, ctx.now()))), note: NOTE } }; }
    }),
    defineTool({
      name: 'garmin.sleep.summary',
      description: 'Garmin 睡眠摘要（指定醒來那天）：總睡眠、深睡/淺睡/REM/清醒秒數、醒來次數、Garmin 的睡眠品質分類、入睡與起床時間、睡眠平均心率與壓力。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ date }).strict(), output: anyRecord,
      async run(value, ctx) { return { data: { ...(await garmin.sleep(ctx.userId, day(value.date, ctx.now()))), note: NOTE } }; }
    }),
    defineTool({
      name: 'garmin.recovery.overview',
      description: '恢復狀況：昨晚 HRV 平均、7 日 HRV 平均與 Garmin 的 HRV 狀態、起床時 Body Battery、靜息心率與 7 日平均、睡眠時間。Personal API 沒有 Training Readiness，結果會註明。用於判斷今天運動要不要調整；只能給一般建議，不是醫療診斷。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ date }).strict(), output: anyRecord,
      async run(value, ctx) { return { data: { ...(await garmin.recovery(ctx.userId, day(value.date, ctx.now()))), note: NOTE } }; }
    }),
    defineTool({
      name: 'garmin.activities.list',
      description: 'Garmin 運動紀錄（依開始日期，含首尾）：名稱、類型（running、strength_training、badminton 等 Garmin typeKey）、開始時間、時長、距離、卡路里、平均/最高心率、有氧/無氧訓練效果、訓練負荷。預設最近 7 天。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ from: date, to: date, limit: z.number().int().min(1).max(99).default(30) }).strict(), output: anyRecord,
      async run(value, ctx) {
        const to = day(value.to, ctx.now());
        const from = value.from ?? addDays(to, -6);
        const activities = await garmin.activities(ctx.userId, { from, to, limit: value.limit });
        return { data: { from, to, activities, total: activities.length, note: NOTE } };
      }
    }),
    defineTool({
      name: 'garmin.activity.summary',
      description: '單一 Garmin 運動的詳細摘要；id 必須來自 garmin.activities.list。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ id: z.string().regex(/^\d{1,20}$/, 'id 需為數字') }).strict(), output: anyRecord,
      async run(value, ctx) { return { data: { activity: await garmin.activity(ctx.userId, value.id), note: NOTE } }; }
    }),
    defineTool({
      name: 'garmin.health.insight',
      description: '身體狀況分析（固定規則，不用 AI 推估）。morning：昨晚睡眠和近 7 晚平均比較、HRV 對照個人平衡範圍、起床 Body Battery、靜息心率對照 7 日平均，判斷今天適合照計畫/收一點/恢復，配合使用者每週訓練安排給建議與補水量。evening：今天步數、強度分鐘、壓力、Body Battery、運動紀錄、Garmin 建議上床時間、補水。使用者問身體狀況、睡得好不好、今天適不適合運動時優先使用。唯讀，不是醫療診斷。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ when: z.enum(['morning', 'evening']).default('morning'), date, hydration: z.boolean().default(true).describe('false = 不含補水建議（早晚報用）') }).strict(), output: anyRecord,
      async run(value, ctx) {
        const today = day(value.date, ctx.now());
        const profile = (await settle(deps.profile?.() ?? Promise.resolve(DEFAULT_PROFILE))) ?? DEFAULT_PROFILE;
        const water = deps.water ? await settle(deps.water(ctx.userId, today)) : null;
        const goal = water?.goal_ml ?? 2000;
        if (value.when === 'morning') {
          // A rejected key or outage is reported, not hidden behind "no data".
          const sleep = await garmin.sleep(ctx.userId, today).catch(e => (e?.code === 'NOT_FOUND' ? null : Promise.reject(e)));
          const [history, recovery] = await Promise.all([settle(garmin.sleepRange(ctx.userId, addDays(today, -8), addDays(today, -1))), settle(garmin.recovery(ctx.userId, today))]);
          return { data: { ...morningInsight({ date: today, sleep, history: history ?? [], recovery, profile, waterGoalMl: goal, includeWater: value.hydration, hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(ctx.now())) }), note: NOTE } };
        }
        const daily = await garmin.daily(ctx.userId, today).catch(e => (e?.code === 'NOT_FOUND' ? null : Promise.reject(e)));
        const [activities, sleepToday] = await Promise.all([settle(garmin.activities(ctx.userId, { from: today, to: today, limit: 20 })), settle(garmin.sleep(ctx.userId, today))]);
        return { data: { ...eveningInsight({ date: today, daily, activities: activities ?? [], sleepToday, profile, waterGoalMl: goal, waterTodayMl: water?.total_ml ?? null, includeWater: value.hydration }), note: NOTE } };
      }
    }),
    defineTool({
      name: 'garmin.sleep.trend',
      description: '最近 7 晚（或指定晚數）的睡眠趨勢：每晚睡眠時間、平均、最短與最長、睡不到 6.5 小時的晚數，並和再前一段同長度的平均比較（固定公式）。日期是醒來那天。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({ nights: z.number().int().min(3).max(14).default(7) }).strict(), output: anyRecord,
      async run(value, ctx) {
        const today = taipeiDate(ctx.now());
        const n = value.nights;
        const all = await garmin.sleepRange(ctx.userId, addDays(today, -(2 * n - 1)), today);
        const rows = all.filter(s => s.duration_s).map(s => ({ date: s.date, duration_s: s.duration_s as number }));
        const recent = rows.filter(r => r.date > addDays(today, -n));
        const before = rows.filter(r => r.date <= addDays(today, -n));
        const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
        const durations = recent.map(r => r.duration_s);
        return { data: {
          from: addDays(today, -(n - 1)), to: today, nights: recent,
          average_s: avg(durations), previous_average_s: before.length >= 3 ? avg(before.map(r => r.duration_s)) : null,
          shortest: recent.length ? recent.reduce((a, b) => (b.duration_s < a.duration_s ? b : a)) : null,
          longest: recent.length ? recent.reduce((a, b) => (b.duration_s > a.duration_s ? b : a)) : null,
          short_nights: durations.filter(d => d < 6.5 * 3600).length, note: NOTE
        } };
      }
    }),
    defineTool({
      name: 'garmin.training.compare',
      description: '最近 7 天和前 7 天的訓練量比較，依運動類型分開：次數、分鐘、公里、訓練負荷與增減百分比（固定公式計算，不用推估）。用於「這週跑步量比上週增加多少」。唯讀。',
      connection: 'internal', kind: 'read', cacheTtlMs: CACHE_MS,
      input: z.object({}).strict(), output: anyRecord,
      async run(_value, ctx) {
        const today = taipeiDate(ctx.now());
        const activities = await garmin.activities(ctx.userId, { from: addDays(today, -13), to: today, limit: 99 });
        return { data: { ...compareWeeks(activities, today), note: NOTE } };
      }
    })
  ];
}
