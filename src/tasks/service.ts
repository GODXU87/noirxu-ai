import { randomUUID } from 'node:crypto';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import type { Executor } from '@/hub/executor';
import type { HubStore } from '@/hub/store';
import type { InvokeResult } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';
import type { PushMessage } from '@/push/service';
import { LEASE_MS, MAX_RUNS_KEPT, MISSED_SLOT_MS, STEP_TIMEOUT_MS, nextRun, type StepResult, type Task, type TaskCondition, type TaskRun, type TaskSchedule, type TaskStep } from './model';

// Persistent tasks in the existing settings table (sealed, compare-and-set) — no schema
// change; a dedicated table is prepared in supabase/pending. Runs happen only from the
// server scheduler. Every change is a compare-and-set on the task record, so two scheduler
// runs can never execute the same slot twice.

export interface TaskDeps {
  store: AgendaStore;
  vault: TokenVault;
  executor: Pick<Executor, 'invoke'>;
  proposals: Pick<HubStore, 'getProposal'>;
  /** Sends a notification through the delivery service (inbox + push, with retries). */
  /** proactive = SASUKE decided to send it (watch results), so the daily cap and quiet hours apply. */
  notify: (input: { key: string; userId: string; message: PushMessage; now: Date; proactive?: boolean }) => Promise<{ status: string }>;
  /** Morning / evening summary text, from the existing briefing builders. */
  briefing: (which: 'morning' | 'evening', userId: string, now: Date) => Promise<{ title: string; body: string; important?: boolean }>;
  /** Retries a notification that no device accepted yet; returns its current status, or null if unknown. */
  redeliver?: (key: string, now: Date) => Promise<string | null>;
  /** Defaults to STEP_TIMEOUT_MS. */
  stepTimeoutMs?: number;
}

const PENDING_DELIVERY = ['pending', 'sending', 'claimed', 'retry_pending'];

const INDEX = 'tasks:index';
const HALT = 'tasks:halt';
const key = (id: string) => `task:${id}`;

/** Read-only tools may be retried; anything that writes is never re-run automatically. */
const READ_SUFFIX = /\.(list|get|search|status|summary|analyze|scan|read|statistics)$/;

export class TaskService {
  constructor(private readonly deps: TaskDeps) {}

  private open(sealed: string | null, k: string): Task | null { return sealed ? JSON.parse(this.deps.vault.open(sealed, k)) as Task : null; }

  async get(id: string): Promise<Task | null> {
    return this.open(await this.deps.store.getSetting(key(id)), key(id));
  }

