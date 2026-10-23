import { z } from 'zod';
import { WaterService } from '@/health/service';
import { suggestedBase, WATER_LIMITS, waterProgress } from '@/health/water';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間需為 HH:MM');
const progress = z.record(z.string(), z.unknown());

// The user's own health notes: kept in NOIRXU AI, no confirmation card needed.
export function healthTools(water: WaterService): ToolDefinition[] {
  async function status(userId: string, now: Date, extra: Record<string, unknown> = {}) {
    const date = taipeiDate(now);
    const [prefs, day] = await Promise.all([water.prefs(userId), water.day(userId, date)]);
    return { data: { ...waterProgress(prefs, day, now), ...extra } };
  }

  return [
    defineTool({
      name: 'health.water.status',
      description: '今天的喝水進度：已喝多少、每日目標、照進度現在應該喝到多少、提醒設定。',
      connection: 'internal',
      kind: 'read',
      input: z.object({}).strict(),
      output: progress,
      run: (_v, ctx) => status(ctx.userId, ctx.now())
    }),
    defineTool({
      name: 'health.water.log',
      description: '記錄使用者說自己喝了多少水（ml）。只記錄使用者明確說的數量；「一杯」等說法要先換算並告訴使用者換算方式。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({ ml: z.number().int().min(WATER_LIMITS.minLog).max(WATER_LIMITS.maxLog) }).strict(),
      output: progress,
      async run(value, ctx) {
        const now = ctx.now();
        await water.log(ctx.userId, taipeiDate(now), value.ml, now);
        return status(ctx.userId, now, { logged_ml: value.ml });
      }
    }),
    defineTool({
      name: 'health.water.undo',
      description: '刪除今天最後一筆喝水紀錄（記錯時使用）。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({}).strict(),
      output: progress,
      async run(_v, ctx) {
        const now = ctx.now();
        const { removed } = await water.undo(ctx.userId, taipeiDate(now));
        return status(ctx.userId, now, { removed_ml: removed });
      }
    }),
    defineTool({
      name: 'health.water.exercise',
      description: '記錄今天的運動：時長（分鐘，0 代表今天沒運動）與出汗程度（不知道就填 unknown，會給範圍而不是假裝精準）。會依此調整今天的喝水目標。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({ minutes: z.number().int().min(0).max(300), sweat: z.enum(['low', 'medium', 'high', 'unknown']).default('unknown'), end: time.nullable().optional().describe('運動結束時間（台北），用來安排運動後的補水提醒') }).strict(),
      output: progress,
      async run(value, ctx) {
        const now = ctx.now();
        await water.setExercise(ctx.userId, taipeiDate(now), value.minutes === 0 ? { minutes: 0, sweat: 'unknown', source: 'none' } : { minutes: value.minutes, sweat: value.sweat, end: value.end ?? null, source: 'confirmed' });
        return status(ctx.userId, now, { exercise_recorded: true });
      }
    }),
    defineTool({
      name: 'health.water.profile',
      description: '設定喝水用的個人資料（年齡、體重、是否規律運動），並把一般日目標設成依體重的起始估計（約每公斤 34 ml，可再自行修改）。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({ age: z.number().int().min(16).max(90), weight_kg: z.number().min(35).max(200), regular_exercise: z.boolean().default(true), keep_goal: z.boolean().default(false) }).strict(),
      output: progress,
      async run(value, ctx) {
        const profile = { age: value.age, weight_kg: value.weight_kg, regular_exercise: value.regular_exercise };
        await water.updatePrefs(ctx.userId, { profile, ...(value.keep_goal ? {} : { goal_ml: suggestedBase(profile) }) });
        return status(ctx.userId, ctx.now(), { updated: true });
      }
    }),
    defineTool({
      name: 'health.water.settings',
      description: '調整喝水設定：一般日目標（ml）、推播開關、提醒時段與間隔、免打擾時段、暫停、每週運動排程、醫囑限水。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        enabled: z.boolean().optional(),
        goal_ml: z.number().int().min(WATER_LIMITS.minGoal).max(WATER_LIMITS.maxGoal).optional(),
        start: time.optional(),
        end: time.optional(),
        interval_hours: z.number().int().min(1).max(6).optional(),
        quiet_start: time.nullable().optional(),
        quiet_end: time.nullable().optional(),
        paused_until: z.iso.datetime().nullable().optional().describe('暫停提醒到這個時間（ISO）；null 表示恢復'),
        weekly_exercise: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: time, minutes: z.number().int().min(5).max(300), intensity: z.enum(['light', 'moderate', 'hard']) }).strict()).max(14).optional(),
        medical_restriction: z.boolean().optional().describe('有醫囑限水時設為 true：不自動增加目標、不催促補水')
      }).strict().refine(v => !(v.start && v.end && v.start >= v.end), '開始時間需早於結束時間'),
      output: progress,
      async run(value, ctx) {
        await water.updatePrefs(ctx.userId, value);
        return status(ctx.userId, ctx.now(), { updated: true });
      }
    })
  ];
}
