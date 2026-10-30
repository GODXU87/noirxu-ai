import { z } from 'zod';
import type { DeliveryStatus } from '@/notify/delivery';
import type { PushMessage } from '@/push/service';

const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.iso.datetime({ offset: true });
export const goalCreateSchema = z.object({
  request_id: z.uuid(), title: text(100), next_step: text(400), deadline: instant,
  check_at: instant.nullable().optional(),
}).strict();
export const goalPatchSchema = z.object({
  title: text(100).optional(), next_step: text(400).optional(), deadline: instant.optional(),
  check_at: instant.nullable().optional(), progress: z.number().int().min(0).max(99).optional(),
  status: z.enum(['active', 'blocked', 'paused', 'completed', 'cancelled']).optional(),
  blocker: text(400).optional(), evidence: text(1000).optional(), result: text(1000).optional(),
}).strict().refine(p => Object.keys(p).length > 0, '請提供要更改的欄位');
export type GoalCreate = z.infer<typeof goalCreateSchema>;
export type GoalPatch = z.infer<typeof goalPatchSchema>;
export type GoalStatus = NonNullable<GoalPatch['status']>;
export interface GoalEvent {
  revision: number; at: string; kind: 'created' | 'updated' | 'check_in';
  status: GoalStatus; progress: number; next_step: string | null; deadline: string;
  title: string; blocker?: string; evidence?: string; source: 'user_report' | 'scheduler';
}
export interface GoalNotification {
  key: string; kind: 'check_in' | 'completion'; status: DeliveryStatus | 'superseded';
  created_at: string; expires_at: string; message: PushMessage;
  lease_until?: string; last_error?: string; displayed_at?: string; opened_at?: string;
}
export interface Goal {
  id: string; user_id: string; request_id: string; request_fingerprint: string;
  title: string; status: GoalStatus; progress: number; next_step: string | null;
  deadline: string; check_at: string | null; blocker?: string;
  revision: number; created_at: string; updated_at: string;
  latest_evidence?: string;
  completion?: { result: string; evidence: string; source: 'user_report'; at: string };
  history: GoalEvent[]; history_total: number; notifications: GoalNotification[];
}
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { active: '進行中', blocked: '受阻', paused: '已暫停', completed: '已完成（使用者回報）', cancelled: '已取消' };
export const goalFinished = (g: Pick<Goal, 'status'>) => g.status === 'completed' || g.status === 'cancelled';
export const deliveryFinished = (status: GoalNotification['status']) => ['provider_accepted', 'failed', 'expired', 'grouped', 'held', 'superseded'].includes(status);
export function goalDeliveryLabel(n: Pick<GoalNotification, 'status' | 'displayed_at' | 'opened_at'>) {
  if (n.opened_at) return '使用者已開啟（裝置回報）';
  if (n.displayed_at) return '裝置已顯示（裝置回報）';
  return ({ provider_accepted: '推播服務已接受，尚無裝置顯示回報', held: '僅收件匣（通知偏好）', failed: '推播失敗', expired: '推播已逾時', superseded: '已停止舊提醒', grouped: '已併入摘要' } as Record<string, string>)[n.status] ?? '通知等待處理／重試';
}

/** Public, bounded view: no owner identifiers, idempotency payloads or encrypted-store details. */
export function goalView(g: Goal) {
  return {
    id: g.id, title: g.title, status: g.status, status_label: GOAL_STATUS_LABEL[g.status],
    progress: g.progress, next_step: g.next_step, deadline: g.deadline, check_at: g.check_at,
    blocker: g.blocker ?? null, revision: g.revision, created_at: g.created_at, updated_at: g.updated_at,
    completion: g.completion ?? null,
    latest_evidence: g.latest_evidence ?? g.history.find(e => e.evidence)?.evidence ?? null,
    history_total: g.history_total, history_kept: g.history.length,
    notifications: g.notifications.map(n => ({ key: n.key, kind: n.kind, status: n.status, label: goalDeliveryLabel(n), created_at: n.created_at, displayed_at: n.displayed_at, opened_at: n.opened_at, last_error: n.last_error }))
  };
}
export type GoalView = ReturnType<typeof goalView>;
