'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { parseCommand, type CommandName } from '@/assistant/commands';
import type { FeatureFlags } from '@/lib/features';
import { money } from '@/lib/tool-labels';
import { BrandMark, Icon } from './components/Icon';
import { AssistantCard } from './components/assistant';
import { callTool, ProposalCard, RichText, ToolCard, type InvokeResult } from './components/shared';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; result: InvokeResult }
  | { kind: 'notice'; text: string }
  | { kind: 'help'; items: Array<{ command: string; description: string }> };

export type ReplyStyle = 'professional' | 'concise' | 'butler';
const STYLES: Array<[ReplyStyle, string]> = [['professional', '專業'], ['concise', '簡潔'], ['butler', '管家']];

const STORAGE_KEY = 'noirxu-ai-chat-v1';
const STYLE_KEY = 'noirxu-ai-style';

/** Shown in the "/" menu. `fill` is what lands in the input; commands with no argument run at once. */
const PALETTE: Array<{ command: string; fill: string; label: string; run: boolean; feature: keyof FeatureFlags }> = [
  { command: '/早報', fill: '/早報', label: '今天的行程、最重要的三件事、逾期與提醒', run: true, feature: 'briefings' },
  { command: '/晚報', fill: '/晚報', label: '今天完成了什麼、明天先做什麼', run: true, feature: 'briefings' },
  { command: '/記帳', fill: '/記帳 ', label: '一句話記帳，確認後才寫入 Ledger', run: false, feature: 'commands' },
  { command: '/分診', fill: '/分診 ', label: '貼上訊息，找出行程、待辦、帳單與要回覆的事', run: false, feature: 'triage' },
  { command: '/回覆', fill: '/回覆 ', label: '貼上信件，擬回覆草稿（需要 AI）', run: false, feature: 'reply_drafts' },
  { command: '/說明', fill: '/說明', label: '所有快捷指令', run: true, feature: 'commands' }
];

const CHIPS: Array<{ label: string; text: string; run: boolean; feature?: keyof FeatureFlags }> = [
  { label: '早報', text: '/早報', run: true, feature: 'briefings' },
  { label: '最近有什麼事', text: '最近有什麼事？依重要程度排給我。', run: true },
  { label: '記一筆帳', text: '/記帳 ', run: false, feature: 'commands' },
  { label: '整理一段訊息', text: '/分診 ', run: false, feature: 'triage' },
  { label: '這個月花了多少', text: '這個月花了多少錢？哪一類最多？', run: true },
  { label: '晚報', text: '/晚報', run: true, feature: 'briefings' }
];

const WORKING: Partial<Record<CommandName, string>> = {
  morning: '正在整理早報', evening: '正在整理晚報', ledger: '正在整理記帳草稿', triage: '正在分析文字', help: '讀取指令'
};

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

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 5 ? '夜深了' : hour < 11 ? '早安' : hour < 14 ? '午安' : hour < 18 ? '下午好' : '晚上好';
}

interface Brief { lines: string[]; top: Array<{ id: string; title: string; due_label: string; priority: string }> }

/** One-line status for the home screen, from the same morning report as /早報. */
function useBrief(enabled: boolean) {
  const [brief, setBrief] = useState<Brief | null>(null);
  useEffect(() => {
    if (!enabled) return;
    void callTool('assistant.briefing.morning', {}).then(result => {
      if (result.status !== 'ok') return;
      const d = result.data as any;
      const lines: string[] = [];
      lines.push(d.today_items.length ? `今天 ${d.today_items.length} 件事` : '今天沒有排定的事');
      if (d.overdue.length) lines.push(`${d.overdue.length} 件已過期`);
      if (d.ledger) lines.push(`本月支出 ${d.ledger.currency} ${money(d.ledger.expense)}`);
      if (d.ledger?.budget_warnings?.length) lines.push(`${d.ledger.budget_warnings.length} 項預算接近上限`);
      if (d.gmail?.status === 'ok' && d.gmail.unread.length) lines.push(`${d.gmail.unread.length} 封未讀信`);
      setBrief({ lines, top: d.top3 });
    });
  }, [enabled]);
  return brief;
}

/** Splits the feed into turns: each user message followed by everything the assistant produced. */
function turns(items: Item[]) {
  const out: Array<{ user?: Extract<Item, { kind: 'user' }>; userIndex: number; replies: Array<{ item: Item; index: number }> }> = [];
  items.forEach((item, index) => {
    if (item.kind === 'user') out.push({ user: item, userIndex: index, replies: [] });
    else {
      if (!out.length) out.push({ userIndex: -1, replies: [] });
      out[out.length - 1].replies.push({ item, index });
    }
  });
  return out;
}

