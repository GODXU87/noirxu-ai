'use client';

import { useEffect, useState } from 'react';

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

type State = 'checking' | 'unsupported' | 'needs-install' | 'off' | 'on' | 'denied';

/** Turns phone/desktop notifications on or off for this device. */
export function Notifications({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setState(ios && !standalone ? 'needs-install' : 'unsupported');
        return;
      }
      if (Notification.permission === 'denied') { setState('denied'); return; }
      const registration = await navigator.serviceWorker.ready;
      setState((await registration.pushManager.getSubscription()) ? 'on' : 'off');
    })().catch(() => setState('unsupported'));
  }, []);

  async function enable() {
    setBusy(true); setMessage('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setState(permission === 'denied' ? 'denied' : 'off'); return; }
      const keyResponse = await (await fetch('/api/push/key')).json();
      if (!keyResponse.ok) throw new Error(keyResponse.error?.message ?? '無法取得通知金鑰');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyResponse.publicKey) });
      const saved = await (await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) })).json();
      if (!saved.ok) throw new Error(saved.error?.message ?? '儲存失敗');
      setState('on');
      setMessage('通知已開啟。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '開啟失敗');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
    }
    setState('off'); setBusy(false); setMessage('這台裝置的通知已關閉。');
  }

  async function test() {
    setBusy(true);
    const result = await (await fetch('/api/push/test', { method: 'POST' })).json().catch(() => ({ ok: false }));
    setBusy(false);
    setMessage(result.ok ? (result.sent ? '已送出測試通知。' : '沒有可用的裝置，請重新開啟通知。') : (result.error?.message ?? '送出失敗'));
  }

  const text: Record<State, string> = {
    checking: '檢查中…',
    unsupported: '這個瀏覽器不支援推播通知。',
    'needs-install': 'iPhone 需要先把 NOIRXU AI 加到主畫面：Safari 分享 →「加入主畫面」，再從主畫面打開後開啟通知。',
    off: '開啟後，記下的事會在前一晚、當天早上提醒你，每天 08:00 也會送今日摘要。',
    on: '這台裝置已開啟通知：事項提醒與每天 08:00 今日摘要。',
    denied: '通知被瀏覽器封鎖了，請到系統設定 → 通知 → NOIRXU AI 開啟。'
  };

  return (
    <div className={compact ? 'notify compact' : 'notify'}>
      <p className="hint">{text[state]}</p>
      <div className="row">
        {state === 'off' && <button className="primary" disabled={busy} onClick={enable}>開啟通知</button>}
        {state === 'on' && <><button disabled={busy} onClick={test}>傳送測試通知</button><button className="ghost" disabled={busy} onClick={disable}>關閉</button></>}
      </div>
      {message && <p className="hint" style={{ color: 'var(--accent)' }}>{message}</p>}
    </div>
  );
}
