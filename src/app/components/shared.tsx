'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { money, toolLabel, toolSystem } from '@/lib/tool-labels';
import { Icon } from './Icon';

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
export async function callTool(name: string, input: unknown = {}): Promise<InvokeResult> {
  try {
    const response = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    });
    const body = await response.json();
    if (!body.ok) return { status: 'error', tool: name, code: body.error?.code ?? 'ERROR', message: body.error?.message ?? '發生錯誤' };
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
        <button className="primary grow" disabled={busy}>儲存</button>
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
      return (
        <div className="view">
          <AgendaList items={[data.item]} />
          {data.reminders?.length ? <p className="hint">會提醒：{data.reminders.map((r: any) => `${new Date(r.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（${r.label}）`).join('、')}</p> : <p className="hint">沒有日期，不會自動提醒。</p>}
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
    case 'radar.status':
      return <div className="view"><p className="hint">最新資料交易日：<b>{data.publication?.trade_date ?? '—'}</b></p></div>;
    default:
      return null;
  }
}

export function ToolCard({ result }: { result: Extract<InvokeResult, { status: 'ok' | 'error' }> }) {
  const ok = result.status === 'ok';
  const view = ok ? ToolData({ tool: result.tool, data: result.data }) : null;
  return (
    <div className="tool">
      <header><span><span className="sys">{toolSystem(result.tool)}</span>{toolLabel(result.tool)}</span><span className={ok ? 'status-ok' : 'status-error'}>{ok ? '✓ 已讀取' : '✕ 失敗'}</span></header>
      {ok ? (
        <>
          {view}
          <Links links={result.links} />
          <details><summary>原始資料</summary><pre>{JSON.stringify(result.data, null, 2)}</pre></details>
        </>
      ) : <div className="status-error">{result.message}</div>}
    </div>
  );
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
      <h3><span className="sys">{toolSystem(result.tool)}</span>{result.preview.title}</h3>
      <dl>{result.preview.fields.map(field => <Fragment key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></Fragment>)}</dl>
      {result.preview.body && <pre>{result.preview.body}</pre>}
      {result.preview.warnings?.length ? <ul className="warn">{result.preview.warnings.map(w => <li key={w}>{w}</li>)}</ul> : null}
      {state === 'pending' || state === 'busy' ? (
        <div className="actions">
          <button className="primary" disabled={state === 'busy'} onClick={() => act('confirm')}>{state === 'busy' ? '處理中…' : '確認執行'}</button>
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
export function RichText({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`l${blocks.length}`}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>); list = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1])}</h4>);
    else if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <div className="rich">{blocks}</div>;
}
