import { z } from 'zod';
import { WaterService } from '@/health/service';
import { WATER_LIMITS, waterProgress } from '@/health/water';
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
      name: 'health.water.settings',
      description: '調整喝水設定：每日目標（ml）、是否推播提醒、提醒時段與間隔。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        enabled: z.boolean().optional(),
        goal_ml: z.number().int().min(WATER_LIMITS.minGoal).max(WATER_LIMITS.maxGoal).optional(),
        start: time.optional(),
        end: time.optional(),
        interval_hours: z.number().int().min(1).max(6).optional()
      }).strict().refine(v => !(v.start && v.end && v.start >= v.end), '開始時間需早於結束時間'),
      output: progress,
      async run(value, ctx) {
        await water.updatePrefs(ctx.userId, value);
        return status(ctx.userId, ctx.now(), { updated: true });
      }
    })
  ];
}
