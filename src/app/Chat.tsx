'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { parseCommand, type CommandName } from '@/assistant/commands';
import type { FeatureFlags } from '@/lib/features';
import { money } from '@/lib/tool-labels';
import { BrandMark, Icon, type IconName } from './components/Icon';
import { AssistantCard, WaterMeter } from './components/assistant';
import { importLegacySession, loadConversation, newConversationId, resumeActive, saveConversation, touchActive } from './sasuke/conversations';
import { useRouter } from 'next/navigation';
import { announceAgentState, newConversationHref, SasukeMark, type AgentState } from './sasuke/SasukeNav';
import { callTool, ProposalCard, RichText, ToolCard, type InvokeResult } from './components/shared';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; via?: string }
  | { kind: 'error'; text: string; retry?: string }
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
  { command: '/喝水', fill: '/喝水 ', label: '記錄喝水、看今天的進度', run: false, feature: 'water' },
  { command: '/說明', fill: '/說明', label: '所有快捷指令', run: true, feature: 'commands' }
];

const CHIPS: Array<{ label: string; text: string; run: boolean; icon: IconName; feature?: keyof FeatureFlags }> = [
  { label: '早報', text: '/早報', run: true, icon: 'calendar', feature: 'briefings' },
  { label: '最近有什麼事', text: '最近有什麼事？依重要程度排給我。', run: true, icon: 'bell' },
  { label: '記一筆帳', text: '/記帳 ', run: false, icon: 'wallet', feature: 'commands' },
  { label: '整理一段訊息', text: '/分診 ', run: false, icon: 'chat', feature: 'triage' },
  { label: '這個月花了多少', text: '這個月花了多少錢？哪一類最多？', run: true, icon: 'chart' },
  { label: '晚報', text: '/晚報', run: true, icon: 'report', feature: 'briefings' }
];

/** The few tools on the home screen; everything else is one message away. */
const QUICK: Array<{ label: string; text: string; run: boolean; icon: IconName; feature?: keyof FeatureFlags }> = [
  { label: '今日早報', text: '/早報', run: true, icon: 'calendar', feature: 'briefings' },
  { label: '記一筆帳', text: '/記帳 ', run: false, icon: 'wallet', feature: 'commands' },
  { label: '記錄喝水', text: '/喝水 ', run: false, icon: 'drop', feature: 'water' }
];

const WORKING: Partial<Record<CommandName, string>> = {
  morning: '正在整理早報', evening: '正在整理晚報', water: '更新喝水紀錄', ledger: '正在整理記帳草稿', triage: '正在分析文字', help: '讀取指令'
};

const SYSTEMS = [['ledger', 'Ledger'], ['journal', 'Journal'], ['radar', 'RADAR'], ['gmail', 'Gmail']] as const;

const TOOL_LABELS: Record<string, string> = { ledger: 'Ledger', journal: 'Journal', radar: 'RADAR', gmail: 'Gmail', agenda: '提醒', health: '飲水紀錄', assistant: '助理工具', memory: '記憶', research: '研究' };
function toolLabel(tool: string) { return TOOL_LABELS[tool.split('.')[0]] ?? tool; }

/** How the server handled a reply; details (tokens, cost) live in Settings → AI 成本保護. */
function routeLabel(route?: { level: string; source: string }) {
  if (!route) return undefined;
  if (route.source === 'ai') return 'AI 分析';
  return route.source === 'memory' ? '記憶查詢' : route.level === 'L0' ? '本地處理' : '工具查詢';
}

interface Saved { items: Item[]; history: unknown[]; notes: string[] }

function load(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Saved : null;
  } catch {
    return null;
  }
}

/** The sidebar picker may have changed the style since this page loaded. */
function currentStyle(fallback: ReplyStyle): ReplyStyle {
  try { const s = localStorage.getItem(STYLE_KEY) as ReplyStyle | null; return s && STYLES.some(([id]) => id === s) ? s : fallback; } catch { return fallback; }
}

/** The question under the greeting, by time of day (Taipei). */
function askLine() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 5 ? '夜深了，還有什麼需要我處理的？' : hour < 11 ? '今天早上有什麼需要我處理的？' : hour < 14 ? '中午有什麼需要我處理的？' : hour < 18 ? '今天下午有什麼需要我處理的？' : '今晚有什麼需要我處理的？';
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 5 ? '夜深了' : hour < 11 ? '早安' : hour < 14 ? '午安' : hour < 18 ? '午後好' : '晚上好';
}

