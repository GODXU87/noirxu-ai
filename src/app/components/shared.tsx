'use client';

import { GoalCard } from './Goals';
import { TaskResult } from './TaskResult';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { money, toolLabel, toolSystem } from '@/lib/tool-labels';
import { flash } from './feedback';
import { Icon } from './Icon';
import { BriefingCard, type BriefingCardData } from './BriefingCard';
import { WeeklyCard, type WeeklyCardData } from './WeeklyCard';
import { QualityCard, type QualitySummaryData } from './QualityCard';

export interface Link { label: string; url: string }
export interface Preview { title: string; fields: Array<{ label: string; value: string }>; body?: string; warnings?: string[] }
export type InvokeResult =
  | { status: 'ok'; tool: string; data: unknown; links: Link[] }
  | { status: 'confirmation_required'; tool: string; proposalId: string; preview: Preview; expiresAt: string }
  | { status: 'error'; tool: string; code: string; message: string };
export type ConfirmResult =
  | { status: 'succeeded'; tool: string; proposalId: string; data: unknown; recordId?: string; links: Link[] }
  | { status: 'failed' | 'outcome_unknown'; tool: string; proposalId: string; code: string; message: string; candidates?: unknown[]; links: Link[] };

/** Calls one tool through the same executor the chat uses (writes still need confirmation). */
export async function callTool(name: string, input: unknown = {}, signal?: AbortSignal): Promise<InvokeResult> {
  try {
    const response = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal
    });
    const body = await response.json();
    if (!body.ok) return { status: 'error', tool: name, code: body.error?.code ?? 'ERROR', message: body.error?.message ?? '發生錯誤' };
    if (typeof window !== 'undefined' && body.result?.status === 'ok' && /^tasks\.(create|update|halt)$/.test(name)) window.dispatchEvent(new Event('noirxu-tasks-changed'));
    return body.result as InvokeResult;
  } catch {
    return { status: 'error', tool: name, code: 'NETWORK', message: '網路錯誤，請稍後再試。' };
  }
}

export function Links({ links }: { links?: Link[] }) {
  if (!links?.length) return null;
  return <div className="links">{links.map(link => <a key={link.url + link.label} href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a>)}</div>;
}

