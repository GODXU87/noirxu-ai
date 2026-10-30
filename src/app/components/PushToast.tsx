'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Toast { id: number; title: string; body: string; url: string }

/**
 * Shows notifications inside the app when they arrive while SASUKE is open on screen. They
 * stack (newest on top, up to three) so two that arrive together — say the evening briefing
 * and a reminder — are both seen; each closes on its own after 10 seconds.
 */
export function PushToast() {
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const timers: number[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'noirxu-push' || document.visibilityState !== 'visible') return;
      const toast: Toast = { id: ++seq.current, title: String(event.data.title), body: String(event.data.body ?? ''), url: String(event.data.url ?? '/') };
      setToasts(prev => [toast, ...prev].slice(0, 3));
      window.dispatchEvent(new Event('noirxu-inbox-changed'));
      timers.push(window.setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), 10_000));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => { timers.forEach(t => window.clearTimeout(t)); navigator.serviceWorker.removeEventListener('message', onMessage); };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="sk-toasts" role="status">
      {toasts.map(toast => (
        <button key={toast.id} type="button" className="sk-toast" onClick={() => { setToasts(prev => prev.filter(t => t.id !== toast.id)); router.push(toast.url); }}>
          <Icon name="bell" size={18} />
          <span><b>{toast.title}</b>{toast.body && <small>{toast.body}</small>}</span>
        </button>
      ))}
    </div>
  );
}
