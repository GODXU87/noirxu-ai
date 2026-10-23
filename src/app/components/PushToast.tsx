'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';

/** Shows a notification inside the app when it arrives while SASUKE is open on screen. */
export function PushToast() {
  const router = useRouter();
  const [toast, setToast] = useState<{ title: string; body: string; url: string } | null>(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let timer = 0;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'noirxu-push' || document.visibilityState !== 'visible') return;
      setToast({ title: String(event.data.title), body: String(event.data.body ?? ''), url: String(event.data.url ?? '/') });
      window.dispatchEvent(new Event('noirxu-inbox-changed'));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(null), 8000);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => { window.clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', onMessage); };
  }, []);
  if (!toast) return null;
  return (
    <button type="button" className="sk-toast" role="status" onClick={() => { setToast(null); router.push(toast.url); }}>
      <Icon name="bell" size={18} />
      <span><b>{toast.title}</b>{toast.body && <small>{toast.body}</small>}</span>
    </button>
  );
}
