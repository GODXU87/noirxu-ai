'use client';

import { useEffect, useRef, useState } from 'react';
import { ProposalCard, RichText, ToolCard, type InvokeResult } from './components/shared';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; result: InvokeResult };

const STORAGE_KEY = 'noirxu-ai-chat-v1';

const EXAMPLES = [
  { label: '記下一件事', text: '11/11 要教學演示，很重要。' },
  { label: '最近有什麼事', text: '最近有什麼事？依重要程度排給我。' },
  { label: '我的資產', text: '幫我分析目前的資產配置和淨資產。' },
  { label: '記一筆午餐', text: '今天午餐 150 元，幫我記帳。' },
  { label: '這個月花費', text: '這個月花了多少錢？哪一類最多？' },
  { label: '新增交易紀錄', text: '今天買進一筆股票，幫我加入交易紀錄。' },
  { label: '近一個月績效', text: '幫我分析最近一個月的交易績效。' },
  { label: 'RADAR 今日觀察', text: 'RADAR 今天有哪些股票值得觀察？' },
  { label: '個股分析', text: '分析 2330 的均線、量價與資金流向。' },
  { label: '待回覆的信', text: '幫我找出今天需要回覆的 Gmail。' },
  { label: '寫信', text: '幫我寫一封信，確認後再寄出。' },
  { label: '整合報告', text: '整合 Ledger、Journal 與 RADAR，產生個人財務和市場研究報告。' }
];

interface Saved { items: Item[]; history: unknown[]; notes: string[] }

function load(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Saved : null;
  } catch {
    return null;
  }
}

export function Chat({ connected }: { connected: Record<string, boolean> }) {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const feedEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const saved = load();
    if (saved) { setItems(saved.items); setHistory(saved.history); setNotes(saved.notes); }
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ items, history, notes })); } catch { /* storage unavailable */ }
  }, [items, history, notes]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const scroll = () => setTimeout(() => feedEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  async function send(message: string) {
    message = message.trim();
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

  function reset() {
    setItems([]); setHistory([]); setNotes([]);
  }

  const systems = [['ledger', 'Ledger'], ['journal', 'Journal'], ['radar', 'RADAR'], ['gmail', 'Gmail']] as const;

  return (
    <>
      <main className="feed">
        {items.length === 0 && (
          <section className="welcome">
            <h1>想查什麼、記什麼？</h1>
            <p className="hint">直接用一句話說。寫入資料和寄信都會先給你確認。</p>
            <div className="status-row">
              {systems.map(([id, label]) => <a key={id} href="/connections" className={`pill ${connected[id] ? 'on' : ''}`}>{connected[id] ? '●' : '○'} {label}</a>)}
            </div>
            <div className="chips">{EXAMPLES.map(example => <button key={example.label} onClick={() => { setText(example.text); input.current?.focus(); }}>{example.label}</button>)}</div>
          </section>
        )}
        {items.map((item, index) => {
          if (item.kind === 'tool') {
            return item.result.status === 'confirmation_required'
              ? <ProposalCard key={index} result={item.result} onDone={note => setNotes(prev => [...prev, note])} />
              : <ToolCard key={index} result={item.result} />;
          }
          if (item.kind === 'assistant') return <div key={index} className="msg assistant"><RichText text={item.text} /></div>;
          return <div key={index} className={`msg ${item.kind}`}>{item.text}</div>;
        })}
        {busy && <div className="typing" aria-label="處理中"><span /><span /><span /></div>}
        <div ref={feedEnd} />
      </main>
      <div className="composer">
        <form onSubmit={event => { event.preventDefault(); void send(text); }}>
          {items.length > 0 && <button type="button" className="ghost" onClick={reset} title="開新對話" aria-label="開新對話">＋</button>}
          <textarea ref={input} value={text} onChange={e => setText(e.target.value)} placeholder="輸入訊息…" rows={1}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} />
          <button className="primary" type="submit" disabled={busy || !text.trim()}>送出</button>
        </form>
      </div>
    </>
  );
}
