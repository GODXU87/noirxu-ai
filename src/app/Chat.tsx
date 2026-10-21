'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { ProposalCard, RichText, ToolCard, type InvokeResult } from './components/shared';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; result: InvokeResult };

const STORAGE_KEY = 'noirxu-ai-chat-v1';

const SUGGESTIONS: Array<{ group: string; items: string[] }> = [
  { group: '記帳與資產', items: ['今天午餐 150 元，幫我記帳。', '這個月花了多少錢？哪一類最多？', '幫我分析目前的資產配置和淨資產。'] },
  { group: '記事與提醒', items: ['11/11 要教學演示，很重要。', '最近有什麼事？依重要程度排給我。'] },
  { group: '交易紀錄', items: ['今天買進一筆股票，幫我加入交易紀錄。', '幫我分析最近一個月的交易績效。'] },
  { group: '市場研究與郵件', items: ['RADAR 今天有哪些股票值得觀察？', '幫我找出今天需要回覆的 Gmail。', '整合 Ledger、Journal 與 RADAR，產生個人財務和市場研究報告。'] }
];

const SYSTEMS = [['ledger', 'Ledger'], ['journal', 'Journal'], ['radar', 'RADAR'], ['gmail', 'Gmail']] as const;

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

  function pick(example: string) {
    setText(example);
    input.current?.focus();
  }

  return (
    <>
      <main className="feed">
        {items.length === 0 && (
          <section className="welcome">
            <div>
              <p className="eyebrow">NOIRXU AI</p>
              <h1>想查什麼、記什麼？</h1>
            </div>
            <p className="lead">直接用一句話說。寫入資料和寄信前，都會先給你確認。</p>
            <div className="status-row">
              {SYSTEMS.map(([id, label]) => <a key={id} href="/connections" className={`pill ${connected[id] ? 'on' : ''}`}><span className={`dot ${connected[id] ? 'on' : ''}`} />{label}</a>)}
            </div>
            <div className="suggest">
              {SUGGESTIONS.map(group => (
                <div key={group.group} className="suggest-group">
                  <p>{group.group}</p>
                  {group.items.map(example => <button key={example} type="button" onClick={() => pick(example)}>{example}</button>)}
                </div>
              ))}
            </div>
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
          {items.length > 0 && <button type="button" className="icon-button" onClick={() => { setItems([]); setHistory([]); setNotes([]); }} aria-label="開新對話" title="開新對話"><Icon name="plus" size={18} /></button>}
          <textarea ref={input} value={text} onChange={e => setText(e.target.value)} placeholder="輸入訊息…" rows={1} aria-label="訊息"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} />
          <button className="primary" type="submit" disabled={busy || !text.trim()} aria-label="送出"><Icon name="send" size={18} /></button>
        </form>
      </div>
    </>
  );
}
