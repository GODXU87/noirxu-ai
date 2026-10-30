'use client';

import { useEffect, useRef, useState } from 'react';

interface Memory {
  id: string; content: string; category: string; source?: string;
  created_at?: string; updated_at?: string; revision: number;
}
interface Editor { original: Memory; content: string; category: string }

function MemoryDate({ value }: { value?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>日期未記錄</>;
  return <time dateTime={value}>{new Date(value).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })}</time>;
}
function sourceLabel(source?: string) {
  return source === 'user' ? '使用者提供' : source === 'confirmed' ? '使用者確認' : '來源未記錄';
}

export function LongTermMemory() {
  const [items, setItems] = useState<Memory[] | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const read = useRef<AbortController | null>(null);

  async function load() {
    if (locked.current) return;
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    setLoading(true); setError('');
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const body = await fetch('/api/memory', { signal: controller.signal, cache: 'no-store' }).then(r => r.json());
      if (!mounted.current || read.current !== controller) return;
      if (controller.signal.aborted) throw new Error('讀取逾時，請重新讀取。');
      if (!body.ok) throw new Error(body.error?.message ?? '讀不到記憶');
      setItems(body.memories); setLabels(body.categories);
    } catch (error) {
      if (mounted.current && read.current === controller) setError(error instanceof Error && !controller.signal.aborted ? error.message : '讀取逾時，請重新讀取。');
    } finally {
      clearTimeout(timeout);
      if (mounted.current && read.current === controller) { read.current = null; setLoading(false); }
    }
  }
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; read.current?.abort(); read.current = null; };
  }, []);

  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError('');
    // A read started before this write must never replace its acknowledged result.
    read.current?.abort(); read.current = null; setLoading(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await fetch('/api/memory', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }).then(r => r.json());
      if (!mounted.current) return false;
      if (controller.signal.aborted) throw new Error('uncertain');
      if (!result?.ok) { setError(result?.error?.message ?? '操作失敗，請重新讀取核對。'); return false; }
      setItems(current => method === 'DELETE'
        ? (current ?? []).filter(m => m.id !== body.id)
        : [result.memory, ...(current ?? []).filter(m => m.id !== result.memory.id)]);
      return true;
    } catch {
      if (mounted.current) setError('無法確認操作結果，請先重新讀取核對；草稿仍保留。');
      return false;
    } finally {
      clearTimeout(timeout);
      locked.current = false; if (mounted.current) setBusy(false);
    }
  }

  const latest = editing ? items?.find(m => m.id === editing.original.id) : undefined;
  const unavailable = Boolean(editing && items !== null && !latest);
  const groups = Object.entries(labels).map(([key, label]) => ({ key, label, list: (items ?? []).filter(m => m.category === key) })).filter(g => g.list.length);
  return (
    <section className="card memory-card" aria-label="長期記憶">
      <p className="section-label">長期記憶{items ? <small>{items.length} 筆</small> : null}<button type="button" className="ghost" disabled={busy || loading} onClick={() => void load()}>重新讀取</button></p>
      <form className="row memory-add" onSubmit={e => { e.preventDefault(); if (items !== null && text.trim().length >= 2) void send('POST', { content: text }).then(ok => { if (ok) setText(''); }); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="例如：回答先列重點" maxLength={300} aria-label="要記住的事" disabled={busy} />
        <button className="primary" disabled={items === null || busy || loading || text.trim().length < 2}>記住</button>
      </form>
      <p className="hint">來源表示使用者提供或確認，不代表已獨立查證。日期以台灣時間顯示。更正會取代目前記憶；刪除記憶不會清除這台裝置的對話紀錄。</p>
      {editing && <form className="memory-editor" aria-label="更正記憶" onSubmit={e => {
        e.preventDefault();
        if (unavailable || editing.content.trim().length < 2) return;
        void send('PATCH', { id: editing.original.id, revision: editing.original.revision, content: editing.content, category: editing.category }).then(ok => { if (ok) setEditing(null); });
      }}>
        <label>內容<input value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} maxLength={300} aria-label="修改記憶" disabled={busy} autoFocus /></label>
        <label>分類<select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} aria-label="記憶分類" disabled={busy}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {unavailable ? <p className="hint tone-error">這筆記憶已不存在。草稿仍保留，請核對後取消修改。</p> : latest && latest.revision !== editing.original.revision && <p className="hint">較新版本：{latest.content}（{labels[latest.category] ?? latest.category}）。草稿尚未套用；請核對後取消修改，再重新更正。</p>}
        <div className="row"><button className="primary" disabled={busy || loading || unavailable || editing.content.trim().length < 2}>儲存更正</button><button type="button" className="ghost" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>取消</button></div>
      </form>}
      {error && <p className="hint tone-error" role="alert">{error}</p>}
      {items === null ? <p className="hint">{loading ? '讀取中…' : '尚未載入記憶，請重新讀取。'}</p> : !items.length ? <p className="hint">還沒有記憶。</p> : groups.map(g => (
        <div key={g.key} className="memory-group">
          <p className="memory-group-label">{g.label}</p>
          <ul>{g.list.map(m => <li key={m.id}>
            <span className="memory-text">{m.content}<small>原始來源：{sourceLabel(m.source)}</small><small>建立：<MemoryDate value={m.created_at} /> · 內容更新：<MemoryDate value={m.updated_at} /></small></span>
            <span className="memory-actions">
              <button type="button" className="ghost" disabled={busy || loading || Boolean(editing)} onClick={() => { setEditing({ original: m, content: m.content, category: m.category }); setError(''); }}>更正</button>
              <button type="button" className="ghost" disabled={busy || loading || Boolean(editing)} onClick={() => { if (window.confirm(`刪除這筆長期記憶？此動作無法復原，不會清除對話紀錄。\n「${m.content}」`)) void send('DELETE', { id: m.id, revision: m.revision }); }}>刪除</button>
            </span>
          </li>)}</ul>
        </div>
      ))}
    </section>
  );
}
