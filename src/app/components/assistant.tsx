'use client';

import { Fragment, useState } from 'react';
import { money, taipeiToday, toolLabel } from '@/lib/tool-labels';
import { Icon } from './Icon';
import { AgendaList, callTool, Collapsible, Links, ProposalCard, type AgendaView, type InvokeResult } from './shared';

// Cards for the assistant tools. Every action button here starts the normal flow:
// agenda items are NOIRXU AI's own notes; Ledger and Gmail still need the confirmation card.

const EXPENSE_METHODS = ['信用卡', '現金', '轉帳', 'LINE Pay', 'Apple Pay', '悠遊卡'];
const INCOME_METHODS = ['轉帳', '現金', 'LINE Pay', '其他'];
const KIND_LABEL: Record<string, string> = { event: '行程', todo: '待辦', finance: '財務', info: '重要資訊', reply: '需要回覆' };
const STYLE_LABEL: Record<string, string> = { positive: '正向回覆', decline: '婉拒／改期', formal: '正式商務', short: '簡短回覆' };

interface Field { label: string; value: string; evidence?: string; reason?: string }
type Proposal = Extract<InvokeResult, { status: 'confirmation_required' }>;
type Note = (note: string) => void;

function FieldList({ facts, guesses, missing }: { facts: Field[]; guesses: Field[]; missing: string[] }) {
  if (!facts.length && !guesses.length && !missing.length) return null;
  return (
    <dl className="fields">
      {facts.map((f, i) => <Fragment key={`f${i}`}><dt>{f.label}</dt><dd>{f.value}{f.evidence && f.evidence !== f.value ? <span className="muted">（原文「{f.evidence}」）</span> : null}</dd></Fragment>)}
      {guesses.map((f, i) => <Fragment key={`g${i}`}><dt>{f.label}</dt><dd><span className="tag guess">推測</span>{f.value}{f.reason ? <span className="muted">（{f.reason}）</span> : null}</dd></Fragment>)}
      {missing.length > 0 && <><dt>缺少</dt><dd className="status-pending">{missing.join('、')}</dd></>}
    </dl>
  );
}

function Warnings({ items }: { items?: string[] }) {
  return items?.length ? <ul className="warn-list">{items.map(w => <li key={w}>{w}</li>)}</ul> : null;
}

/* ---------- 記帳草稿 ---------- */

interface Category { id: string; type: 'expense' | 'income'; name: string }
interface Draft {
  type: 'expense' | 'income'; amount: number | null; occurred_on: string; payment_method: string | null;
  category_id: string | null; note: string; facts: Field[]; guesses: Field[]; missing: string[]; warnings: string[];
}

export function LedgerDraftCard({ draft, categories, ledger, onNote }: { draft: Draft; categories: Category[]; ledger: string; onNote?: Note }) {
  const [type, setType] = useState(draft.type);
  const [form, setForm] = useState({
    amount: draft.amount ? String(draft.amount) : '',
    category_id: draft.category_id ?? '',
    occurred_on: draft.occurred_on,
    payment_method: draft.payment_method ?? (draft.type === 'expense' ? '現金' : '轉帳'),
    merchant: '',
    note: draft.note
  });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm(prev => ({ ...prev, [key]: value }));
  const methods = type === 'expense' ? EXPENSE_METHODS : INCOME_METHODS;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    const result = await callTool(`ledger.${type}.create`, {
      amount: Number(form.amount), category_id: form.category_id, occurred_on: form.occurred_on,
      payment_method: form.payment_method, merchant: form.merchant, note: form.note
    });
    setBusy(false);
    if (result.status === 'confirmation_required') setProposal(result);
    else if (result.status === 'error') setError(result.message);
  }

  if (proposal) return <ProposalCard result={proposal} onDone={note => onNote?.(note)} />;
  return (
    <div className="tool">
      <header><span><span className="sys">Ledger</span>記帳草稿</span><span className="tag guess">尚未寫入</span></header>
      <FieldList facts={draft.facts} guesses={draft.guesses} missing={draft.missing} />
      <Warnings items={draft.warnings} />
      {ledger !== 'ok' ? (
        <p className="hint">{ledger === 'not_connected' ? 'Ledger 尚未連接，無法記帳。請先到「連線」頁面連接 Ledger。' : '讀取 Ledger 分類失敗，請稍後再試。'}</p>
      ) : (
        <form className="entry" onSubmit={submit}>
          <span className="seg" style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>
            <button type="button" className={type === 'expense' ? 'on' : ''} onClick={() => { setType('expense'); set('category_id', ''); set('payment_method', '現金'); }}>支出</button>
            <button type="button" className={type === 'income' ? 'on' : ''} onClick={() => { setType('income'); set('category_id', ''); set('payment_method', '轉帳'); }}>收入</button>
          </span>
          <label className="amount"><span>金額（TWD）</span><input inputMode="decimal" type="number" min="0" step="any" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0" required /></label>
          <label><span>分類</span>
            <select value={form.category_id} onChange={e => set('category_id', e.target.value)} required>
              <option value="">選擇分類</option>
              {categories.filter(c => c.type === type).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label><span>日期</span><input type="date" value={form.occurred_on} max={taipeiToday()} onChange={e => set('occurred_on', e.target.value)} required /></label>
          <label><span>付款方式</span><select value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>{methods.map(m => <option key={m}>{m}</option>)}</select></label>
          <label><span>備註</span><input value={form.note} maxLength={200} onChange={e => set('note', e.target.value)} /></label>
          {error && <p className="status-error">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? '處理中…' : '建立待確認記帳'}</button>
        </form>
      )}
    </div>
  );
}