export function Chat({ connected, features }: { connected: Record<string, boolean>; features: FeatureFlags }) {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [style, setStyle] = useState<ReplyStyle>('professional');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const feedEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const empty = items.length === 0;
  const brief = useBrief(empty && features.briefings);

  useEffect(() => {
    const saved = load();
    if (saved) { setItems(saved.items); setHistory(saved.history); setNotes(saved.notes); }
    try { const s = localStorage.getItem(STYLE_KEY) as ReplyStyle | null; if (s && STYLES.some(([id]) => id === s)) setStyle(s); } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ items, history, notes })); } catch { /* storage unavailable */ }
  }, [items, history, notes]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const palette = useMemo(() => {
    if (!features.commands || !/^[/／][^\s]*$/.test(text)) return [];
    const word = text.slice(1);
    return PALETTE.filter(p => features[p.feature] && p.command.slice(1).startsWith(word));
  }, [text, features]);
  useEffect(() => setPaletteIndex(0), [palette.length]);

  const scroll = () => setTimeout(() => feedEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  function chooseStyle(next: ReplyStyle) {
    setStyle(next);
    try { localStorage.setItem(STYLE_KEY, next); } catch { /* storage unavailable */ }
  }

  async function send(message: string) {
    message = message.trim();
    if (!message || busy) return;
    setText('');
    setItems(prev => [...prev, { kind: 'user', text: message }]); scroll();
    // Shortcut commands are parsed by fixed rules on the server, not by the AI model.
    const command = features.commands ? parseCommand(message) : null;
    if (command) {
      setBusy(WORKING[command.name] ?? '處理中');
      const forward = await runCommand(message);
      if (forward === null) { setBusy(null); scroll(); return; }
      message = forward;
    }
    await chat(message);
  }

  /** Returns text to hand to the AI chat (only /回覆), or null when the command was handled. */
  async function runCommand(message: string): Promise<string | null> {
    try {
      const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) });
      const body = await response.json();
      if (!body.ok) { setItems(prev => [...prev, { kind: 'error', text: body.error?.message ?? '指令執行失敗' }]); return null; }
      if (body.forward) return body.forward as string;
      if (body.command === null) return message;
      if (body.result) setItems(prev => [...prev, { kind: 'tool', result: body.result }]);
      if (body.notice) setItems(prev => [...prev, { kind: 'notice', text: body.notice }]);
      if (body.help) setItems(prev => [...prev, { kind: 'help', items: body.help }]);
    } catch {
      setItems(prev => [...prev, { kind: 'error', text: '網路錯誤，指令沒有送出。' }]);
    }
    return null;
  }

  async function chat(message: string) {
    setBusy('思考中');
    const payload = notes.length ? `[系統紀錄]\n${notes.join('\n')}\n\n${message}` : message;
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: payload, history, style }) });
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
      setBusy(null); scroll();
    }
  }

  function pick(value: string, run: boolean) {
    if (run) { void send(value); return; }
    setText(value);
    input.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (palette.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex(i => (i + 1) % palette.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex(i => (i - 1 + palette.length) % palette.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
        const choice = palette[paletteIndex];
        // An exact command with nothing to add just runs.
        if (e.key === 'Enter' && choice.run && text.trim() === choice.command) { e.preventDefault(); void send(text); return; }
        e.preventDefault(); pick(choice.fill, choice.run && e.key === 'Enter'); return;
      }
      if (e.key === 'Escape') { setText(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); }
  }

  function renderReply({ item, index }: { item: Item; index: number }) {
    const addNote = (note: string) => setNotes(prev => [...prev, note]);
    if (item.kind === 'tool') {
      if (item.result.status === 'confirmation_required') return <ProposalCard key={index} result={item.result} onDone={addNote} />;
      if (item.result.status === 'ok' && item.result.tool.startsWith('assistant.')) {
        const source = items.slice(0, index).reverse().find(i => i.kind === 'user');
        const original = source?.kind === 'user' ? source.text.replace(/^[/／]\s*分診\s*/, '') : '';
        return <AssistantCard key={index} result={item.result} onNote={addNote}
          onReply={features.reply_drafts && original ? () => void send(`/回覆 ${original}`) : undefined} />;
      }
      return <ToolCard key={index} result={item.result} />;
    }
    if (item.kind === 'assistant') return <div key={index} className="msg assistant"><RichText text={item.text} /></div>;
    if (item.kind === 'notice') return <div key={index} className="msg assistant"><p>{item.text}</p></div>;
    if (item.kind === 'help') {
      return (
        <div key={index} className="msg assistant">
          <ul className="help-list">{item.items.map(h => <li key={h.command}><button type="button" className="link" onClick={() => pick(h.command.replace(/\s.*$/, ' '), false)}>{h.command}</button><span className="muted">{h.description}</span></li>)}</ul>
        </div>
      );
    }
    return <div key={index} className={`msg ${item.kind}`}>{item.text}</div>;
  }

  const composer = (
    <div className={empty ? 'composer docked-center' : 'composer'}>
      <div className="composer-inner">
        {palette.length > 0 && (
          <ul className="palette" role="listbox" aria-label="快捷指令">
            {palette.map((p, i) => (
              <li key={p.command} role="option" aria-selected={i === paletteIndex}>
                <button type="button" className={i === paletteIndex ? 'on' : ''} onMouseEnter={() => setPaletteIndex(i)} onClick={() => pick(p.fill, p.run)}>
                  <b>{p.command}</b><span>{p.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={event => { event.preventDefault(); void send(text); }}>
          {!empty && <button type="button" className="icon-button" onClick={() => { setItems([]); setHistory([]); setNotes([]); }} aria-label="開新對話" title="開新對話"><Icon name="plus" size={18} /></button>}
          <textarea ref={input} value={text} onChange={e => setText(e.target.value)} rows={1} aria-label="訊息" onKeyDown={onKeyDown}
            placeholder={!features.commands ? '交代我一件事…' : empty ? '交代我一件事，或輸入 / 使用快捷指令' : '繼續交代，或輸入 /'} />
          <button className="primary" type="submit" disabled={Boolean(busy) || !text.trim()} aria-label="送出"><Icon name="send" size={18} /></button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      <main className={empty ? 'feed home' : 'feed'}>
        {empty && (
          <section className="agent-home">
            <div className="agent-id">
              <span className="agent-mark"><BrandMark size={44} /></span>
              <div>
                <p className="agent-name">NOIRXU <em>AI</em><span className="online"><span className="dot on" />待命中</span></p>
                <h1>{greeting()}。{brief ? '' : '今天要我處理什麼？'}</h1>
              </div>
            </div>
            {brief && <p className="agent-status">{brief.lines.join(' · ')}</p>}
            {brief && brief.top.length > 0 && (
              <ul className="agent-focus">
                {brief.top.map(t => <li key={t.id} className={`prio-${t.priority}`}><span className="rail" /><b>{t.title}</b><small>{t.due_label}</small></li>)}
              </ul>
            )}
            {composer}
            <div className="chips">
              {CHIPS.filter(c => !c.feature || features[c.feature]).map(c => <button key={c.label} type="button" onClick={() => pick(c.text, c.run)}>{c.label}</button>)}
            </div>
            <div className="agent-meta">
              <div className="status-row">
                {SYSTEMS.map(([id, label]) => <a key={id} href="/connections" className={`pill ${connected[id] ? 'on' : ''}`}><span className={`dot ${connected[id] ? 'on' : ''}`} />{label}</a>)}
              </div>
              <div className="seg" role="radiogroup" aria-label="回覆風格">
                <span className="seg-label">風格</span>
                {STYLES.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={style === id} className={style === id ? 'on' : ''} onClick={() => chooseStyle(id)}>{label}</button>)}
              </div>
            </div>
            <p className="agent-foot">寫入帳本、交易紀錄或寄信前，一律先給你確認。</p>
          </section>
        )}
        {turns(items).map((turn, t) => (
          <Fragment key={t}>
            {turn.user && <div className="msg user">{turn.user.text}</div>}
            {turn.replies.length > 0 && (
              <div className="agent-turn">
                <span className="agent-avatar" aria-hidden="true"><BrandMark size={26} /></span>
                <div className="agent-body">{turn.replies.map(renderReply)}</div>
              </div>
            )}
          </Fragment>
        ))}
        {busy && (
          <div className="agent-turn">
            <span className="agent-avatar thinking" aria-hidden="true"><BrandMark size={26} /></span>
            <div className="agent-body"><p className="working" aria-live="polite">{busy}<span className="typing"><span /><span /><span /></span></p></div>
          </div>
        )}
        <div ref={feedEnd} />
      </main>
      {!empty && composer}
    </>
  );
}
