'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';

interface Entry { key: string; kind: string; title: string; body: string; url?: string; created_at: string; read: boolean; status: string }

const STATUS: Record<string, string> = { provider_accepted: '已推播', grouped: '已合併通知', retry_pending: '待重試', failed: '推播失敗', expired: '未推播', pending: '等待中', sending: '發送中', claimed: '發送中' };

function when(iso: string) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/**
 * In-app notification inbox in the header. Every reminder lands here whether or not a device
 * received the push, so nothing is lost while notifications are off.
 */
export function Inbox() {
  const [items, setItems] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const body = await (await fetch('/api/inbox')).json().catch(() => null);
    if (body?.ok) setItems(body.items);
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('click', close);
    window.addEventListener('noirxu-inbox-changed', load);
    return () => { document.removeEventListener('visibilitychange', onVisible); document.removeEventListener('click', close); window.removeEventListener('noirxu-inbox-changed', load); };
  }, [load]);

  if (!items) return null;
  const unread = items.filter(i => !i.read).length;

  async function markAll() {
    setItems(list => list?.map(i => ({ ...i, read: true })) ?? null);
    await fetch('/api/inbox/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: 'all' }) });
  }

  return (
    <div className="inbox" ref={box}>
      <button type="button" className="inbox-btn" onClick={() => { setOpen(o => !o); if (!open) void load(); }} aria-expanded={open} aria-label={unread ? `通知，${unread} 則未讀` : '通知'}>
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="inbox-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="inbox-pop" role="dialog" aria-label="通知">
          <header><b>通知</b>{unread > 0 && <button type="button" className="link" onClick={() => void markAll()}>全部標為已讀</button>}</header>
          {items.length === 0 ? <p className="hint">還沒有通知。提醒、今日摘要和喝水提醒都會出現在這裡。</p> : (
            <ul>{items.slice(0, 8).map(i => (
              <li key={i.key} className={i.read ? '' : 'unread'}>
                <b>{i.title}</b>
                {i.body && <span>{i.body}</span>}
                <small>{when(i.created_at)} · {STATUS[i.status] ?? i.status}</small>
              </li>
            ))}</ul>
          )}
          <Link href="/connections" className="inbox-more" onClick={() => setOpen(false)}>通知設定與完整紀錄 →</Link>
        </div>
      )}
    </div>
  );
}