export function Bar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'warn' | 'danger' }) {
  return <div className="bar"><span className={`bar-${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return <div className="stat"><span>{label}</span><b className={tone ? `tone-${tone}` : undefined}>{value}</b></div>;
}

export interface AgendaView {
  id: string; title: string; notes: string; due_label: string; due_date: string | null; due_time: string | null;
  importance: 1 | 2 | 3; priority: 'urgent' | 'high' | 'normal' | 'low'; priority_label: string; status: string;
}

function AgendaEditor({ item, onClose, onChanged }: { item: AgendaView; onClose: () => void; onChanged: () => void }) {
  const [form, setForm] = useState({ title: item.title, due_date: item.due_date ?? '', due_time: item.due_time ?? '', importance: item.importance, notes: item.notes });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(patch: Record<string, unknown>) {
    setBusy(true); setError('');
    const result = await callTool('agenda.items.update', { id: item.id, ...patch });
    setBusy(false);
    if (result.status === 'ok') { onClose(); onChanged(); }
    else if (result.status === 'error') setError(result.message);
  }

  return (
    <form className="agenda-edit" onSubmit={event => { event.preventDefault(); void save({ title: form.title, due_date: form.due_date || null, due_time: form.due_time || null, importance: form.importance, notes: form.notes }); }}>
      <input className="full" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} maxLength={200} required aria-label="事項" />
      <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} aria-label="日期" />
      <input type="time" value={form.due_time} onChange={e => setForm({ ...form, due_time: e.target.value })} aria-label="時間" />
      <div className="full seg" role="group" aria-label="重要程度"><span className="seg-label">重要程度</span>
        {([[3, '高'], [2, '中'], [1, '低']] as const).map(([value, label]) => (
          <button key={value} type="button" className={form.importance === value ? 'on' : ''} onClick={() => setForm({ ...form, importance: value })}>{label}</button>
        ))}
      </div>
      <input className="full" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} maxLength={1000} placeholder="備註（選填）" aria-label="備註" />
      {error && <p className="full status-error">{error}</p>}
      <div className="actions">
        <button className="primary grow" disabled={busy} data-loading={busy || undefined}>儲存</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void save({ status: 'cancelled' })}>刪除</button>
      </div>
    </form>
  );
}

/** Ranked agenda. With `onChanged`, items can be completed or edited in place. */
export function AgendaList({ items, onChanged, emptyText = '目前沒有待辦事項。' }: { items: AgendaView[]; onChanged?: () => void; emptyText?: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!items?.length) return <p className="hint">{emptyText}</p>;
  async function complete(id: string) {
    const result = await callTool('agenda.items.update', { id, status: 'done' });
    if (result.status === 'ok') onChanged?.();
  }
  return (
    <ul className="agenda">
      {items.map(item => (
        <li key={item.id}>
          <div className={`agenda-row prio-${item.priority}${item.status !== 'open' ? ' is-done' : ''}`}>
            <span className="rail" aria-hidden="true" />
            <button type="button" className="agenda-main" disabled={!onChanged} onClick={() => setEditing(editing === item.id ? null : item.id)}>
              <b>{item.title}</b>
              <small><span className={`tag tag-${item.priority}`}>{item.status === 'done' ? '已完成' : item.priority_label}</span>{item.due_label}{item.notes ? ` · ${item.notes}` : ''}</small>
            </button>
            {onChanged && item.status === 'open' && <button type="button" className="check" aria-label={`完成：${item.title}`} onClick={() => void complete(item.id)}><Icon name="check" size={16} /></button>}
          </div>
          {editing === item.id && onChanged && <AgendaEditor item={item} onClose={() => setEditing(null)} onChanged={onChanged} />}
        </li>
      ))}
    </ul>
  );
}

/** An explicit reminder in the chat: when it fires, its state, and cancel / change. */
function ReminderCard({ data }: { data: any }) {
  const [state, setState] = useState<'scheduled' | 'cancelled' | 'editing' | 'busy'>('scheduled');
  const [item, setItem] = useState(data.item);
  const [error, setError] = useState('');
  const reminder = data.reminders[0];
  const changed = () => window.dispatchEvent(new Event('noirxu-reminders-changed'));
  async function cancel(button: HTMLButtonElement) {
    setState('busy'); setError('');
    const result = await callTool('agenda.items.update', { id: item.id, status: 'cancelled' });
    if (result.status === 'ok') { setState('cancelled'); changed(); } else { setState('scheduled'); setError(result.status === 'error' ? result.message : '取消失敗'); flash(button, 'error'); }
  }
  return (
    <div className={`reminder-card is-${state}`}>
      <div className="reminder-head">
        <Icon name="bell" size={16} />
        <b>{item.title}</b>
        <span className={`state-chip ${state === 'cancelled' ? 'error' : 'ok'}`}>{state === 'cancelled' ? '已取消' : '已排程'}</span>
      </div>
      <p className="reminder-time">{state === 'cancelled' ? '這則提醒不會再送出。' : item.due_label ?? reminder.local}{state !== 'cancelled' && <small>提醒時間 {item.due_date && item.due_time ? `${Number(item.due_date.slice(5, 7))}/${Number(item.due_date.slice(8))} ${item.due_time}` : reminder.local}（台灣時間）</small>}</p>
      {state !== 'cancelled' && state !== 'editing' && (
        <div className="row reminder-actions">
          <button type="button" disabled={state === 'busy'} data-loading={state === 'busy' || undefined} onClick={e => void cancel(e.currentTarget)}>取消提醒</button>
          <button type="button" className="ghost" disabled={state === 'busy'} onClick={() => setState('editing')}>修改時間</button>
        </div>
      )}
      {state === 'editing' && <AgendaEditor item={item} onClose={() => setState('scheduled')} onChanged={() => { setState('scheduled'); changed(); void callTool('agenda.items.list', { days: 365, include_done: true }).then(r => { const next = r.status === 'ok' ? (r.data as any).items.find((i: any) => i.id === item.id) : null; if (next) setItem(next); }); }} />}
      {error && <p className="hint tone-error">{error}</p>}
    </div>
  );
}

const TASK_TONE: Record<string, string> = { queued: 'ok', running: 'pending', waiting_approval: 'pending', completed: 'ok', failed: 'error', cancelled: '', outcome_unknown: 'pending', paused: '' };
const RUN_LABEL: Record<string, string> = { completed: '完成', failed: '失敗', waiting_approval: '等你確認', outcome_unknown: '結果不明', skipped: '略過', not_met: '條件未達成' };

function TaskApproval({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [approval, setApproval] = useState<Extract<InvokeResult, { status: 'confirmation_required' }> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(''); setApproval(null);
    void callTool('tasks.approval.get', { id }, controller.signal).then(result => {
      if (!active) return;
      setLoading(false);
      if (result.status !== 'ok') { setError(result.status === 'error' ? result.message : '無法讀取確認內容'); return; }
      const value = (result.data as { approval: Extract<InvokeResult, { status: 'confirmation_required' }> | null }).approval;
      setApproval(value);
      if (!value) setError('目前沒有可確認的操作，可能已處理或逾期；請更新任務狀態');
    });
    return () => { active = false; controller.abort(); };
  }, [id, open]);
  return <div>
    <button type="button" className="ghost" onClick={() => setOpen(v => !v)}>{open ? '收合待確認操作' : '查看待確認操作'}</button>
    {open && loading && <p role="status">確認內容讀取中…</p>}
    {open && error && <p className="hint tone-error">{error}</p>}
    {open && approval && <ProposalCard key={approval.proposalId} result={approval} onDone={() => window.dispatchEvent(new Event('noirxu-tasks-changed'))} />}
  </div>;
}

/** A background task in the chat or the task center: schedule, next run, last result, pause / resume / cancel. */
export function TaskCard({ task: initial }: { task: any }) {
  const [task, setTask] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [runs, setRuns] = useState<any[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const mounted = useRef(false);
  const latest = useRef(initial); latest.current = initial;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const acting = useRef(false);
  useEffect(() => { if (!acting.current) setTask(initial); }, [initial]);
  const finished = task.status === 'cancelled' || task.status === 'completed';
  async function act(action: 'pause' | 'resume' | 'cancel', button: HTMLButtonElement) {
    acting.current = true; setBusy(true); setError('');
    const result = await callTool('tasks.update', { id: task.id, action });
    acting.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.status === 'ok') setTask((result.data as any).task);
    else { setTask(latest.current); setError(result.status === 'error' ? result.message : '更新失敗'); flash(button, 'error'); }
  }
  const historyVersion = JSON.stringify([task.id, task.status, task.last_run, task.runs_kept]);
  useEffect(() => {
    if (!historyOpen) return;
    const controller = new AbortController();
    let current = true;
    setHistoryLoading(true); setHistoryError('');
    void callTool('tasks.history.get', { id: task.id }, controller.signal).then(result => {
      if (!current) return;
      setHistoryLoading(false);
      if (result.status === 'ok') setRuns((result.data as any).runs);
      else setHistoryError(result.status === 'error' ? result.message : '紀錄更新失敗，保留上次讀取的紀錄。');
    });
    return () => { current = false; controller.abort(); };
  }, [historyOpen, historyVersion, task.id]);
  return (
    <div className={`reminder-card task-card is-${task.status}`}>
      <div className="reminder-head">
        <Icon name={task.kind === 'conditional' ? 'chart' : 'bell'} size={16} />
        <b>{task.title}</b>
        <span className={`state-chip ${TASK_TONE[task.status] ?? ''}`}>{task.status_label}</span>
      </div>
      <p className="task-meta">{task.kind_label} · {task.schedule_label}{task.condition ? ` · 條件：${task.condition.category ?? '本月'}支出 > ${Number(task.condition.amount).toLocaleString('en-US')}` : ''}</p>
      {!finished && task.next_local && <p className="task-next">{task.status === 'paused' ? '已暫停，恢復後下次' : '下次執行'} <b>{task.next_local}</b></p>}
      {task.last_run && <TaskResult run={task.last_run} latest />}
      {!finished && (
        <div className="row reminder-actions">
          {task.status === 'paused'
            ? <button type="button" disabled={busy} onClick={e => void act('resume', e.currentTarget)}>恢復</button>
            : <button type="button" disabled={busy || task.status === 'running'} onClick={e => void act('pause', e.currentTarget)}>暫停</button>}
          <button type="button" className="ghost" disabled={busy || task.status === 'running'} onClick={e => void act('cancel', e.currentTarget)}>取消任務</button>
          <button type="button" className="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收合紀錄' : '執行紀錄'}</button>
        </div>
      )}
      {finished && task.runs_kept > 0 && <div className="row reminder-actions"><button type="button" className="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收合紀錄' : '執行紀錄'}</button></div>}
      {task.status === 'waiting_approval' && <TaskApproval key={task.waiting_proposal ?? task.id} id={task.id} />}
      {historyOpen && historyLoading && <p className="hint" role="status">紀錄更新中…</p>}
      {historyOpen && runs && (
        <ul className="rows task-runs">
          {runs.map(r => <li key={r.id}><TaskResult run={r} /></li>)}
          {!runs.length && <li className="muted">還沒有執行過</li>}
        </ul>
      )}
      {historyOpen && historyError && <p className="hint tone-error">{historyError}</p>}
      {error && <p className="hint tone-error">{error}</p>}
    </div>
  );
}

const STATUS_TONE: Record<string, 'accent' | 'warn' | 'danger'> = { safe: 'accent', warning: 'warn', over: 'danger', unset: 'accent' };

/** Readable views for the common tools; everything else falls back to the raw data. */
export function ToolData({ tool, data }: { tool: string; data: any }): ReactNode {
  if (!data) return null;
  switch (tool) {
    case 'ledger.analytics.get': {
      const c = data.currency;
      return (
        <div className="view">
          <div className="stats">
            <Stat label={`收入 ${c}`} value={money(data.summary.income)} tone="up" />
            <Stat label={`支出 ${c}`} value={money(data.summary.expense)} tone="down" />
            <Stat label={`淨額 ${c}`} value={money(data.summary.netFlow)} tone={data.summary.netFlow >= 0 ? 'up' : 'down'} />
          </div>
          {data.comparison?.expense?.change != null && <p className="hint">支出較 {data.comparison.previousMonth} {data.comparison.expense.change >= 0 ? '增加' : '減少'} {Math.abs(data.comparison.expense.change)}%</p>}
          {data.expense_by_category?.slice(0, 6).map((row: any) => (
            <div key={row.name} className="barrow"><span>{row.name}</span><Bar value={row.percentage} /><b>{money(row.amount)}</b></div>
          ))}
        </div>
      );
    }
    case 'ledger.budget.summary':
      return (
        <div className="view">
          {data.total.status !== 'unset' && <div className="barrow"><span>總預算</span><Bar value={data.total.percentage} tone={STATUS_TONE[data.total.status]} /><b>{money(data.total.spent)} / {money(data.total.limit)}</b></div>}
          {data.categories.map((row: any) => <div key={row.categoryId} className="barrow"><span>{row.name}</span><Bar value={row.percentage} tone={STATUS_TONE[row.status]} /><b>{row.percentage}%</b></div>)}
          {data.total.status === 'unset' && !data.categories.length && <p className="hint">這個月還沒有設定預算。</p>}
        </div>
      );
    case 'ledger.transactions.list':
      return (
        <ul className="rows">
          {data.transactions.slice(0, 12).map((row: any) => (
            <li key={row.id}><span className="muted">{row.occurred_on.slice(5)}</span><span>{row.category_name}{row.merchant ? ` · ${row.merchant}` : ''}</span><b className={row.type === 'income' ? 'tone-up' : 'tone-down'}>{row.type === 'income' ? '+' : '-'}{money(row.amount)}</b></li>
          ))}
          {data.total_matching > 12 && <li className="muted">共 {data.total_matching} 筆，只顯示前 12 筆</li>}
          {!data.transactions.length && <li className="muted">沒有紀錄</li>}
        </ul>
      );
    case 'journal.performance.summary':
      return (
        <div className="view">
          {data.by_currency.map((row: any) => (
            <div key={row.currency} className="stats">
              <Stat label={`${row.currency} 淨損益`} value={money(row.net_pnl)} tone={row.net_pnl >= 0 ? 'up' : 'down'} />
              <Stat label="勝率" value={row.win_rate_pct == null ? '—' : `${row.win_rate_pct}%`} />
              <Stat label="筆數" value={`${row.closed_trades}（${row.wins} 勝 ${row.losses} 敗）`} />
            </div>
          ))}
          {!data.by_currency.length && <p className="hint">這段期間沒有已平倉交易。</p>}
          <p className="hint">未平倉 {data.open_positions} 筆{data.average_hold_days != null ? ` · 平均持有 ${data.average_hold_days.toFixed(1)} 天` : ''} · 最長連勝 {data.max_win_streak} / 連敗 {data.max_loss_streak}</p>
        </div>
      );
    case 'journal.trades.list':
      return (
        <ul className="rows">
          {data.trades.slice(0, 12).map((row: any) => (
            <li key={row.id}><span className="muted">{row.first_entry_date?.slice(5) ?? ''}</span><span>{row.symbol} {row.side === 'LONG' ? '多' : '空'} · {row.status === 'open' ? '持倉中' : '已平倉'}</span><b className={row.realized_pnl >= 0 ? 'tone-up' : 'tone-down'}>{row.status === 'open' ? money(row.open_quantity) + ' 股' : money(row.realized_pnl, row.currency)}</b></li>
          ))}
          {!data.trades.length && <li className="muted">沒有紀錄</li>}
        </ul>
      );
    case 'gmail.messages.search':
      return (
        <ul className="rows mail">
          {data.messages.map((row: any) => <li key={row.id}><span className={row.unread ? '' : 'muted'}>{row.unread ? '● ' : ''}{row.from.replace(/<.*>/, '').trim()}</span><span>{row.subject || '（無主旨）'}</span></li>)}
          {!data.messages.length && <li className="muted">沒有符合的信件</li>}
        </ul>
      );
    case 'agenda.items.list':
      return <AgendaList items={data.items} />;
    case 'agenda.items.create':
      if (data.kind === 'reminder' && data.reminders?.length) return <ReminderCard data={data} />;
      return (
        <div className="view">
          <AgendaList items={[data.item]} onChanged={() => window.dispatchEvent(new Event('noirxu-reminders-changed'))} />
          {data.reminders?.length
            ? <p className="hint">{data.kind === 'reminder' ? '已排程提醒' : '會提醒'}：{data.reminders.map((r: any) => `${r.local ?? new Date(r.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${data.kind === 'reminder' ? '' : `（${r.label}）`}`).join('、')}。點一下事項可以修改時間或刪除。</p>
            : <p className="hint">{data.item?.due_date ? '提醒時間都已經過了，沒有排上提醒。' : '這是記事，沒有日期，不會提醒。'}</p>}
        </div>
      );
    case 'agenda.items.update':
      return <AgendaList items={[data.item]} />;
    case 'ledger.assets.summary':
      return (
        <div className="view">
          <div className="stats">
            <Stat label="總資產 TWD" value={money(data.gross_assets)} />
            <Stat label="負債 TWD" value={money(data.liabilities)} tone={data.liabilities > 0 ? 'down' : undefined} />
            <Stat label="淨資產 TWD" value={money(data.net_worth)} tone={data.net_worth >= 0 ? 'up' : 'down'} />
          </div>
          {data.month_change?.percentage != null && <p className="hint">資產較上月 {data.month_change.delta >= 0 ? '增加' : '減少'} {money(Math.abs(data.month_change.delta))}（{Math.abs(data.month_change.percentage)}%）</p>}
          {data.allocation?.slice(0, 6).map((row: any) => <div key={row.name} className="barrow"><span>{row.name}</span><Bar value={row.percentage} /><b>{row.percentage}%</b></div>)}
          {!data.accounts?.length && <p className="hint">Ledger 還沒有資產帳戶。</p>}
        </div>
      );
    case 'goals.create':
    case 'goals.update':
    case 'goals.history.get':
      return <GoalCard goal={data.goal} />;
    case 'goals.list':
      return <div className="view stack">{data.goals.map((g: any) => <GoalCard key={g.id} goal={g} />)}{!data.goals.length && <p className="hint">目前沒有進行中的目標。</p>}</div>;
    case 'tasks.create':
    case 'tasks.update':
      return <TaskCard task={data.task} />;
    case 'tasks.history.get':
      return <TaskCard task={data.task} />;
    case 'tasks.halt':
      return <p className="hint">{data.halted ? '所有背景自動任務已停止，任務與紀錄都保留。' : '背景自動任務已恢復。'}</p>;
    case 'tasks.list':
      return <div className="view task-list">{data.tasks.map((t: any) => <TaskCard key={t.id} task={t} />)}{!data.tasks.length && <p className="hint">目前沒有自動任務。</p>}</div>;
    case 'garmin.health.insight':
      return (
        <div className="view">
          <div className="health-chips">{data.signals?.map((sig: any) => <span key={sig.key} className={`health-chip tone-${sig.tone}`}>{sig.text}</span>)}{data.hydration_ml ? <span className="health-chip">補水 {money(data.hydration_ml)} ml</span> : null}</div>
          <p className="hint">資料日期 {data.date}{data.gaps?.length ? ` · 尚缺：${data.gaps.join('、')}` : ''} · 僅供參考，不是醫療診斷</p>
        </div>
      );
    case 'garmin.sleep.summary': {
      const h = (sec: number | null) => (sec == null ? '—' : `${Math.floor(sec / 3600)}:${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`);
      return <div className="view"><div className="stats"><Stat label="總睡眠" value={h(data.duration_s)} /><Stat label="深睡" value={h(data.deep_s)} /><Stat label="REM" value={h(data.rem_s)} /><Stat label="清醒" value={h(data.awake_s)} /></div><p className="hint">{data.date}{data.start_local && data.end_local ? ` · ${data.start_local}–${data.end_local}` : ''}</p></div>;
    }
    case 'garmin.health.daily':
      return <div className="view"><div className="stats"><Stat label="步數" value={data.steps == null ? '—' : money(data.steps)} /><Stat label="靜息心率" value={data.resting_hr ?? '—'} /><Stat label="Body Battery" value={data.body_battery_latest ?? '—'} /><Stat label="平均壓力" value={data.stress_avg ?? '—'} /></div><p className="hint">{data.date}{data.last_device_sync ? ` · 手錶同步 ${String(data.last_device_sync).slice(11, 16)} UTC` : ''}</p></div>;
    case 'garmin.activities.list':
      return (
        <ul className="rows">
          {data.activities.slice(0, 12).map((a: any) => <li key={a.id}><span className="muted">{String(a.start_local).slice(5, 16)}</span><span>{a.name || a.type}</span><b>{Math.round(a.duration_s / 60)} 分{a.distance_m ? ` · ${(a.distance_m / 1000).toFixed(1)} km` : ''}</b></li>)}
          {!data.activities.length && <li className="muted">這段期間沒有運動紀錄</li>}
        </ul>
      );
    case 'garmin.training.compare':
      return (
        <ul className="rows">
          {data.by_type.map((t: any) => <li key={t.type}><span>{t.type}</span><span className="muted">{t.last_week.minutes} → {t.this_week.minutes} 分</span><b>{t.change_pct.minutes == null ? '新增' : `${t.change_pct.minutes > 0 ? '+' : ''}${t.change_pct.minutes}%`}</b></li>)}
          {!data.by_type.length && <li className="muted">最近兩週沒有運動紀錄</li>}
        </ul>
      );
    case 'memory.save':
      return <p className="hint">{data.updated ? '已更新' : '已記住'}：{data.memory?.content}（{data.memory?.category_label}）</p>;
    case 'memory.search':
      return <ul className="rows">{data.memories.map((m: any) => <li key={m.id}><span className="muted">{String(m.updated_at).slice(0, 10)}</span><span>{m.content}</span>{m.stale ? <b className="muted">可能過期</b> : <b />}</li>)}{!data.memories.length && <li className="muted">沒有相關記憶</li>}</ul>;
    case 'radar.status':
      return <div className="view"><p className="hint">最新資料交易日：<b>{data.publication?.trade_date ?? '—'}</b></p></div>;
    default:
      return null;
  }
}

/** Long results fold to a fixed height with a toggle (SASUKE UI; the classic CSS ignores it). */
export function Collapsible({ children, limit = 360 }: { children: ReactNode; limit?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (box.current) setTall(box.current.scrollHeight > limit + 40); }, [children, limit]);
  return (
    <div className={`collapsible ${tall && !open ? 'folded' : ''}`} style={{ ['--fold' as string]: `${limit}px` }}>
      <div ref={box} className="collapsible-body">{children}</div>
      {tall && <button type="button" className="collapse-toggle" onClick={() => setOpen(o => !o)}>{open ? '收合' : '展開全部'}</button>}
    </div>
  );
}

/** Tools that only read; anything else that returns 'ok' has changed something. */
const READ_ONLY = /\.(list|get|search|status|summary|analyze|scan|read|statistics)$/;

export function ToolCard({ result }: { result: Extract<InvokeResult, { status: 'ok' | 'error' }> }) {
  const ok = result.status === 'ok';
  // The briefing is its own card: no tool header, no raw data.
  if (ok && result.tool === 'assistant.briefing.card') return <BriefingCard data={result.data as BriefingCardData} />;
  if (ok && result.tool === 'assistant.quality.card') return <QualityCard data={result.data as { summary: QualitySummaryData }} />;
  if (ok && result.tool === 'assistant.weekly.card') return <WeeklyCard data={result.data as WeeklyCardData} />;
  const view = ok ? ToolData({ tool: result.tool, data: result.data }) : null;
  const reminder = ok && result.tool === 'agenda.items.create' && (result.data as { kind?: string })?.kind === 'reminder';
  return (
    <div className="tool">
      <header><span><span className="sys">{reminder ? '提醒' : toolSystem(result.tool)}</span>{reminder ? '建立提醒' : toolLabel(result.tool)}</span><span className={ok ? 'status-ok' : 'status-error'}>{!ok ? '✕ 失敗' : READ_ONLY.test(result.tool) ? '✓ 已讀取' : '✓ 已完成'}</span></header>
      {ok ? (
        <>
          <Collapsible>{view}</Collapsible>
          <Links links={result.links} />
          <details><summary>原始資料</summary><pre>{JSON.stringify(result.data, null, 2)}</pre></details>
        </>
      ) : <div className="status-error">{result.message}</div>}
    </div>
  );
}

/** One label per action state, so a card never looks finished before the source system says so. */
function StateChip({ state, outcome }: { state: 'pending' | 'busy' | 'done' | 'rejected'; outcome: ConfirmResult | null }) {
  const [label, tone] = state === 'pending' ? ['待確認', 'pending']
    : state === 'busy' ? ['執行中', 'pending']
    : state === 'rejected' ? ['已取消', '']
    : outcome?.status === 'succeeded' ? ['已完成', 'ok']
    : outcome?.status === 'failed' ? ['執行失敗', 'error']
    : ['結果不明', 'pending'];
  return <span className={`state-chip ${tone}`}>{label}</span>;
}

export function ProposalCard({ result, onDone }: { result: Extract<InvokeResult, { status: 'confirmation_required' }>; onDone?: (note: string, outcome: ConfirmResult | null) => void }) {
  const [state, setState] = useState<'pending' | 'busy' | 'done' | 'rejected'>('pending');
  const [outcome, setOutcome] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState('');

  async function act(action: 'confirm' | 'reject') {
    setState('busy'); setError('');
    try {
      const response = await fetch(`/api/proposals/${result.proposalId}/${action}`, { method: 'POST' });
      const body = await response.json();
      if (!body.ok) { setError(body.error?.message ?? '操作失敗'); setState('pending'); return; }
      if (action === 'reject') { setState('rejected'); onDone?.(`使用者取消了待確認操作 ${result.proposalId}（${result.tool}），沒有執行。`, null); return; }
      const r = body.result as ConfirmResult;
      setOutcome(r); setState('done');
      onDone?.(r.status === 'succeeded'
        ? `使用者已確認 ${result.tool}（${result.proposalId}），執行成功，來源系統紀錄 ID：${r.recordId ?? '無'}。`
        : `使用者已確認 ${result.tool}（${result.proposalId}），但結果是 ${r.status}：${r.message}`, r);
    } catch {
      setError('網路錯誤，請重新整理後查看狀態，不要重複確認。'); setState('pending');
    }
  }

  return (
    <div className={`proposal proposal-${state}`}>
      <h3 style={{ display: 'flex', alignItems: 'center' }}><span className="sys">{toolSystem(result.tool)}</span>{result.preview.title}<StateChip state={state} outcome={outcome} /></h3>
      <dl>{result.preview.fields.map(field => <Fragment key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></Fragment>)}</dl>
      {result.preview.body && <pre>{result.preview.body}</pre>}
      {result.preview.warnings?.length ? <ul className="warn">{result.preview.warnings.map(w => <li key={w}>{w}</li>)}</ul> : null}
      {state === 'pending' || state === 'busy' ? (
        <div className="actions">
          <button className="primary" disabled={state === 'busy'} data-loading={state === 'busy' || undefined} onClick={() => act('confirm')}>{state === 'busy' ? '處理中…' : '確認執行'}</button>
          <button disabled={state === 'busy'} onClick={() => act('reject')}>取消</button>
        </div>
      ) : null}
      {error && <div className="result status-error">{error}</div>}
      {state === 'rejected' && <div className="result muted">已取消，沒有執行。</div>}
      {outcome?.status === 'succeeded' && (
        <div className="result status-ok">✓ 已完成。{outcome.recordId ? `紀錄 ID：${outcome.recordId}` : ''}<Links links={outcome.links} /></div>
      )}
      {outcome && outcome.status !== 'succeeded' && (
        <div className="result">
          <div className={outcome.status === 'failed' ? 'status-error' : 'status-pending'}>{outcome.status === 'failed' ? '✕ 失敗' : '⚠ 結果不明'}：{outcome.message}</div>
          {outcome.candidates?.length ? <details open><summary>可能已建立的紀錄</summary><pre>{JSON.stringify(outcome.candidates, null, 2)}</pre></details> : null}
          <Links links={outcome.links} />
        </div>
      )}
    </div>
  );
}

/** Minimal, safe Markdown: headings, bullets, **bold**. No HTML is ever injected. */
/** Inline marks the replies use: **bold**, `code`, and [label](https://…) links. Anything else stays text. */
function inlineMarks(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/**
 * The reply as clean blocks: headings, paragraphs, bullet and numbered lists, tables,
 * a closing note ("> …") and dividers, so a model's markdown never shows as raw symbols.
 */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  const key = () => `b${blocks.length}`;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { i += 1; continue; }
    // Table: a header row, a --- separator, then rows.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      blocks.push(
        <div key={key()} className="rich-table"><table>
          <thead><tr>{head.map((h, c) => <th key={c}>{inlineMarks(h)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, c) => <td key={c}>{inlineMarks(r[c] ?? '')}</td>)}</tr>)}</tbody>
        </table></div>
      );
      continue;
    }
    // Lists: consecutive items of one kind; deeper indents become a sub-level.
    const bulletRe = /^(\s*)(?:[-*•])\s+(.*)$/;
    const numberRe = /^(\s*)\d+[.)、]\s+(.*)$/;
    const listRe = bulletRe.test(line) ? bulletRe : numberRe.test(line) ? numberRe : null;
    if (listRe) {
      const items: Array<{ text: string; sub: boolean }> = [];
      // Same kind continues the list; the other kind only as an indented sub-item.
      while (i < lines.length && (listRe.test(lines[i]) || (/^\s{2,}/.test(lines[i]) && (bulletRe.test(lines[i]) || numberRe.test(lines[i]))))) {
        const m = (bulletRe.exec(lines[i]) ?? numberRe.exec(lines[i]))!;
        items.push({ text: m[2], sub: m[1].length >= 2 && items.length > 0 });
        i += 1;
      }
      const ordered = listRe === numberRe;
      const body = items.map((it, n) => <li key={n} className={it.sub ? 'sub' : undefined}>{inlineMarks(it.text)}</li>);
      blocks.push(ordered ? <ol key={key()}>{body}</ol> : <ul key={key()}>{body}</ul>);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) { blocks.push(<h4 key={key()}>{inlineMarks(heading[1].replace(/\*\*/g, ''))}</h4>); i += 1; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(<hr key={key()} />); i += 1; continue; }
    const note = /^\s*>\s?(.*)$/.exec(line);
    if (note) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push(<p key={key()} className="rich-note">{inlineMarks(parts.join(' '))}</p>);
      continue;
    }
    blocks.push(<p key={key()}>{inlineMarks(line)}</p>);
    i += 1;
  }
  return <div className="rich">{blocks}</div>;
}
