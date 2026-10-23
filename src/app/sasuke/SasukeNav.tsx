'use client';

import { useEffect, useRef, useState } from 'react';
import type { Page } from '../TopBar';
import { Icon, type IconName } from '../components/Icon';
import { callTool } from '../components/shared';
import { deleteConversation, listConversations, onConversationsChanged, renameConversation, type ConversationMeta } from './conversations';

const SECONDARY: Array<{ id: Page; href: string; label: string; icon: IconName }> = [
  { id: 'overview', href: '/overview', label: '總覽', icon: 'overview' },
  { id: 'report', href: '/report', label: '報告', icon: 'report' },
  { id: 'connections', href: '/connections', label: '連線與通知', icon: 'link' }
];

const STYLE_KEY = 'noirxu-ai-style';
const COLLAPSE_KEY = 'noirxu-ui-sidebar-collapsed';
const STYLES: Array<[string, string]> = [['professional', '標準'], ['concise', '簡潔'], ['butler', '管家']];

/** Original mark for SASUKE: a quiet lens — an outlined ring with an offset point. */
export function SasukeMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="sasuke-mark">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="19" cy="13" r="2.2" fill="var(--accent)" />
    </svg>
  );
}

function currentConversation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('c');
}

function History({ onNavigate }: { onNavigate: () => void }) {
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => { setList(listConversations()); setActive(currentConversation()); };
    refresh();
    return onConversationsChanged(refresh);
  }, []);

  const shown = query.trim() ? list.filter(c => c.title.toLowerCase().includes(query.trim().toLowerCase())) : list;

  return (
    <div className="history">
      <div className="history-search">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋對話" aria-label="搜尋對話" />
      </div>
      {shown.length === 0 && <p className="history-empty">{query ? '沒有符合的對話' : '對話會出現在這裡'}</p>}
      <ul>
        {shown.map(c => (
          <li key={c.id} className={c.id === active ? 'on' : ''}>
            {editing === c.id ? (
              <form onSubmit={e => { e.preventDefault(); renameConversation(c.id, draft); setEditing(null); }}>
                <input value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={60} aria-label="對話名稱" onBlur={() => setEditing(null)} />
              </form>
            ) : (
              <>
                <a href={`/?c=${c.id}`} onClick={onNavigate} title={c.title}>{c.title}</a>
                <span className="history-actions">
                  <button type="button" aria-label={`重新命名：${c.title}`} onClick={() => { setEditing(c.id); setDraft(c.title); }}><Icon name="edit" size={14} /></button>
                  <button type="button" aria-label={`刪除：${c.title}`} onClick={() => { if (confirm(`刪除「${c.title}」？這只會刪除這台裝置上的紀錄。`)) { deleteConversation(c.id); if (c.id === active) window.location.href = '/'; } }}><Icon name="close" size={14} /></button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="history-note">目前只存在這台裝置。伺服器同步會在下一階段開放。</p>
    </div>
  );
}

function StylePicker() {
  const [style, setStyle] = useState('professional');
  useEffect(() => { try { setStyle(localStorage.getItem(STYLE_KEY) ?? 'professional'); } catch { /* storage unavailable */ } }, []);
  return (
    <label className="style-pick">
      <span>回覆</span>
      <select value={style} onChange={e => { setStyle(e.target.value); try { localStorage.setItem(STYLE_KEY, e.target.value); } catch { /* storage unavailable */ } }}>
        {STYLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );
}

/** Small water status in the header; tap for +250 / +500 / undo. Keeps the chat clear. */
export function WaterChip() {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void callTool('health.water.status', {}).then(r => { if (r.status === 'ok') setData(r.data); });
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  if (!data) return null;
  async function act(tool: string, input: unknown) {
    setBusy(true);
    const r = await callTool(tool, input);
    setBusy(false);
    if (r.status === 'ok') setData(r.data);
  }
  const fmt = (n: number) => Number(n).toLocaleString('en-US');
  return (
    <div className="water-chip" ref={box}>
      <button type="button" className={data.behind_ml > 0 ? 'behind' : ''} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="喝水進度">
        <Icon name="drop" size={14} /><span>{fmt(data.total_ml)}<small> / {fmt(data.goal_ml)}</small></span>
      </button>
      {open && (
        <div className="water-pop" role="dialog" aria-label="喝水">
          <div className="bar"><span className="bar-accent" style={{ width: `${data.percent}%` }} /></div>
          <p className="hint">{data.remaining_ml === 0 ? '今天的目標已達成。' : data.behind_ml > 0 ? `照進度應到 ${fmt(data.expected_ml)} ml` : `進度正常，還差 ${fmt(data.remaining_ml)} ml`}</p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void act('health.water.log', { ml: 250 })}>+250</button>
            <button type="button" disabled={busy} onClick={() => void act('health.water.log', { ml: 500 })}>+500</button>
            {data.entries.length > 0 && <button type="button" className="ghost" disabled={busy} onClick={() => void act('health.water.undo', {})}>復原</button>}
          </div>
          <p className="hint">提醒 {data.prefs.enabled ? `${data.prefs.start}–${data.prefs.end}` : '已關閉'} · 輸入「/喝水」調整</p>
        </div>
      )}
    </div>
  );
}

export function SasukeNav({ current, water }: { current: Page; water: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => { try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { document.documentElement.classList.toggle('sidebar-collapsed', collapsed); }, [collapsed]);
  useEffect(() => { document.body.classList.toggle('drawer-open', drawer); }, [drawer]);

  function toggle() {
    setCollapsed(c => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* storage unavailable */ } return !c; });
  }

  const panel = (
    <>
      <div className="sk-brand">
        <a href="/" aria-label="SASUKE 首頁"><SasukeMark size={26} /><span className="sk-word"><b>SASUKE</b><small>NOIRXU AI</small></span></a>
        <button type="button" className="sk-icon sk-collapse" onClick={toggle} aria-label={collapsed ? '展開側邊欄' : '收合側邊欄'}><Icon name="arrow" size={16} /></button>
      </div>
      <a href="/?c=new" className="sk-new" onClick={() => setDrawer(false)}><Icon name="plus" size={16} /><span>新對話</span></a>
      <History onNavigate={() => setDrawer(false)} />
      <nav className="sk-secondary" aria-label="其他頁面">
        {current !== 'chat' && <a href="/"><Icon name="chat" size={17} /><span>SASUKE</span></a>}
        {SECONDARY.map(item => (
          <a key={item.id} href={item.href} aria-current={current === item.id ? 'page' : undefined}><Icon name={item.icon} size={17} /><span>{item.label}</span></a>
        ))}
      </nav>
      <div className="sk-foot">
        <StylePicker />
        <form method="post" action="/api/logout"><button type="submit" className="sk-icon" aria-label="登出" title="登出"><Icon name="logout" size={17} /></button></form>
      </div>
    </>
  );

  return (
    <>
      <aside className="sk-sidebar" aria-label="SASUKE 導覽">{panel}</aside>
      <header className="sk-top">
        <button type="button" className="sk-icon" onClick={() => setDrawer(true)} aria-label="開啟選單"><Icon name="menu" size={20} /></button>
        <a href="/" className="sk-top-title"><SasukeMark size={22} /><b>SASUKE</b></a>
      </header>
      {water && <div className="sk-water-slot"><WaterChip /></div>}
      {drawer && <div className="sk-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`sk-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer} aria-label="SASUKE 選單">
        <button type="button" className="sk-icon sk-drawer-close" onClick={() => setDrawer(false)} aria-label="關閉選單"><Icon name="close" size={18} /></button>
        {drawer && panel}
      </aside>
    </>
  );
}