interface Brief { failed?: boolean; lines: string[]; today: number; overdue: number; expense: string | null; top: Array<{ id: string; title: string; due_label: string; priority: string }> }

/** One-line status for the home screen, from the same morning report as /早報. */
function useBrief(enabled: boolean) {
  const [brief, setBrief] = useState<Brief | null>(null);
  useEffect(() => {
    if (!enabled) return;
    void callTool('assistant.briefing.morning', {}).then(result => {
      if (result.status !== 'ok') { setBrief({ failed: true, lines: ['今日資料暫時無法讀取'], today: 0, overdue: 0, expense: null, top: [] }); return; }
      const d = result.data as any;
      const lines: string[] = [];
      lines.push(d.today_items.length ? `今天 ${d.today_items.length} 件事` : '今天沒有排定的事');
      if (d.overdue.length) lines.push(`${d.overdue.length} 件已過期`);
      if (d.ledger) lines.push(`本月支出 ${d.ledger.currency} ${money(d.ledger.expense)}`);
      if (d.ledger?.budget_warnings?.length) lines.push(`${d.ledger.budget_warnings.length} 項預算接近上限`);
      if (d.gmail?.status === 'ok' && d.gmail.unread.length) lines.push(`${d.gmail.unread.length} 封未讀信`);
      setBrief({ lines, today: d.today_items.length, overdue: d.overdue.length, expense: d.ledger ? `${d.ledger.currency} ${money(d.ledger.expense)}` : null, top: d.top3 });
    });
  }, [enabled]);
  return brief;
}

