import { randomUUID } from 'node:crypto';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import type { DeliveryRecord, DeliveryService } from '@/notify/delivery';
import type { PushMessage } from '@/push/service';
import { deliveryFinished, goalCreateSchema, goalFinished, goalPatchSchema, type Goal, type GoalCreate, type GoalEvent, type GoalNotification, type GoalPatch } from './model';

interface GoalDeps {
  store: AgendaStore; vault: TokenVault;
  notify: (input: { key: string; userId: string; message: PushMessage; now: Date; expiresAt: Date }) => Promise<DeliveryRecord>;
  delivery: Pick<DeliveryService, 'get'>;
}
const LIMIT = 100;
const HISTORY = 50;
const LEASE_MS = 120_000;
const key = (userId: string) => `goals:${userId}`;

/** Outcome tracking, not a second task executor. Never invokes models or external tools. */
export class GoalService {
  constructor(private readonly deps: GoalDeps) {}
  private async read(userId: string) {
    const k = key(userId); const sealed = await this.deps.store.getSetting(k);
    return { sealed, goals: sealed ? JSON.parse(this.deps.vault.open(sealed, k)) as Goal[] : [] };
  }
  private async change<T>(userId: string, fn: (goals: Goal[]) => T): Promise<T> {
    for (let n = 0; n < 8; n++) {
      const { sealed, goals } = await this.read(userId);
      const before = JSON.stringify(goals);
      const result = fn(goals);
      if (JSON.stringify(goals) === before) return result;
      if (await this.deps.store.compareAndSetSetting(key(userId), sealed, this.deps.vault.seal(JSON.stringify(goals), key(userId)))) return result;
    }
    throw new Error('目標正在更新，請重新讀取再試');
  }
  private found(goals: Goal[], id: string) {
    const g = goals.find(g => g.id === id);
    if (!g) throw new Error('找不到這個目標');
    return g;
  }
  private event(g: Goal, kind: GoalEvent['kind'], now: Date, evidence?: string) {
    const entry: GoalEvent = { revision: g.revision, at: now.toISOString(), kind, status: g.status, progress: g.progress, next_step: g.next_step, deadline: g.deadline, title: g.title, blocker: g.blocker, evidence, source: kind === 'check_in' ? 'scheduler' : 'user_report' };
    g.history = [entry, ...g.history].slice(0, HISTORY); g.history_total++;
  }
  private enqueue(g: Goal, kind: GoalNotification['kind'], now: Date) {
    // Keep every pending delivery; only old terminal delivery summaries may be trimmed.
    const pending = g.notifications.filter(n => !deliveryFinished(n.status));
    if (pending.length >= 20) throw new Error('這個目標仍有太多待處理通知，請稍後再更新');
    const preview = (text: string) => text.length > 160 ? `${text.slice(0, 160)}…` : text;
    const body = kind === 'completion'
      ? `依使用者回報完成：${preview(g.completion!.result)}\n依據（未獨立驗證）：${preview(g.completion!.evidence)}\n目標追蹤已停止，點開查看完整結果。`
      : `進度 ${g.progress}%（使用者回報）；下一步：${preview(g.next_step ?? '')}\n期限：${g.deadline}${g.blocker ? `\n阻礙：${preview(g.blocker)}` : ''}\n請更新進度；尚未確認完成，不代表背景工作已執行。`;
    g.notifications = [...pending, ...g.notifications.filter(n => deliveryFinished(n.status)).slice(-10), {
      key: `goal:${g.id}:${kind}:${g.revision}`, kind, status: 'pending', created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 12 * 3600_000).toISOString(),
      message: { title: `${kind === 'completion' ? '目標結果' : '目標進度確認'}：${g.title}`, body, url: `/tasks?goal=${g.id}#goal-${g.id}`, tag: `goal-${g.id}` }
    }];
  }
  private async receipts(g: Goal): Promise<Goal> {
    const notifications = await Promise.all(g.notifications.map(async n => {
      if (n.status === 'superseded') return n;
      const r = await this.deps.delivery.get(n.key);
      return r ? { ...n, status: r.status, displayed_at: r.displayed_at, opened_at: r.opened_at, last_error: r.last_error } : n;
    }));
    return { ...g, notifications };
  }
  async list(userId: string, includeFinished = false): Promise<Goal[]> {
    return Promise.all((await this.read(userId)).goals.filter(g => includeFinished || !goalFinished(g))
      .sort((a, b) => a.deadline.localeCompare(b.deadline)).map(g => this.receipts(g)));
  }
  async get(userId: string, id: string): Promise<Goal> { return this.receipts(this.found((await this.read(userId)).goals, id)); }
  async create(userId: string, raw: GoalCreate, now: Date): Promise<Goal> {
    const input = goalCreateSchema.parse(raw);
    const fingerprint = JSON.stringify(input);
    return this.change(userId, goals => {
      const existing = goals.find(g => g.request_id === input.request_id);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new Error('這個建立請求已使用過，請重新讀取目標');
        return existing;
      }
      if (goals.length >= LIMIT) throw new Error(`目標已達 ${LIMIT} 筆上限，本次未建立`);
      const g: Goal = { id: randomUUID(), user_id: userId, request_id: input.request_id, request_fingerprint: fingerprint,
        title: input.title, next_step: input.next_step, deadline: input.deadline, check_at: input.check_at === undefined ? input.deadline : input.check_at,
        status: 'active', progress: 0, revision: 1, created_at: now.toISOString(), updated_at: now.toISOString(), history: [], history_total: 0, notifications: [] };
      this.event(g, 'created', now); goals.push(g); return g;
    });
  }
  async update(userId: string, id: string, revision: number, raw: GoalPatch, now: Date): Promise<Goal> {
    const p = goalPatchSchema.parse(raw);
    return this.change(userId, goals => {
      const g = this.found(goals, id);
      if (goalFinished(g)) throw new Error('這個目標已結束，請建立新的目標');
      if (g.revision !== revision) throw new Error('目標版本已更新，請重新讀取，勿覆蓋較新的更正');
      if (p.progress !== undefined && p.progress !== g.progress && !p.evidence) throw new Error('更新進度需要使用者回報的依據');
      if (p.status === 'completed' && (!p.evidence || !p.result)) throw new Error('完成需要結果與使用者回報的依據');
      if ((p.status ?? g.status) === 'blocked' && !(p.blocker ?? g.blocker)) throw new Error('請說明目前的阻礙');
      if (p.status === 'active' && g.status === 'paused' && !p.check_at) throw new Error('恢復追蹤需要明確的下次確認時間');
      // An edit invalidates stale check-in text, but cannot retract an already in-flight push.
      for (const n of g.notifications) if (n.kind === 'check_in' && !deliveryFinished(n.status)) { n.status = 'superseded'; n.lease_until = undefined; }
      const oldDeadline = g.deadline;
      const { evidence: _evidence, result: _result, ...fields } = p;
      Object.assign(g, fields);
      if (p.deadline && p.check_at === undefined && g.check_at === oldDeadline) g.check_at = p.deadline;
      if (g.status !== 'blocked') g.blocker = undefined;
      g.revision++; g.updated_at = now.toISOString();
      if (p.evidence) g.latest_evidence = p.evidence;
      if (goalFinished(g) || g.status === 'paused') g.check_at = null;
      if (goalFinished(g)) g.next_step = null;
      if (g.status === 'completed') {
        g.progress = 100; g.completion = { result: p.result!, evidence: p.evidence!, source: 'user_report', at: now.toISOString() };
        this.enqueue(g, 'completion', now);
      }
      this.event(g, 'updated', now, p.evidence); return g;
    });
  }
  /** Called only by the existing authorized scheduler (or to flush an explicit completion).
   * A due check-in is consumed once; no hidden reschedule or autonomous work is implied.
   */
  async runDue(userId: string, now: Date): Promise<{ checked: number; deliveries: number }> {
    const checked = await this.change(userId, goals => {
      let count = 0;
      for (const g of goals) {
        if (!['active', 'blocked'].includes(g.status) || !g.check_at || Date.parse(g.check_at) > now.getTime()) continue;
        g.check_at = null; g.revision++; g.updated_at = now.toISOString();
        this.enqueue(g, 'check_in', now); this.event(g, 'check_in', now); count++;
      }
      return count;
    });
    const deliveries = await this.flush(userId, now);
    return { checked, deliveries };
  }
  /** Deliver already-recorded results without generating any new check-in. */
  async flush(userId: string, now: Date, goalId?: string): Promise<number> {
    let deliveries = 0;
    const snapshot = (await this.read(userId)).goals;
    for (const g of snapshot.filter(g => !goalId || g.id === goalId)) for (const n of g.notifications) {
      if (deliveryFinished(n.status)) continue;
      const claimed = await this.change(userId, goals => {
        const latest = this.found(goals, g.id); const event = latest.notifications.find(x => x.key === n.key);
        if (!event || deliveryFinished(event.status) || (event.lease_until && Date.parse(event.lease_until) > now.getTime())) return null;
        if (event.kind === 'check_in' && !['active', 'blocked'].includes(latest.status)) { event.status = 'superseded'; return null; }
        event.lease_until = new Date(now.getTime() + LEASE_MS).toISOString(); return { ...event };
      });
      if (!claimed) continue;
      let receipt: DeliveryRecord | undefined; let error: string | undefined;
      try { receipt = await this.deps.notify({ key: claimed.key, userId, message: claimed.message, now, expiresAt: new Date(claimed.expires_at) }); deliveries++; }
      catch (e) { error = e instanceof Error ? e.message.slice(0, 200) : '通知暫時無法處理'; }
      await this.change(userId, goals => {
        const event = this.found(goals, g.id).notifications.find(x => x.key === n.key);
        if (!event || event.status === 'superseded' || event.lease_until !== claimed.lease_until) return;
        event.lease_until = undefined; event.status = receipt?.status ?? 'pending';
        event.last_error = receipt?.last_error ?? error;
        event.displayed_at = receipt?.displayed_at; event.opened_at = receipt?.opened_at;
      });
    }
    return deliveries;
  }
}
