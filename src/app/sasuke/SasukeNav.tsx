'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Page } from '../TopBar';
import { Icon, type IconName } from '../components/Icon';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Inbox } from './Inbox';
import { activeId, deleteConversation, legacyImports, listConversations, onConversationsChanged, renameConversation, SOFT_LIMIT, type ConversationMeta, type SaveResult } from './conversations';

function warnIfFailed(result: SaveResult) {
  if (!result.ok) alert(result.reason === 'quota' ? '這台裝置的儲存空間已滿，變更沒有存下來。' : '瀏覽器不允許儲存，變更沒有存下來。');
}

/** Functions, not conversations: chat history lives in its own dialog on the chat page. */
const NAV: Array<{ id: Page; href: string; label: string; icon: IconName; also?: Page[] }> = [
  { id: 'chat', href: '/', label: 'SASUKE 對話', icon: 'chat' },
  { id: 'tasks', href: '/tasks', label: '任務中心', icon: 'check' },
  { id: 'research', href: '/research', label: '投資研究', icon: 'chart' },
  { id: 'overview', href: '/overview', label: '財務', icon: 'wallet', also: ['report'] },
  { id: 'mail', href: '/mail', label: '郵件', icon: 'mail' },
  { id: 'life', href: '/life', label: '提醒與生活', icon: 'bell' },
  { id: 'memory', href: '/memory', label: '個人記憶', icon: 'memory' }
];

const COLLAPSE_KEY = 'noirxu-ui-sidebar-collapsed';

/**
 * Original mark for SASUKE: a segmented sensor ring around a diamond frame and a lit core.
 * Static (no animation) so it costs nothing; ids are unique per instance.
 */
export function SasukeMark({ size = 28 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="sasuke-mark">
      <defs>
        <linearGradient id={`skg${id}`} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8ff0ff" />
          <stop offset="1" stopColor="#3b7bff" />
        </linearGradient>
        <radialGradient id={`skc${id}`} cx="16" cy="16" r="5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e9fdff" />
          <stop offset=".55" stopColor="#5fe0f2" />
          <stop offset="1" stopColor="#2f78ff" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="none" stroke={`url(#skg${id})`} strokeWidth="1.3" strokeDasharray="16.4 4" transform="rotate(-36 16 16)" strokeLinecap="round" />
      <path d="M16 2.2v2M16 27.8v2M2.2 16h2M27.8 16h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity=".45" />
      <path d="M16 8.2 23.8 16 16 23.8 8.2 16Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity=".8" />
      <circle cx="16" cy="16" r="3.6" fill={`url(#skc${id})`} />
    </svg>
  );
}

/** A fresh URL each time, so the chat starts over even when already on a new conversation. */
export function newConversationHref() {
  return `/?c=new&t=${Date.now().toString(36)}`;
}

/** Sidebar sections by last activity, Taipei calendar days. */
function groupByDay(list: ConversationMeta[]): Array<[string, ConversationMeta[]]> {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
  const today = day(new Date());
  const ago = (iso: string) => Math.round((Date.parse(today) - Date.parse(day(new Date(iso)))) / 86_400_000);
  const order = ['今天', '昨天', '過去 7 天', '過去 30 天', '更早'];
  const out = new Map<string, ConversationMeta[]>();
  for (const c of list) {
    const n = ago(c.updatedAt);
    const label = n <= 0 ? order[0] : n === 1 ? order[1] : n <= 7 ? order[2] : n <= 30 ? order[3] : order[4];
    out.set(label, [...(out.get(label) ?? []), c]);
  }
  return order.filter(l => out.has(l)).map(l => [l, out.get(l)!]);
}