/** Unread in-app notifications (reminders that fired), newest first. */
function useInbox(enabled: boolean) {
  const [items, setItems] = useState<Array<{ key: string; title: string }>>([]);
  useEffect(() => {
    if (!enabled) return;
    void fetch('/api/inbox').then(r => r.json()).then(body => { if (body?.ok) setItems(body.items.filter((i: { read: boolean }) => !i.read)); }).catch(() => undefined);
  }, [enabled]);
  return items;
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

export function Chat({ connected, features, variant = 'classic', ai = null }: { connected: Record<string, boolean>; features: FeatureFlags; variant?: 'classic' | 'sasuke'; ai?: string | null }) {
  const sasuke = variant === 'sasuke';
  const router = useRouter();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [style, setStyle] = useState<ReplyStyle>('professional');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const armed = useRef(0);
  const composedAt = useRef(0);
  const [enterHint, setEnterHint] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuBox = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string[]>([]);
  const feedEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const empty = items.length === 0;
  const brief = useBrief(empty && features.briefings);
  const inbox = useInbox(empty && sasuke);
  // Shown only when something real needs attention: overdue items or unread notifications.
  const notices = [
    ...(brief && !brief.failed && brief.overdue > 0 ? [{ key: 'overdue', tone: 'prio-urgent', text: `${brief.overdue} 件事已過期`, ask: '有哪些事已經過期了？' }] : []),
    ...inbox.slice(0, 2).map(i => ({ key: i.key, tone: 'prio-high', text: i.title, ask: `關於這則提醒：「${i.title}」，現在狀況如何？` }))
  ];
  const [water, setWater] = useState<any>(null);
  useEffect(() => {
    if (!empty || !features.water || sasuke) return;
    void callTool('health.water.status', {}).then(result => { if (result.status === 'ok') setWater(result.data); });
  }, [empty, features.water, sasuke]);

  useEffect(() => {
    let saved: Saved | null;
    if (sasuke) {
      // ?c=<id> opens a saved conversation (from the sidebar). Otherwise continue this tab's
      // conversation if it is recent, else start a new one; older ones stay in the sidebar.
      const outcome = importLegacySession();
      if (outcome.status === 'failed') setStorageError(`原版對話匯入失敗（${outcome.reason}），下次開啟會自動再試。原版資料沒有被刪除。`);
      const requested = new URLSearchParams(window.location.search).get('c');
      const id = requested && requested !== 'new' ? requested : (requested !== 'new' && resumeActive()) || newConversationId();
      if (requested === 'new') window.history.replaceState(window.history.state, '', '/');
      setConversationId(id);
      saved = loadConversation(id) as Saved | null;
    } else {
      saved = load();
    }
    if (saved) { setItems(saved.items); setHistory(saved.history); setNotes(saved.notes); }
    try { const s = localStorage.getItem(STYLE_KEY) as ReplyStyle | null; if (s && STYLES.some(([id]) => id === s)) setStyle(s); } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => {
    if (sasuke) {
      if (!conversationId) return;
      const first = items.find(i => i.kind === 'user');
      const saved = saveConversation(conversationId, { items, history, notes }, first?.kind === 'user' ? first.text : undefined);
      if (!saved.ok) setStorageError(saved.reason === 'quota'
        ? '這台裝置的儲存空間已滿，這段對話的新訊息沒有存下來。請在側邊欄刪除不需要的對話後再試。'
        : '瀏覽器目前不允許儲存（可能是私密瀏覽），這段對話關閉後不會保留。');
      else setStorageError(prev => (prev?.startsWith('原版對話') ? prev : null));
      if (items.length) touchActive(conversationId);
      return;
    }
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ items, history, notes })); } catch { /* storage unavailable */ }
  }, [items, history, notes, sasuke, conversationId]);

  // Keep the header water chip in step with water logged from the chat.
  useEffect(() => {
    const last = [...items].reverse().find(i => i.kind === 'tool' && i.result.status === 'ok' && i.result.tool.startsWith('health.water.'));
    if (last?.kind === 'tool' && last.result.status === 'ok') window.dispatchEvent(new CustomEvent('noirxu-water', { detail: last.result.data }));
  }, [items]);

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
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sasuke ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify({ text: payload, history, style: currentStyle(style) }) };
    const shown = new Set<number>();
    try {
      const response = await fetch('/api/chat', request);
      let body: any;
      if ((response.headers.get('content-type') ?? '').includes('application/x-ndjson') && response.body) {
        // Live progress: each tool appears as soon as the executor finishes it.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let index = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === 'tool_start') setBusy(`正在使用 ${toolLabel(event.tool)}`);
            else if (event.type === 'tool_done') { shown.add(index++); if (event.result?.status === 'confirmation_required') setPending(p => [...p, event.result.proposalId]); setItems(prev => [...prev, { kind: 'tool', result: event.result }]); scroll(); setBusy('整理結果'); if (String(event.tool).startsWith('agenda.')) window.dispatchEvent(new Event('noirxu-reminders-changed')); }
            else if (event.type === 'done') body = event;
          }
        }
        if (!body) throw new Error('stream ended early');
      } else {
        body = await response.json();
      }
      if (!body.ok) { setItems(prev => [...prev, { kind: 'error', text: body.error?.message ?? '發生錯誤', retry: body.error?.code === 'MODEL_UNAVAILABLE' ? message : undefined }]); return; }
      setNotes([]);
      setHistory(body.messages);
      if (body.events?.some((e: { tool: string }) => e.tool.startsWith('agenda.'))) window.dispatchEvent(new Event('noirxu-reminders-changed'));
      if (body.contextReset) setItems(prev => [...prev, { kind: 'notice', text: `AI 已改用 ${body.provider === 'openai' ? 'OpenAI' : 'Claude'}，之前的對話脈絡沒有帶過去；畫面上的紀錄都還在。` }]);
      setItems(prev => [
        ...prev,
        ...body.events.filter((_: unknown, i: number) => !shown.has(i)).map((e: { result: InvokeResult }) => { if (e.result.status === 'confirmation_required') setPending(p => [...p, (e.result as { proposalId: string }).proposalId]); return { kind: 'tool' as const, result: e.result }; }),
        ...(body.reply ? [{ kind: 'assistant' as const, text: body.reply, via: routeLabel(body.route) }] : [])
      ]);
    } catch {
      setItems(prev => [...prev, shown.size
        ? { kind: 'error', text: '連線中斷：上方已顯示的工具結果是真的已執行的部分，AI 的回覆沒有收到。' }
        : { kind: 'error', text: '網路錯誤，訊息沒有送出。', retry: message }]);
    } finally {
      setBusy(null); scroll();
    }
  }

  function retry(index: number, message: string) {
    setItems(prev => prev.filter((_, i) => i !== index));
    void chat(message);
  }

  // SASUKE's real state for its mark: working, waiting for a confirmation, or a failure.
  const lastItem = items[items.length - 1];
  const agentState: AgentState = busy ? 'thinking' : pending.length ? 'confirm' : lastItem?.kind === 'error' ? 'error' : 'idle';
  useEffect(() => { if (sasuke) announceAgentState(agentState); }, [agentState, sasuke]);
  useEffect(() => () => { if (sasuke) announceAgentState('idle'); }, [sasuke]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (menuBox.current && !menuBox.current.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  // "/" or Cmd/Ctrl+K anywhere jumps to the input.
  useEffect(() => {
    if (!sasuke) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sasuke]);

  // Function pages open a conversation with a ready question: /?c=new&ask=…
  const asked = useRef(false);
  useEffect(() => {
    if (!sasuke || !conversationId || asked.current) return;
    const ask = new URLSearchParams(window.location.search).get('ask');
    if (!ask) return;
    asked.current = true;
    window.history.replaceState(window.history.state, '', '/');
    void send(ask.slice(0, 2000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sasuke, conversationId]);

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
        // A fully typed command runs as is.
        if (e.key === 'Enter' && text.trim() === choice.command) { e.preventDefault(); void send(text); return; }
        e.preventDefault(); pick(choice.fill, choice.run && e.key === 'Enter'); return;
      }
      if (e.key === 'Escape') { setText(''); return; }
    }
    if (e.key !== 'Enter' || e.shiftKey) { armed.current = 0; return; }
    // Enter while an input method is composing (also Safari's keyCode 229 case) only confirms the text.
    if (e.nativeEvent.isComposing || e.keyCode === 229 || Date.now() - composedAt.current < 80) return;
    e.preventDefault();
    // Phones send with one Enter. On a computer the first Enter can be the end of switching
    // input or typing numbers, so it takes a second Enter (or Cmd/Ctrl+Enter) to send.
    const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    if (coarse || e.metaKey || e.ctrlKey || Date.now() - armed.current < 1500) { armed.current = 0; setEnterHint(false); void send(text); return; }
    if (!text.trim()) return;
    armed.current = Date.now();
    setEnterHint(true);
    window.setTimeout(() => { if (Date.now() - armed.current >= 1500) setEnterHint(false); }, 1600);
  }

  function renderReply({ item, index }: { item: Item; index: number }) {
    const addNote = (note: string) => setNotes(prev => [...prev, note]);
    if (item.kind === 'tool') {
      if (item.result.status === 'confirmation_required') {
        const id = item.result.proposalId;
        return <ProposalCard key={index} result={item.result} onDone={note => { addNote(note); setPending(p => p.filter(x => x !== id)); }} />;
      }
      if (item.result.status === 'ok' && (item.result.tool.startsWith('assistant.') || item.result.tool.startsWith('health.'))) {
        const source = items.slice(0, index).reverse().find(i => i.kind === 'user');
        const original = source?.kind === 'user' ? source.text.replace(/^[/／]\s*分診\s*/, '') : '';
        return <AssistantCard key={index} result={item.result} onNote={addNote}
          onReply={features.reply_drafts && original ? () => void send(`/回覆 ${original}`) : undefined} />;
      }
      return <ToolCard key={index} result={item.result} />;
    }
    if (item.kind === 'assistant') return <div key={index} className="msg assistant"><RichText text={item.text} />{sasuke && item.via && <span className="msg-via">{item.via}</span>}</div>;
    if (item.kind === 'notice') return <div key={index} className="msg assistant"><p>{item.text}</p></div>;
    if (item.kind === 'help') {
      return (
        <div key={index} className="msg assistant">
          <ul className="help-list">{item.items.map(h => <li key={h.command}><button type="button" className="link" onClick={() => pick(h.command.replace(/\s.*$/, ' '), false)}>{h.command}</button><span className="muted">{h.description}</span></li>)}</ul>
        </div>
      );
    }
    if (item.kind === 'error' && item.retry) {
      const message = item.retry;
      return <div key={index} className="msg error">{item.text}<button type="button" className="retry" disabled={Boolean(busy)} onClick={() => retry(index, message)}>重試</button></div>;
    }
    return <div key={index} className={`msg ${item.kind}`}>{item.text}</div>;
  }

  const newConversation = () => { if (sasuke) { router.push(newConversationHref()); return; } setItems([]); setHistory([]); setNotes([]); };
  const placeholder = !features.commands ? '交代我一件事…' : empty ? '交代我一件事，或輸入 / 使用快捷指令' : '繼續交代，或輸入 /';

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
        {sasuke ? (
          <form className="sk-composer" onSubmit={event => { event.preventDefault(); void send(text); }}>
            <textarea ref={input} value={text} onChange={e => setText(e.target.value)} rows={1} aria-label="訊息" onKeyDown={onKeyDown} onCompositionEnd={() => { composedAt.current = Date.now(); }} onInput={() => { armed.current = 0; setEnterHint(false); }} placeholder={placeholder} />
            <div className="sk-tools">
              <div className="sk-agent-menu" ref={menuBox}>
                <button type="button" className="sk-agent" onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-haspopup="dialog" data-tip="模型與回覆風格">
                  <span className={ai ? 'sk-pulse' : 'sk-pulse off'} />SASUKE<Icon name="arrow" size={12} className="sk-agent-caret" />
                </button>
                {menu && (
                  <div className="sk-menu" role="dialog" aria-label="SASUKE 設定">
                    <div className="sk-menu-row"><span>目前模型</span><b>{ai ?? '未設定（只能使用本地功能）'}</b></div>
                    <label className="sk-menu-row"><span>回覆風格</span>
                      <select value={style} onChange={e => chooseStyle(e.target.value as ReplyStyle)}>
                        {STYLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </label>
                    {features.commands && <button type="button" className="sk-menu-item" onClick={() => { setMenu(false); setText('/'); input.current?.focus(); }}><Icon name="slash" size={14} />快捷指令</button>}
                    <a className="sk-menu-item" href="/cost"><Icon name="settings" size={14} />AI 成本保護</a>
                  </div>
                )}
              </div>
              {enterHint && <span className="sk-enter-hint" role="status">再按一次 Enter 送出</span>}
              <button className="sk-send" type="submit" disabled={Boolean(busy) || !text.trim()} aria-label="送出"><Icon name="up" size={18} /></button>
            </div>
          </form>
        ) : (
          <form onSubmit={event => { event.preventDefault(); void send(text); }}>
            {!empty && <button type="button" className="icon-button" onClick={newConversation} aria-label="開新對話" title="開新對話"><Icon name="plus" size={18} /></button>}
            <textarea ref={input} value={text} onChange={e => setText(e.target.value)} rows={1} aria-label="訊息" onKeyDown={onKeyDown} onCompositionEnd={() => { composedAt.current = Date.now(); }} onInput={() => { armed.current = 0; setEnterHint(false); }} placeholder={placeholder} />
            <button className="primary" type="submit" disabled={Boolean(busy) || !text.trim()} aria-label="送出"><Icon name="send" size={18} /></button>
          </form>
        )}
      </div>
    </div>
  );

  return (
    <>
      <main className={empty ? 'feed home' : 'feed'}>
        {storageError && <p className="banner storage-warning" role="alert">{storageError}</p>}
        {empty && sasuke && (
          <section className="sk-home">
            <span className="sk-home-mark"><SasukeMark size={44} state={agentState} /></span>
            <p className="sk-home-name">SASUKE</p>
            <h1 className="sk-hello">{greeting()}，Sir。</h1>
            <p className="sk-ask">{askLine()}</p>
            {notices.length > 0 && (
              <ul className="sk-notices" aria-label="重要通知">
                {notices.map(n => <li key={n.key}><span className={`sk-dot ${n.tone}`} /><button type="button" className="sk-notice" onClick={() => pick(n.ask, true)}>{n.text}</button></li>)}
              </ul>
            )}
            {composer}
            <nav className="sk-quick" aria-label="常用">
              {QUICK.filter(c => !c.feature || features[c.feature]).map(c => <button key={c.label} type="button" onClick={() => pick(c.text, c.run)}><Icon name={c.icon} size={14} />{c.label}</button>)}
            </nav>
          </section>
        )}
        {empty && !sasuke && (
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
            {water && <WaterMeter data={water} onChange={setWater} compact />}
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
                <span className="agent-avatar" aria-hidden="true">{sasuke ? <SasukeMark size={24} /> : <BrandMark size={26} />}</span>
                <div className="agent-body">{turn.replies.map(renderReply)}</div>
              </div>
            )}
          </Fragment>
        ))}
        {busy && (
          <div className="agent-turn">
            <span className="agent-avatar thinking" aria-hidden="true">{sasuke ? <SasukeMark size={22} state="thinking" /> : <BrandMark size={26} />}</span>
            <div className="agent-body">{sasuke
              ? <p className="sk-working" aria-live="polite"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>{busy === '思考中' ? 'SASUKE 正在處理' : busy}</span></p>
              : <p className="working" aria-live="polite">{busy}<span className="typing"><span /><span /><span /></span></p>}</div>
          </div>
        )}
        <div ref={feedEnd} />
      </main>
      {!empty && composer}
    </>
  );
}