/* ---------- 文字分診 ---------- */

interface Triage {
  items: Array<{ kind: string; title: string; evidence: string; facts: Field[]; guesses: Field[]; missing: string[] }>;
  contacts: { emails: string[]; phones: string[]; urls: string[] };
  actions: Array<{ type: string; label: string; payload: Record<string, unknown> }>;
  injection_signals: string[];
  warnings: string[];
}

function TriageAction({ action, onNote, onReply }: { action: Triage['actions'][number]; onNote?: Note; onReply?: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [ledger, setLedger] = useState<InvokeResult | null>(null);

  async function run() {
    if (action.type === 'reply.draft') { onReply?.(); return; }
    setState('busy');
    if (action.type === 'agenda.create') {
      const result = await callTool('agenda.items.create', action.payload);
      if (result.status === 'ok') { setState('done'); setMessage('已加入記事'); onNote?.(`使用者從分診結果加入了記事：${String(action.payload.title)}`); }
      else { setState('error'); setMessage(result.status === 'error' ? result.message : '失敗'); }
    } else if (action.type === 'ledger.draft') {
      const result = await callTool('assistant.ledger.draft', action.payload);
      setLedger(result); setState(result.status === 'ok' ? 'done' : 'error');
      if (result.status === 'error') setMessage(result.message);
    }
  }

  return (
    <li>
      <div className="action-row">
        <span>{action.label}</span>
        {state === 'done' && !ledger ? <span className="status-ok">✓ {message}</span>
          : <button type="button" className="ghost" disabled={state === 'busy' || Boolean(ledger)} onClick={() => void run()}>{state === 'busy' ? '處理中…' : action.type === 'agenda.create' ? '加入記事' : action.type === 'ledger.draft' ? '整理記帳' : '擬回覆'}</button>}
      </div>
      {state === 'error' && <p className="status-error">{message}</p>}
      {ledger?.status === 'ok' && <LedgerDraftCard {...(ledger.data as { draft: Draft; categories: Category[]; ledger: string })} onNote={onNote} />}
    </li>
  );
}

function TriageView({ data, onNote, onReply }: { data: Triage; onNote?: Note; onReply?: () => void }) {
  const contacts = [...data.contacts.emails, ...data.contacts.phones, ...data.contacts.urls];
  const counts = Object.entries(data.items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {}));
  return (
    <div className="view">
      {counts.length > 0 && <p className="headline">找到 {counts.map(([kind, n]) => `${n} 項${KIND_LABEL[kind] ?? kind}`).join('、')}{data.actions.length ? `，有 ${data.actions.length} 個建議操作等你決定` : ''}。</p>}
      {data.injection_signals.length > 0 && <p className="banner danger" style={{ margin: 0 }}>⚠ 內容含有疑似指令（{data.injection_signals.join('、')}）。已當作一般文字，不會照做。</p>}
      {data.items.length === 0 && <p className="hint">沒有找到行程、待辦、金額或需要回覆的內容。</p>}
      {data.items.map((item, i) => (
        <div key={i} className="triage-item">
          <p><span className={`tag kind-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>{item.title}</p>
          <FieldList facts={item.facts} guesses={item.guesses} missing={item.missing} />
        </div>
      ))}
      {contacts.length > 0 && <p className="hint">原文中的聯絡資訊：{contacts.join('、')}</p>}
      <Warnings items={data.warnings.filter(w => !w.startsWith('內容含有疑似指令'))} />
      {data.actions.length > 0 && (
        <>
          <p className="section-label" style={{ margin: 0 }}>建議操作<span className="tag guess" style={{ marginLeft: 8 }}>建議中</span></p>
          <ul className="actions-list">{data.actions.map((action, i) => <TriageAction key={i} action={action} onNote={onNote} onReply={onReply} />)}</ul>
        </>
      )}
    </div>
  );
}

/* ---------- 早報／晚報 ---------- */

function Section({ title, items, empty }: { title: string; items: AgendaView[]; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <div>
      <p className="section-label" style={{ margin: '0 0 4px' }}>{title}</p>
      {items.length ? <AgendaList items={items} /> : <p className="hint">{empty}</p>}
    </div>
  );
}

function MorningView({ data }: { data: any }) {
  return (
    <div className="view">
      <Section title="最重要的三件事" items={data.top3} empty="目前沒有待辦事項。" />
      <Section title="已過期" items={data.overdue} />
      <Section title="今天" items={data.today_items} />
      <Section title="接下來三天" items={data.upcoming} />
      {data.ledger && (
        <div>
          <p className="section-label" style={{ margin: '0 0 4px' }}>本月收支</p>
          <p className="hint">支出 {data.ledger.currency} {money(data.ledger.expense)} · 收入 {money(data.ledger.income)}</p>
          {data.ledger.budget_warnings.map((w: any) => <p key={w.name} className="status-pending" style={{ margin: 0, fontSize: 13 }}>{w.name} 預算已用 {w.percentage}%{w.status === 'over' ? '（超支）' : ''}</p>)}
        </div>
      )}
      {data.open_positions != null && <p className="hint">Journal 未平倉 {data.open_positions} 筆</p>}
      <WaterLine water={data.water} />
      {data.gmail?.status === 'ok' && (
        <div>
          <p className="section-label" style={{ margin: '0 0 4px' }}>今天的未讀信</p>
          {data.gmail.unread.length ? <ul className="rows mail">{data.gmail.unread.map((m: any) => <li key={m.id}><span>{m.from}</span><span>{m.subject || '（無主旨）'}</span></li>)}</ul> : <p className="hint">沒有未讀信。</p>}
        </div>
      )}
      <p className="hint">資料來源：{data.sources.map((s: any) => `${s.name}${s.included ? ' ✓' : `（${s.note ?? '未納入'}）`}`).join(' · ')}</p>
    </div>
  );
}

function EveningView({ data }: { data: any }) {
  return (
    <div className="view">
      <Section title="今天完成" items={data.done_today} empty="今天沒有標記完成的事項。" />
      <Section title="今天到期、尚未完成" items={data.still_open_today} />
      <Section title="已過期" items={data.overdue} />
      <Section title="明天" items={data.tomorrow} />
      {data.suggestions.length > 0 && (
        <div>
          <p className="section-label" style={{ margin: '0 0 4px' }}>明天建議先做</p>
          <ol className="suggest-list">{data.suggestions.map((s: any) => <li key={s.id}>{s.title}<span className="muted"> — {s.reason}</span></li>)}</ol>
        </div>
      )}
      <WaterLine water={data.water} />
      <p className="hint">{data.note}</p>
    </div>
  );
}

/* ---------- 回覆草稿 ---------- */

function ReplyDraftsView({ data, onNote }: { data: any; onNote?: Note }) {
  const [copied, setCopied] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState('');

  async function prepare(index: number) {
    const d = data.drafts[index];
    setError('');
    const result = await callTool('gmail.message.send', { to: data.to, subject: d.subject || '（無主旨）', body: d.body, ...(data.reply_to_message_id ? { reply_to_message_id: data.reply_to_message_id } : {}) });
    if (result.status === 'confirmation_required') setProposal(result);
    else if (result.status === 'error') setError(result.message);
  }

  if (proposal) return <ProposalCard result={proposal} onDone={note => onNote?.(note)} />;
  return (
    <div className="view">
      {data.context && <p className="hint">{data.context}</p>}
      {data.drafts.map((d: any, i: number) => (
        <div key={i} className="draft">
          <p className="section-label" style={{ margin: 0 }}>{data.drafts.length > 1 ? STYLE_LABEL[d.style] ?? d.style : '回覆草稿'}</p>
          {d.subject && <p style={{ margin: 0 }}><span className="muted">主旨　</span>{d.subject}</p>}
          <pre>{d.body}</pre>
          <div className="row">
            <button type="button" className="ghost" onClick={() => { void navigator.clipboard?.writeText(d.body).then(() => setCopied(i)); }}>{copied === i ? '已複製' : '複製'}</button>
            {data.to?.length > 0 && <button type="button" onClick={() => void prepare(i)}>準備寄出（寄給 {data.to.join(', ')}）</button>}
          </div>
        </div>
      ))}
      {error && <p className="status-error">{error}</p>}
      <p className="hint">尚未寄出。{data.to?.length ? '按「準備寄出」會先顯示確認卡片。' : '沒有收件人資訊，請複製後自行貼上。'}</p>
    </div>
  );
}

/* ---------- 喝水 ---------- */

const fmt = (n: number) => Number(n).toLocaleString('en-US');

export function WaterMeter({ data, onChange, compact }: { data: any; onChange?: (next: any) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(tool: string, input: unknown) {
    setBusy(true); setError('');
    const result = await callTool(tool, input);
    setBusy(false);
    if (result.status === 'ok') onChange?.(result.data);
    else if (result.status === 'error') setError(result.message);
  }
  return (
    <div className={`water ${compact ? 'compact' : ''}`}>
      <div className="water-head">
        <span className="water-icon"><Icon name="drop" size={compact ? 16 : 18} /></span>
        <b>{fmt(data.total_ml)}</b><span className="muted"> / {fmt(data.goal_ml)} ml</span>
        <span className="water-actions">
          {[250, 500].map(ml => <button key={ml} type="button" className="ghost" disabled={busy} onClick={() => void act('health.water.log', { ml })}>+{ml}</button>)}
        </span>
      </div>
      <div className="bar"><span className="bar-accent" style={{ width: `${data.percent}%` }} /></div>
      {!compact && (
        <>
          <p className="hint">
            {data.remaining_ml === 0 ? '今天的目標已達成。' : data.behind_ml > 0 ? `照進度現在應到 ${fmt(data.expected_ml)} ml，落後 ${fmt(data.behind_ml)} ml。` : `進度正常，還差 ${fmt(data.remaining_ml)} ml。`}
            {data.logged_ml ? ` 已記錄 ${data.logged_ml} ml。` : ''}{data.removed_ml ? ` 已刪除 ${data.removed_ml} ml。` : ''}{data.removed_ml === null ? ' 今天沒有可以刪除的紀錄。' : ''}
          </p>
          <div className="row">
            <span className="hint">提醒：{data.prefs.enabled ? `${data.prefs.start}–${data.prefs.end} 每 ${data.prefs.interval_hours} 小時（進度落後時才推播）` : '已關閉'}</span>
            <button type="button" className="link" disabled={busy} onClick={() => void act('health.water.settings', { enabled: !data.prefs.enabled })}>{data.prefs.enabled ? '關閉提醒' : '開啟提醒'}</button>
            {data.entries.length > 0 && <button type="button" className="link" disabled={busy} onClick={() => void act('health.water.undo', {})}>刪除上一筆</button>}
          </div>
        </>
      )}
      {error && <p className="status-error">{error}</p>}
    </div>
  );
}

function WaterCard({ initial }: { initial: any }) {
  const [data, setData] = useState(initial);
  return <WaterMeter data={data} onChange={setData} />;
}

function WaterLine({ water }: { water: any }) {
  if (!water) return null;
  return (
    <div>
      <p className="section-label" style={{ margin: '0 0 4px' }}>喝水</p>
      <p className="hint">今天 {fmt(water.total_ml)} / {fmt(water.goal_ml)} ml（{water.percent}%）{water.reminders ? ` · 提醒 ${water.reminders}` : ' · 提醒已關閉'}</p>
    </div>
  );
}

/* ---------- 入口 ---------- */

export function AssistantCard({ result, onNote, onReply }: { result: Extract<InvokeResult, { status: 'ok' }>; onNote?: Note; onReply?: () => void }) {
  const data = result.data as any;
  if (result.tool === 'assistant.ledger.draft') return <LedgerDraftCard draft={data.draft} categories={data.categories} ledger={data.ledger} onNote={onNote} />;
  const body = result.tool === 'assistant.text.triage' ? <TriageView data={data} onNote={onNote} onReply={onReply} />
    : result.tool === 'assistant.briefing.morning' ? <MorningView data={data} />
    : result.tool === 'assistant.briefing.evening' ? <EveningView data={data} />
    : result.tool === 'assistant.reply.drafts' ? <ReplyDraftsView data={data} onNote={onNote} />
    : result.tool.startsWith('health.water.') ? <WaterCard initial={data} />
    : <pre>{JSON.stringify(data, null, 2)}</pre>;
  const title = result.tool === 'assistant.briefing.morning' ? `早報 · ${data.today}` : result.tool === 'assistant.briefing.evening' ? `晚報 · ${data.today}` : toolLabel(result.tool);
  return (
    <div className="tool">
      <header><span><span className="sys">{result.tool.startsWith('health.') ? '健康' : '助理'}</span>{title}</span></header>
      <Collapsible limit={420}>{body}</Collapsible>
      <Links links={result.links} />
    </div>
  );
}