  /** Compare-and-set: applies `change` to the latest record; returns the new record or null if the task is gone. */
  private async update(id: string, change: (task: Task) => Task | null): Promise<Task | null> {
    const k = key(id);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sealed = await this.deps.store.getSetting(k);
      const current = this.open(sealed, k);
      if (!current) return null;
      const next = change(current);
      if (!next) return current;
      if (await this.deps.store.compareAndSetSetting(k, sealed, this.deps.vault.seal(JSON.stringify(next), k))) return next;
    }
    throw new Error('task is busy, try again');
  }

  private async index(): Promise<string[]> {
    const sealed = await this.deps.store.getSetting(INDEX);
    return sealed ? JSON.parse(this.deps.vault.open(sealed, INDEX)) as string[] : [];
  }

  private async addToIndex(id: string) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sealed = await this.deps.store.getSetting(INDEX);
      const ids = sealed ? JSON.parse(this.deps.vault.open(sealed, INDEX)) as string[] : [];
      if (ids.includes(id)) return;
      if (await this.deps.store.compareAndSetSetting(INDEX, sealed, this.deps.vault.seal(JSON.stringify([...ids, id]), INDEX))) return;
    }
    throw new Error('task index is busy, try again');
  }

  async create(input: { userId: string; title: string; kind: Task['kind']; schedule: TaskSchedule; steps: TaskStep[]; condition?: TaskCondition; sourceText?: string; now: Date }): Promise<Task> {
    const first = nextRun(input.schedule, new Date(input.now.getTime() - 1));
    if (!first) throw new Error('這個時間已經過了');
    const task: Task = {
      id: randomUUID(), user_id: input.userId, title: input.title, kind: input.kind, status: 'queued',
      schedule: input.schedule, steps: input.steps, condition: input.condition, next_at: first.toISOString(),
      created_at: input.now.toISOString(), updated_at: input.now.toISOString(), source_text: input.sourceText, attempts: 0, runs: []
    };
    const k = key(task.id);
    // Publish the index first: exhausted contention must never leave a runnable task
    // that the scheduler cannot discover. A dangling index ID is harmless (get/list
    // skip missing records); no task is acknowledged until both writes succeed.
    await this.addToIndex(task.id);
    if (!await this.deps.store.compareAndSetSetting(k, null, this.deps.vault.seal(JSON.stringify(task), k))) {
      throw new Error('task could not be saved, try again');
    }
    return task;
  }

  async list(userId: string, options: { includeFinished?: boolean } = {}): Promise<Task[]> {
    const tasks = (await Promise.all((await this.index()).map(id => this.get(id)))).filter((t): t is Task => !!t && t.user_id === userId);
    return tasks.filter(t => options.includeFinished || !['completed', 'cancelled'].includes(t.status))
      .sort((a, b) => (a.next_at ?? '9').localeCompare(b.next_at ?? '9'));
  }

  /** Pause, resume, cancel or reschedule. Only the owner can change a task. */
  async control(userId: string, id: string, action: 'pause' | 'resume' | 'cancel' | { schedule: TaskSchedule }, now: Date): Promise<Task> {
    const updated = await this.update(id, task => {
      if (task.user_id !== userId) return null;
      if (task.status === 'cancelled' || task.status === 'completed') throw new Error('這個任務已經結束，無法再更改。');
      const stamp = { updated_at: now.toISOString() };
      if (action === 'pause') return { ...task, ...stamp, status: 'paused' };
      if (action === 'cancel') return { ...task, ...stamp, status: 'cancelled', next_at: null, lease_until: undefined };
      if (action === 'resume') {
        const next = task.next_at && Date.parse(task.next_at) > now.getTime() ? new Date(task.next_at) : nextRun(task.schedule, now);
        return { ...task, ...stamp, status: next ? 'queued' : 'completed', next_at: next?.toISOString() ?? null };
      }
      const next = nextRun(action.schedule, now);
      if (!next) throw new Error('新的時間已經過了。');
      return { ...task, ...stamp, schedule: action.schedule, status: task.status === 'paused' ? 'paused' : 'queued', next_at: next.toISOString() };
    });
    if (!updated || updated.user_id !== userId) throw new Error('找不到這個任務。');
    return updated;
  }

  /** Emergency stop: no background task runs while set. Tasks, queue and history are left as they are. */
  async halted(): Promise<{ halted: boolean; at?: string } > {
    const sealed = await this.deps.store.getSetting(HALT);
    return sealed ? JSON.parse(this.deps.vault.open(sealed, HALT)) : { halted: false };
  }

  async setHalted(halted: boolean, now: Date) {
    await this.deps.store.putSetting(HALT, this.deps.vault.seal(JSON.stringify({ halted, at: now.toISOString() }), HALT));
    return { halted, at: now.toISOString() };
  }

  /** Runs every task that is due. Called by the scheduler; safe to call concurrently. */
  async runDue(now: Date): Promise<{ ran: number; waiting: number; halted?: boolean }> {
    if ((await this.halted()).halted) return { ran: 0, waiting: 0, halted: true };
    let ran = 0;
    let waiting = 0;
    for (const id of await this.index()) {
      const task = await this.get(id);
      if (!task) continue;
      if (task.status === 'waiting_approval') { if (await this.checkApproval(task, now)) waiting += 1; continue; }
      if (task.status === 'running' && task.lease_until && Date.parse(task.lease_until) < now.getTime()) { await this.recoverStuck(task, now); continue; }
      if (task.status !== 'queued' || !task.next_at || Date.parse(task.next_at) > now.getTime()) continue;
      if (await this.runSlot(task, now)) ran += 1;
    }
    for (const id of await this.index()) await this.retryDeliveries(id, now);
    return { ran, waiting };
  }

  /** Retry already-created deliveries even for paused/cancelled tasks; halt stops all work.
   * The durable key queue survives history trimming. Each tick visits at most 100 keys,
   * rotating nonterminal keys to the end; DeliveryService owns leases/backoff/expiry.
   */
  private async retryDeliveries(id: string, now: Date) {
    const redeliver = this.deps.redeliver;
    if (!redeliver) return;
    const task = await this.get(id);
    if (!task) return;
    const keys = [...new Set([...(task.pending_delivery_keys ?? []), ...task.runs.flatMap(r => r.steps.filter(s => s.delivery_key && PENDING_DELIVERY.includes(s.delivery_status ?? '')).map(s => s.delivery_key!))])];
    const batch = keys.slice(0, 100);
    if (!batch.length) return;
    const updates = new Map<string, string>();
    for (const key of batch) {
      try {
        const status = await redeliver(key, now);
        if (status) updates.set(key, status);
      } catch { /* A transient delivery lookup failure stays queued for the next tick. */ }
    }
    await this.update(id, t => {
      const runs = t.runs.map(run => ({ ...run, steps: run.steps.map(s => {
        const status = s.delivery_key && updates.get(s.delivery_key);
        return status && PENDING_DELIVERY.includes(s.delivery_status ?? '') ? { ...s, delivery_status: status, summary: deliveryLabel(status) } : s;
      }) }));
      const current = [...new Set([...(t.pending_delivery_keys ?? []), ...keys, ...runs.flatMap(r => r.steps.filter(s => s.delivery_key && PENDING_DELIVERY.includes(s.delivery_status ?? '')).map(s => s.delivery_key!))])];
      const terminal = new Set(runs.flatMap(r => r.steps.filter(s => s.delivery_key && !PENDING_DELIVERY.includes(s.delivery_status ?? '')).map(s => s.delivery_key!)));
      for (const [key, status] of updates) if (!PENDING_DELIVERY.includes(status)) terminal.add(key);
      const pending = current.filter(key => !terminal.has(key));
      return { ...t, runs, pending_delivery_keys: [...pending.filter(key => !batch.includes(key)), ...pending.filter(key => batch.includes(key))] };
    });
  }

  private async runSlot(task: Task, now: Date): Promise<boolean> {
    const slot = task.next_at!;
    const late = now.getTime() - Date.parse(slot);
    // A recurring slot missed for hours (scheduler outage) is skipped, not replayed.
    if (late > MISSED_SLOT_MS && task.schedule.type !== 'once') {
      await this.update(task.id, t => (t.next_at !== slot ? null : this.finish(t, { id: randomUUID(), slot, started_at: now.toISOString(), finished_at: now.toISOString(), status: 'skipped', steps: [], late_minutes: Math.round(late / 60_000), error: '排程延遲太久，這一次略過' }, now)));
      return false;
    }
    // A unique claim token: concurrent runs at the same instant can't mistake another run's claim for their own.
    const claim = randomUUID();
    const claimed = await this.update(task.id, t => (t.status !== 'queued' || t.next_at !== slot || t.last_slot === slot ? null
      : { ...t, status: 'running', claim, lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), last_slot: slot, attempts: t.attempts + 1, updated_at: now.toISOString() }));
    if (!claimed || claimed.claim !== claim) return false;

    const run: TaskRun = { id: randomUUID(), slot, started_at: now.toISOString(), status: 'completed', steps: [], tool_calls: 0, llm_tokens: 0, late_minutes: late > 60_000 ? Math.round(late / 60_000) : undefined };
    try {
      if (claimed.condition) {
        run.tool_calls = 1;
        const met = await this.conditionMet(claimed, now);
        if (met === null) { run.status = 'failed'; run.error = '條件需要的資料讀不到（例如 Ledger 未連接）'; }
        else if (!met) run.status = 'not_met';
      }
      if (run.status === 'completed') await this.executeSteps(claimed, run, now);
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message.slice(0, 200) : '執行失敗';
    }
    run.finished_at = new Date().toISOString();
    await this.update(task.id, t => (t.claim !== claim ? null : this.finish(t, run, now)));
    return true;
  }

  private async executeSteps(task: Task, run: TaskRun, now: Date, start = 0) {
    const ctx = { userId: task.user_id, now: () => now };
    const continuationStopped = async () => {
      if (start === 0) return false;
      const current = await this.get(task.id);
      if (current && current.claim === task.claim && current.status !== 'cancelled') return false;
      run.status = 'failed';
      run.error = '任務已停止，沒有繼續執行剩餘步驟';
      return true;
    };
    for (const [index, step] of task.steps.entries()) {
      if (index < start) continue;
      if (await continuationStopped()) return;
      if (step.type === 'notify' || step.type === 'briefing') {
        let message: PushMessage;
        if (step.type === 'notify') {
          const found = step.include_results ? run.steps.filter(s => s.type === 'tool').map(s => `${s.tool}：${s.summary}`).join('\n') : '';
          message = { title: `Sir，${step.title}`, body: [step.body, found].filter(Boolean).join('\n'), url: '/tasks', tag: `task-${task.id}` };
        } else {
          const brief = await this.deps.briefing(step.which, task.user_id, now);
          if (step.only_if_important && !brief.important) {
            run.steps.push({ step: index, type: 'briefing', status: 'skipped', summary: '沒有重要事項，這次不通知' });
            continue;
          }
          message = { title: brief.title, body: brief.body, url: '/tasks', tag: `task-${task.id}` };
        }
        if (await continuationStopped()) return;
        const deliveryKey = `task:${task.id}:${run.slot}:${index}`;
        const result = await this.deps.notify({ key: deliveryKey, userId: task.user_id, message, now, proactive: task.kind === 'conditional' || (step.type === 'notify' && step.include_results) });
        run.steps.push({ step: index, type: step.type, status: 'ok', summary: deliveryLabel(result.status), delivery_key: deliveryKey, delivery_status: result.status });
        continue;
      }
      const readOnly = READ_SUFFIX.test(step.tool);
      run.tool_calls = (run.tool_calls ?? 0) + 1;
      let result: InvokeResult = await this.invokeWithTimeout(step.tool, step.input ?? {}, ctx, readOnly);
      if (await continuationStopped()) return;
      // Read-only steps get one quick retry; writes are never repeated automatically.
      if (result.status === 'error' && readOnly && result.code !== 'NOT_CONNECTED' && result.code !== 'INVALID_INPUT') { run.tool_calls += 1; result = await this.invokeWithTimeout(step.tool, step.input ?? {}, ctx, readOnly); }
      if (await continuationStopped()) return;
      if (result.status === 'confirmation_required') {
        run.steps.push({ step: index, type: 'tool', tool: step.tool, status: 'waiting_approval', summary: result.preview.title, proposal_id: result.proposalId });
        run.status = 'waiting_approval';
        await this.deps.notify({ key: `task-approval:${result.proposalId}`, userId: task.user_id, message: { title: 'Sir，這件事要你確認', body: `${task.title}：${result.preview.title}`, url: '/tasks', tag: `task-${task.id}` }, now });
        return;
      }
      if (result.status === 'error') {
        run.steps.push({ step: index, type: 'tool', tool: step.tool, status: 'error', summary: result.message });
        run.status = result.code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'failed';
        run.error = result.message;
        return;
      }
      run.steps.push({ step: index, type: 'tool', tool: step.tool, status: 'ok', summary: summarize(result.data) });
    }
  }

  /** A step that does not finish in time is reported; a write that timed out is "outcome unknown", never retried. */
  private async invokeWithTimeout(tool: string, input: unknown, ctx: { userId: string; now: () => Date }, readOnly: boolean): Promise<InvokeResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = this.deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    const timeout = new Promise<InvokeResult>(resolve => {
      timer = setTimeout(() => resolve({ status: 'error', tool, code: readOnly ? 'UPSTREAM_UNAVAILABLE' : 'OUTCOME_UNKNOWN', message: `步驟超過 ${Math.round(limit / 1000)} 秒未完成，已停止${readOnly ? '' : '；可能已部分執行，請檢查'}` }), limit);
    });
    try { return await Promise.race([this.deps.executor.invoke(tool, input, ctx), timeout]); }
    finally { clearTimeout(timer); }
  }

  /** Records a run and moves the task on: next slot, finished, or waiting for approval. */
  private finish(task: Task, run: TaskRun, now: Date): Task {
    const history = [run, ...task.runs.filter(r => r.id !== run.id)];
    const runs = history.slice(0, MAX_RUNS_KEPT);
    const pending_delivery_keys = [...new Set([...(task.pending_delivery_keys ?? []), ...history.flatMap(r => r.steps.filter(s => s.delivery_key && PENDING_DELIVERY.includes(s.delivery_status ?? '')).map(s => s.delivery_key!))])];
    const base = { ...task, runs, pending_delivery_keys, waiting_proposal: undefined, lease_until: undefined, claim: undefined, updated_at: now.toISOString(), last_error: run.error };
    if (task.status === 'cancelled') return { ...base, status: 'cancelled', next_at: null };
    if (run.status === 'waiting_approval') return { ...base, status: 'waiting_approval', waiting_proposal: run.steps.find(s => s.status === 'waiting_approval')?.proposal_id };
    const fired = task.condition && run.status === 'completed' ? { condition_fired_for: taipeiDate(now).slice(0, 7) } : {};
    const next = task.schedule.type === 'once' ? null : nextRun(task.schedule, now);
    if (!next) return { ...base, ...fired, status: run.status === 'completed' ? 'completed' : run.status === 'outcome_unknown' ? 'outcome_unknown' : run.status === 'skipped' || run.status === 'not_met' ? 'completed' : 'failed', next_at: null };
    // Recurring tasks keep going after a failed run; the run history shows what happened.
    return { ...base, ...fired, status: task.status === 'paused' ? 'paused' : 'queued', next_at: next.toISOString() };
  }

  private async conditionMet(task: Task, now: Date): Promise<boolean | null> {
    const condition = task.condition!;
    const month = taipeiDate(now).slice(0, 7);
    if (task.condition_fired_for === month) return false;
    if (condition.type === 'ledger_month_expense_over') {
      const result = await this.deps.executor.invoke('ledger.analytics.get', { month }, { userId: task.user_id, now: () => now });
      if (result.status !== 'ok') return null;
      const data = result.data as { summary: { expense: number }; expense_by_category: Array<{ name: string; amount: number }> };
      const spent = condition.category ? data.expense_by_category.find(c => c.name === condition.category)?.amount ?? 0 : data.summary.expense;
      return spent > condition.amount;
    }
    return null;
  }

  /** A task waiting for a confirmation continues, fails or is cancelled by the user's decision. */
  private async checkApproval(task: Task, now: Date): Promise<boolean> {
    if (!task.waiting_proposal) return false;
    const proposal = await this.deps.proposals.getProposal(task.waiting_proposal);
    if (!proposal || proposal.status === 'pending' || proposal.status === 'executing') {
      if (proposal && proposal.status === 'pending' && Date.parse(proposal.expiresAt) < now.getTime()) {
        await this.resolveApproval(task, 'failed', '確認已逾期，沒有執行', now);
      }
      return true;
    }
    const outcome = proposal.status === 'succeeded' ? 'completed' : proposal.status === 'rejected' ? 'cancelled' : proposal.status === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
    await this.resolveApproval(task, outcome, outcome === 'cancelled' ? '你取消了這個操作' : outcome === 'failed' ? '操作執行失敗' : undefined, now);
    return false;
  }

  private async resolveApproval(task: Task, outcome: 'completed' | 'cancelled' | 'failed' | 'outcome_unknown', error: string | undefined, now: Date) {
    const claim = randomUUID();
    const claimed = await this.update(task.id, t => {
      if (t.status !== 'waiting_approval' || t.waiting_proposal !== task.waiting_proposal) return null;
      if (!t.runs[0]?.steps.some(s => s.proposal_id === t.waiting_proposal && s.status === 'waiting_approval')) return null;
      return { ...t, status: 'running', claim, lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), updated_at: now.toISOString() };
    });
    if (!claimed || claimed.claim !== claim) return;
    const latest = claimed.runs[0];
    const approved = latest.steps.find(s => s.proposal_id === claimed.waiting_proposal && s.status === 'waiting_approval')!;
    const run: TaskRun = { ...latest, status: outcome === 'cancelled' ? 'failed' : outcome, error,
      steps: latest.steps.map(s => s === approved ? { ...s, status: outcome === 'completed' ? 'ok' : 'error', summary: error ?? (outcome === 'completed' ? '已確認並執行' : '執行結果不明') } : s) };
    if (outcome === 'completed') {
      try { await this.executeSteps(claimed, run, now, approved.step + 1); }
      catch (e) { run.status = 'failed'; run.error = e instanceof Error ? e.message.slice(0, 200) : '執行失敗'; }
    }
    run.finished_at = now.toISOString();
    await this.update(task.id, t => t.claim !== claim ? null : this.finish(t, run, now));
  }

  /** A run that crashed mid-way: writes may or may not have happened, so it is not repeated. */
  private async recoverStuck(task: Task, now: Date) {
    await this.update(task.id, t => (t.status !== 'running' || !t.lease_until || Date.parse(t.lease_until) >= now.getTime() ? null
      : this.finish({ ...t, status: 'queued' }, { id: randomUUID(), slot: t.last_slot ?? '', started_at: t.updated_at, finished_at: now.toISOString(), status: t.steps.some(s => s.type === 'tool' && !READ_SUFFIX.test(s.tool)) ? 'outcome_unknown' : 'failed', steps: [], error: '執行中斷（伺服器逾時），沒有自動重跑；請檢查結果' }, now)));
  }
}

