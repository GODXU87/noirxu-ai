'use client';

import { Fragment, useRef, useState } from 'react';

interface Link { label: string; url: string }
interface Preview { title: string; fields: Array<{ label: string; value: string }>; body?: string; warnings?: string[] }
type InvokeResult =
  | { status: 'ok'; tool: string; data: unknown; links: Link[] }
  | { status: 'confirmation_required'; tool: string; proposalId: string; preview: Preview; expiresAt: string }
  | { status: 'error'; tool: string; code: string; message: string };
type ConfirmResult =
  | { status: 'succeeded'; tool: string; proposalId: string; data: unknown; recordId?: string; links: Link[] }
  | { status: 'failed' | 'outcome_unknown'; tool: string; proposalId: string; code: string; message: string; candidates?: unknown[]; links: Link[] };

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; result: InvokeResult };

function Links({ links }: { links: Link[] }) {
  if (!links?.length) return null;
  return <div className="links">{links.map(link => <a key={link.url + link.label} href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a>)}</div>;
}

function ToolCard({ result }: { result: Extract<InvokeResult, { status: 'ok' | 'error' }> }) {
  const ok = result.status === 'ok';
  return (
    <div className="tool">
      <header><code>{result.tool}</code><span className={ok ? 'status-ok' : 'status-error'}>{ok ? '已讀取' : `失敗 · ${result.code}`}</span></header>
      {ok ? (
        <>
          <Links links={result.links} />
          <details><summary>原始資料</summary><pre>{JSON.stringify(result.data, null, 2)}</pre></details>
        </>
      ) : <div className="status-error">{result.message}</div>}
    </div>
  );
}

function ProposalCard({ result, onDone }: { result: Extract<InvokeResult, { status: 'confirmation_required' }>; onDone: (note: string) => void }) {
  const [state, setState] = useState<'pending' | 'busy' | 'done' | 'rejected'>('pending');
  const [outcome, setOutcome] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState('');

  async function act(action: 'confirm' | 'reject') {
    setState('busy'); setError('');
    try {
      const response = await fetch(`/api/proposals/${result.proposalId}/${action}`, { method: 'POST' });
      const body = await response.json();
      if (!body.ok) { setError(body.error?.message ?? '操作失敗'); setState('pending'); return; }
      if (action === 'reject') { setState('rejected'); onDone(`使用者取消了待確認操作 ${result.proposalId}（${result.tool}），沒有執行。`); return; }
      const r = body.result as ConfirmResult;
      setOutcome(r); setState('done');
      onDone(r.status === 'succeeded'
        ? `使用者已確認 ${result.tool}（${result.proposalId}），執行成功，來源系統紀錄 ID：${r.recordId ?? '無'}。`
        : `使用者已確認 ${result.tool}（${result.proposalId}），但結果是 ${r.status}：${r.message}`);
    } catch {
      setError('網路錯誤，請重新整理後查看狀態，不要重複確認。'); setState('pending');
    }
  }

  return (
    <div className="proposal">
      <h3>{result.preview.title}</h3>
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
      {state === 'rejected' && <div className="result">已取消，沒有執行。</div>}
      {outcome?.status === 'succeeded' && (
        <div className="result status-ok">已完成。{outcome.recordId ? `紀錄 ID：${outcome.recordId}` : ''}<Links links={outcome.links} /></div>
      )}
      {outcome && outcome.status !== 'succeeded' && (
        <div className="result">
          <div className={outcome.status === 'failed' ? 'status-error' : 'status-pending'}>{outcome.status === 'failed' ? '失敗' : '結果不明'}：{outcome.message}</div>
          {outcome.candidates?.length ? <details open><summary>可能已建立的紀錄</summary><pre>{JSON.stringify(outcome.candidates, null, 2)}</pre></details> : null}
          <Links links={outcome.links} />
        </div>
      )}
    </div>
  );
}

export function Chat() {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const feedEnd = useRef<HTMLDivElement>(null);

  const scroll = () => setTimeout(() => feedEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true); setText('');
    setItems(prev => [...prev, { kind: 'user', text: message }]); scroll();
    const payload = notes.length ? `[系統紀錄]\n${notes.join('\n')}\n\n${message}` : message;
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: payload, history }) });
      const body = await response.json();
      if (!body.ok) { setItems(prev => [...prev, { kind: 'error', text: body.error?.message ?? '發生錯誤' }]); return; }
      setNotes([]);
      setHistory(body.messages);
      setItems(prev => [
        ...prev,
        ...body.events.map((e: { result: InvokeResult }) => ({ kind: 'tool' as const, result: e.result })),
        ...(body.reply ? [{ kind: 'assistant' as const, text: body.reply }] : [])
      ]);
    } catch {
      setItems(prev => [...prev, { kind: 'error', text: '網路錯誤，訊息沒有送出。' }]);
    } finally {
      setBusy(false); scroll();
    }
  }

  return (
    <>
      <main className="feed">
        {items.length === 0 && <p className="hint">例如：「今天午餐 150 元，幫我記帳」、「這個月花了多少？哪一類最多？」、「RADAR 今天有哪些股票值得觀察？」、「找出今天需要回覆的 Gmail」。</p>}
        {items.map((item, index) => {
          if (item.kind === 'tool') {
            return item.result.status === 'confirmation_required'
              ? <ProposalCard key={index} result={item.result} onDone={note => setNotes(prev => [...prev, note])} />
              : <ToolCard key={index} result={item.result} />;
          }
          return <div key={index} className={`msg ${item.kind}`}>{item.text}</div>;
        })}
        {busy && <div className="hint">處理中…</div>}
        <div ref={feedEnd} />
      </main>
      <div className="composer">
        <form onSubmit={send}>
          <button type="button" onClick={() => { setItems([]); setHistory([]); setNotes([]); }} title="開新對話">新</button>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="輸入訊息…" rows={1}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(e); } }} />
          <button className="primary" type="submit" disabled={busy || !text.trim()}>送出</button>
        </form>
      </div>
    </>
  );
}
