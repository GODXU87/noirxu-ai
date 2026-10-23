'use client';

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';

interface Memory { id: string; category: string; content: string; source: string; active: boolean; created_at: string; updated_at: string }

const CATEGORIES: Array<[string, string]> = [
  ['preference', '個人偏好'], ['sasuke', 'SASUKE 互動設定'], ['brand', 'NOIRXU 品牌規則'], ['project', '專案背景'], ['decision', '重要決策'], ['routine', '日常規則']
];
const LABEL = Object.fromEntries(CATEGORIES);
const SOURCE: Record<string, string> = { user_command: '/記憶 指令', chat: '對話中要求', manual: '手動新增' };
const date = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(path: string, method = 'GET', body?: unknown) {
  try {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    return data.ok ? { ok: true as const, data } : { ok: false as const, message: data.error?.message ?? '操作失敗' };
  } catch {
    return { ok: false as const, message: '網路錯誤' };
  }
}

export function Memories() {
  const [list, setList] = useState<Memory[]>([]);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState({ content: '', category: '' });
  const [editing, setEditing] = useState<{ id: string; content: string; category: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const r = await api(`/api/memories?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(showAll ? { all: '1' } : {}) })}`);
    if (r.ok) setList(r.data.memories); else setMessage({ ok: false, text: r.message });
  }
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [query, showAll]);

  async function act(promise: Promise<{ ok: boolean; message?: string }>, done: string) {
    const r = await promise;
    setMessage(r.ok ? { ok: true, text: done } : { ok: false, text: r.message ?? '操作失敗' });
    if (r.ok) void load();
    return r.ok;
  }

  return (
    <main className="stack memories">
      <section className="card">
        <p className="section-label">新增記憶</p>
        <form className="memory-add" onSubmit={async e => { e.preventDefault(); if (await act(api('/api/memories', 'POST', { content: draft.content, ...(draft.category ? { category: draft.category } : {}) }), '已記住。')) setDraft({ content: '', category: '' }); }}>
          <input value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} maxLength={500} placeholder="例如：回覆一律用繁體中文" required aria-label="記憶內容" />
          <select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} aria-label="分類"><option value="">自動分類</option>{CATEGORIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
          <button className="primary" disabled={!draft.content.trim()}>記住</button>
        </form>
        <p className="hint">金額、持股、行情、密碼與證號不會存成記憶；這些每次都會從原系統重新查詢。</p>
      </section>

      <section className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋記憶" aria-label="搜尋記憶" style={{ flex: 1 }} />
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} style={{ width: 'auto' }} />顯示已停用</label>
        </div>
        {message && <p className="hint" style={{ color: message.ok ? 'var(--accent)' : 'var(--danger)' }}>{message.text}</p>}
        {list.length === 0 && <p className="hint">{query ? '沒有符合的記憶。' : '還沒有記憶。可以在對話中輸入「/記憶 內容」。'}</p>}
        <ul className="memory-list">
          {list.map(m => (
            <li key={m.id} className={m.active ? '' : 'inactive'}>
              {editing?.id === m.id ? (
                <form className="memory-add" onSubmit={async e => { e.preventDefault(); if (await act(api(`/api/memories/${m.id}`, 'PATCH', { content: editing.content, category: editing.category }), '已更新。')) setEditing(null); }}>
                  <input value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} maxLength={500} autoFocus aria-label="記憶內容" />
                  <select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} aria-label="分類">{CATEGORIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
                  <button className="primary">儲存</button>
                  <button type="button" className="ghost" onClick={() => setEditing(null)}>取消</button>
                </form>
              ) : (
                <>
                  <div className="memory-main">
                    <p>{m.content}</p>
                    <small>{LABEL[m.category] ?? m.category} · {SOURCE[m.source] ?? m.source} · 建立 {date(m.created_at)}{m.updated_at !== m.created_at ? ` · 更新 ${date(m.updated_at)}` : ''}{m.active ? '' : ' · 已停用'}</small>
                  </div>
                  <span className="memory-actions">
                    <button type="button" className="ghost" onClick={() => setEditing({ id: m.id, content: m.content, category: m.category })} aria-label="編輯"><Icon name="edit" size={15} /></button>
                    <button type="button" className="ghost" onClick={() => void act(api(`/api/memories/${m.id}`, 'PATCH', { active: !m.active }), m.active ? '已停用。' : '已重新啟用。')}>{m.active ? '停用' : '啟用'}</button>
                    <button type="button" className="ghost" onClick={() => { if (confirm('刪除這筆記憶？30 天後永久清除。')) void act(api(`/api/memories/${m.id}`, 'DELETE'), '已刪除。'); }} aria-label="刪除"><Icon name="close" size={15} /></button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
