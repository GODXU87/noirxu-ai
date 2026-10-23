'use client';

import { useEffect, useRef, useState } from 'react';
import type { Page } from '../TopBar';
import { Icon, type IconName } from '../components/Icon';
import { callTool } from '../components/shared';
import { deleteConversation, legacyImports, listConversations, onConversationsChanged, renameConversation, SOFT_LIMIT, type ConversationMeta, type SaveResult } from './conversations';

function warnIfFailed(result: SaveResult) {
  if (!result.ok) alert(result.reason === 'quota' ? '這台裝置的儲存空間已滿，變更沒有存下來。' : '瀏覽器不允許儲存，變更沒有存下來。');
}

const SECONDARY: Array<{ id: Page; href: string; label: string; icon: IconName }> = [
  { id: 'overview', href: '/overview', label: '總覽', icon: 'overview' },
  { id: 'report', href: '/report', label: '報告', icon: 'report' },
  { id: 'connections', href: '/connections', label: '連線與通知', icon: 'link' }
];

const COLLAPSE_KEY = 'noirxu-ui-sidebar-collapsed';

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

  useEffect(() => {
    const refresh = () => { setList(listConversations()); setActive(currentConversation()); setImports(legacyImports().length); };
    refresh();
    return onConversationsChanged(refresh);
  }, []);

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
                      <a href={`/?c=${c.id}`} onClick={onNavigate} title={c.title}>{c.title}</a>
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

/** Small water status in the header; tap for +250 / +500 / undo. Keeps the chat clear. */
export function WaterChip() {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void callTool('health.water.status', {}).then(r => { if (r.status === 'ok') setData(r.data); });
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const update = (e: Event) => { const d = (e as CustomEvent).detail; if (d && typeof d.total_ml === 'number') setData(d); };
    document.addEventListener('click', close);
    window.addEventListener('noirxu-water', update);
    return () => { document.removeEventListener('click', close); window.removeEventListener('noirxu-water', update); };
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
        <span className="sk-foot-note" title="伺服器同步會在下一階段開放">對話存在這台裝置</span>
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