function deliveryLabel(status: string) {
  return status === 'provider_accepted' ? '推播服務已接受通知（不代表裝置已顯示或開啟）'
    : status === 'failed' ? '通知送出失敗（已重試到上限），已留在通知收件匣'
    : status === 'expired' ? '通知逾時未送出，已留在通知收件匣'
    : '通知已排入，等裝置可接收時重試（已留在通知收件匣）';
}

const LIST_LABEL: Record<string, string> = { items: '筆事項', messages: '封信', trades: '筆交易', transactions: '筆收支', signals: '個訊號', results: '筆結果', stocks: '檔股票', tasks: '個任務' };

/** One line for the run log and result notifications: counts and dates, never the raw data. */
function summarize(data: unknown): string {
  if (!data || typeof data !== 'object') return '完成';
  const d = data as Record<string, unknown>;
  if (typeof d.title === 'string') return d.title;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(LIST_LABEL)) if (Array.isArray(d[key])) parts.push(`${typeof d.total_matching === 'number' ? d.total_matching : (d[key] as unknown[]).length} ${label}`);
  const date = (d.trade_date ?? (d.publication as Record<string, unknown> | undefined)?.trade_date ?? d.month) as string | undefined;
  if (date) parts.push(`資料日期 ${date}`);
  return parts.join('，') || '完成';
}
