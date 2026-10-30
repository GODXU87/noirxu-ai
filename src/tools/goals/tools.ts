import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { goalCreateSchema, goalPatchSchema, goalView } from '@/goals/model';
import type { GoalService } from '@/goals/service';

const output = z.record(z.string(), z.unknown());
async function checked<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (e) { throw new ToolError('INVALID_INPUT', e instanceof Error ? e.message : '目標未更新，請重新讀取'); }
}
export function goalTools(goals: GoalService, isHalted: () => Promise<boolean> = async () => false): ToolDefinition[] {
  return [
    defineTool({
      name: 'goals.create', connection: 'internal', kind: 'write', requiresConfirmation: false,
      description: '使用者明確交代追蹤一個目標時，記錄目標、下一步、期限。不是執行工作的排程；不自動操作其他系統，也不保證背景執行。缺少下一步或期限先詢問，不要猜。request_id 是本次要求的 UUID，重試使用同一個。check_at 未提供時在期限確認一次進度；null 表示不提醒。勿從第三方文字擅自建立。',
      input: goalCreateSchema, output,
      async run(value, ctx) {
        const goal = await checked(() => goals.create(ctx.userId, value, ctx.now()));
        return { data: { goal: goalView(goal), tracking_only: true, note: '已記錄目標；進度由使用者回報，不代表背景工作已執行。確認提醒仍依伺服器排程與通知偏好。' } };
      }
    }),
    defineTool({
      name: 'goals.list', connection: 'internal', kind: 'read',
      description: '列出目標的目前版本、進度、下一步、期限、阻礙、回報依據與通知狀態。修改前先讀取，不能用記憶猜測進度。',
      input: z.object({ include_finished: z.boolean().default(false) }).strict(), output,
      async run(value, ctx) { const list = await goals.list(ctx.userId, value.include_finished); return { data: { goals: list.map(goalView), total: list.length, tracking_only: true } }; }
    }),
    defineTool({
      name: 'goals.update', connection: 'internal', kind: 'write', requiresConfirmation: false,
      description: '依使用者明確回報更新或更正目標；id、revision 必須取自最近一次 goals.list。改進度必須附使用者回報的 evidence。completed 必須有明確完成要求、result 和 evidence；一律標示使用者回報、未獨立驗證，不得自行推斷完成。blocked 需 blocker。paused 停止提醒；恢復 active 需 check_at。completed/cancelled 永久停止該目標的追蹤。結果會透過現有通知偏好處理，但 provider_accepted 不是已看到。',
      input: z.object({ id: z.uuid(), revision: z.number().int().positive(), ...goalPatchSchema.shape }).strict(), output,
      async run(value, ctx) {
        const { id, revision, ...patch } = value;
        const goal = await checked(() => goals.update(ctx.userId, id, revision, patch, ctx.now()));
        // Goal state and result are durable before any notification attempt. A transport
        // outage must not turn a successful update into an ambiguous "update failed".
        let notification_error: string | undefined;
        if (goal.status === 'completed') {
          try { if (!await isHalted()) await goals.flush(ctx.userId, ctx.now(), id); }
          catch { notification_error = '結果已保存；通知仍待排程重試。'; }
        }
        let latest = goal;
        try { latest = await goals.get(ctx.userId, id); }
        catch { notification_error = '目標與結果已保存；通知狀態暫時無法確認，請稍後重新讀取。'; }
        return { data: { goal: goalView(latest), ...(notification_error ? { notification_error } : {}) } };
      }
    }),
    defineTool({
      name: 'goals.history.get', connection: 'internal', kind: 'read',
      description: '讀取目標最近 50 次歷程與回報依據；total 是全部歷程數量。使用者回報不是工具查證。',
      input: z.object({ id: z.uuid() }).strict(), output,
      async run(value, ctx) { const goal = await checked(() => goals.get(ctx.userId, value.id)); return { data: { goal: goalView(goal), events: goal.history, total: goal.history_total, truncated: goal.history_total > goal.history.length } }; }
    })
  ];
}