function History({ onNavigate }: { onNavigate: () => void }) {
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [imports, setImports] = useState(0);

  const params = useSearchParams();
  useEffect(() => {
    const refresh = () => { setList(listConversations()); setActive(params.get('c') ?? activeId()); setImports(legacyImports().length); };
    refresh();
    return onConversationsChanged(refresh);
  }, [params]);

  const shown = query.trim() ? list.filter(c => c.title.toLowerCase().includes(query.trim().toLowerCase())) : list;
  const groups = groupByDay(shown);

  return (
    <div className="history">
      <div className="history-search">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋對話" aria-label="搜尋對話" />
      </div>
      {shown.length === 0 && <p className="history-empty">{query ? '沒有符合的對話' : '對話會出現在這裡'}</p>}
      <div className="history-list">
        {groups.map(([label, entries]) => (
          <section key={label}>
            <h3>{label}</h3>
            <ul>
              {entries.map(c => (
                <li key={c.id} className={c.id === active ? 'on' : ''}>
                  {editing === c.id ? (
                    <form onSubmit={e => { e.preventDefault(); warnIfFailed(renameConversation(c.id, draft)); setEditing(null); }}>
                      <input value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={60} aria-label="對話名稱" onBlur={() => setEditing(null)} />
                    </form>
                  ) : (
                    <>
                      <Link href={`/?c=${c.id}`} onClick={onNavigate} title={c.title} prefetch={false}>{c.title}</Link>
                      <span className="history-actions">
                        <button type="button" aria-label={`重新命名：${c.title}`} onClick={() => { setEditing(c.id); setDraft(c.title); }}><Icon name="edit" size={14} /></button>
                        <button type="button" aria-label={`刪除：${c.title}`} onClick={() => { if (confirm(`刪除「${c.title}」？這只會刪除這台裝置上的紀錄。`)) { const r = deleteConversation(c.id); warnIfFailed(r); if (r.ok && c.id === active) window.location.href = '/'; } }}><Icon name="close" size={14} /></button>
                      </span>
                    </>
                  )}
                </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      {list.length > SOFT_LIMIT && <p className="history-note warn">這台裝置已有 {list.length} 個對話。不會自動刪除；不需要的可以手動刪除，以免儲存空間不足。</p>}
      {imports > 0 && <p className="history-note">已從原版介面匯入 {imports} 段對話（原版資料仍保留）。</p>}
    </div>
  );
}

/** Conversation history in a dialog: search, open, rename, delete. Hidden until asked for. */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Focus search on desktop only; on phones it would open the keyboard over the list.
    if (window.matchMedia('(pointer: fine)').matches) panel.current?.querySelector('input')?.focus();
    else panel.current?.querySelector<HTMLElement>('button')?.focus();
    document.body.classList.add('drawer-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('drawer-open'); };
  }, [onClose]);
  return (
    <div className="sk-modal" role="presentation" onClick={onClose}>
      <div className="sk-modal-panel" role="dialog" aria-modal="true" aria-label="對話紀錄" ref={panel} onClick={e => e.stopPropagation()}>
        <header><b>對話紀錄</b><button type="button" className="sk-icon" onClick={onClose} aria-label="關閉"><Icon name="close" size={18} /></button></header>
        <History onNavigate={onClose} />
        <p className="history-note">對話存在這台裝置，不會自動刪除。</p>
      </div>
    </div>
  );
}

export function SasukeNav({ current }: { current: Page; water?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [history, setHistory] = useState(false);
  const router = useRouter();
  const closeHistory = useCallback(() => setHistory(false), []);

  useEffect(() => { try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { document.documentElement.classList.toggle('sidebar-collapsed', collapsed); }, [collapsed]);
  useEffect(() => { document.body.classList.toggle('drawer-open', drawer); }, [drawer]);

  function toggle() {
    setCollapsed(c => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* storage unavailable */ } return !c; });
  }
  const close = () => setDrawer(false);
  const isCurrent = (item: (typeof NAV)[number]) => current === item.id || Boolean(item.also?.includes(current));

  const panel = (
    <>
      <div className="sk-brand">
        <Link href="/" aria-label="SASUKE 首頁" onClick={close}><SasukeMark size={26} /><span className="sk-word"><b>SASUKE</b><small>NOIRXU · PERSONAL AI</small></span></Link>
        <button type="button" className="sk-icon sk-collapse" onClick={toggle} aria-label={collapsed ? '展開側邊欄' : '收合側邊欄'}><Icon name="arrow" size={16} /></button>
      </div>
      <nav className="sk-nav" aria-label="功能">
        {NAV.map(item => (
          <Link key={item.id} href={item.href} aria-current={isCurrent(item) ? 'page' : undefined} onClick={close} title={item.label}>
            <Icon name={item.icon} size={18} /><span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sk-bottom">
        <Link href="/connections" aria-current={current === 'connections' ? 'page' : undefined} onClick={close} title="設定與連線"><Icon name="settings" size={18} /><span>設定與連線</span></Link>
        <div className="sk-foot">
          <span className="sk-foot-note">NOIRXU AI</span>
          <form method="post" action="/api/logout"><button type="submit" className="sk-icon" aria-label="登出" title="登出"><Icon name="logout" size={17} /></button></form>
        </div>
      </div>
    </>
  );

  return (
    <>
      <aside className="sk-sidebar" aria-label="SASUKE 導覽">{panel}</aside>
      <header className="sk-top">
        <button type="button" className="sk-icon" onClick={() => setDrawer(true)} aria-label="開啟選單"><Icon name="menu" size={20} /></button>
        <Link href="/" className="sk-top-title"><SasukeMark size={22} /><b>SASUKE</b></Link>
      </header>
      <div className="sk-water-slot">
        {current === 'chat' && (
          <>
            <button type="button" className="sk-head-btn" onClick={() => setHistory(true)} aria-label="對話紀錄" title="對話紀錄"><Icon name="history" size={17} /></button>
            <button type="button" className="sk-head-btn" onClick={() => router.push(newConversationHref())} aria-label="新對話" title="新對話"><Icon name="plus" size={17} /></button>
          </>
        )}
        <Inbox />
      </div>
      {history && <HistoryDialog onClose={closeHistory} />}
      {drawer && <div className="sk-scrim" onClick={close} />}
      <aside className={`sk-drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer} aria-label="SASUKE 選單">
        <button type="button" className="sk-icon sk-drawer-close" onClick={close} aria-label="關閉選單"><Icon name="close" size={18} /></button>
        {drawer && panel}
      </aside>
    </>
  );
}
