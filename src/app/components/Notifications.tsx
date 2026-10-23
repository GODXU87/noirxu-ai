'use client';

import { useCallback, useEffect, useState } from 'react';

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function bufferToBase64Url(buffer: ArrayBuffer | null) {
  if (!buffer) return null;
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface DeviceInfo {
  platform: 'iPhone' | 'iPad' | 'Mac' | 'Android' | 'Windows' | 'other';
  browser: string;
  standalone: boolean;
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  sw: 'registered' | 'registering' | 'failed' | 'unsupported' | 'missing';
  swError?: string;
  subscription: PushSubscription | null;
  subscriptionKey: string | null;
}

interface DeviceRow { device: string; platform: string; service: string; created_at: string | null; last_success_at: string | null; is_this: boolean }
interface DeviceResult { device: string; platform: string; outcome: string; error?: string }
interface HistoryRow { key: string; kind: string; title: string; created_at: string; status: string; attempts: number; last_error: string | null; next_retry_at: string | null; accepted_at: string | null; devices: DeviceResult[] }
interface ServerStatus {
  publicKey: string;
  server_has_this_device: boolean;
  devices: DeviceRow[];
  scheduler: { last: { at: string; source: string; ok: boolean; error?: string } | null; age_minutes: number | null; healthy: boolean };
  history: HistoryRow[];
}

const STATUS_LABEL: Record<string, string> = {
  pending: '等待發送', claimed: '處理中', sending: '發送中', provider_accepted: '推播服務已接受', retry_pending: '等待重試', failed: '發送失敗', expired: '已過期未送出'
};
const OUTCOME_LABEL: Record<string, string> = {
  accepted: '推播服務已接受', gone: '訂閱已失效', vapid_mismatch: '金鑰不一致', rate_limited: '被限流', provider_error: '推播服務錯誤', network_error: '網路錯誤', rejected: '推播服務拒絕', invalid_endpoint: '端點無效'
};
const KIND_LABEL: Record<string, string> = { reminder: '事項提醒', briefing: '今日摘要', water: '喝水提醒' };

function fmt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

async function inspectDevice(): Promise<DeviceInfo> {
  const ua = navigator.userAgent;
  const platform: DeviceInfo['platform'] = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const info: DeviceInfo = { platform, browser, standalone, supported, permission: 'Notification' in window ? Notification.permission : 'unsupported', sw: 'unsupported', subscription: null, subscriptionKey: null };
  if (!('serviceWorker' in navigator)) return info;
  const registration = await navigator.serviceWorker.getRegistration();
  const reported = window.__noirxuSW;
  info.sw = registration?.active ? 'registered' : reported?.status === 'failed' ? 'failed' : reported?.status === 'registering' ? 'registering' : 'missing';
  info.swError = reported?.error;
  if (registration && 'pushManager' in registration) {
    info.subscription = await registration.pushManager.getSubscription();
    info.subscriptionKey = bufferToBase64Url(info.subscription?.options.applicationServerKey ?? null);
  }
  return info;
}

type Feedback = { tone: 'ok' | 'warn' | 'error'; text: string; details?: DeviceResult[] } | null;

/** Notification setup and diagnostics for this device, plus scheduler health and delivery history. */
export function Notifications() {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    const info = await inspectDevice().catch(() => null);
    setDevice(info);
    const query = info?.subscription ? `?endpoint=${encodeURIComponent(info.subscription.endpoint)}` : '';
    const body = await (await fetch(`/api/push/status${query}`)).json().catch(() => null);
    if (body?.ok) setServer(body);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setFeedback(null);
    try { await fn(); } catch (error) { setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '操作失敗' }); }
    finally { setBusy(null); await refresh(); }
  }

  async function subscribe() {
    // Must run directly from a tap: Safari only shows the permission prompt for a user gesture.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知被拒絕了，請依下方的排除步驟到系統設定開啟。' : '尚未允許通知。');
    const registration = await navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
    const key = await (await fetch('/api/push/key')).json();
    if (!key.ok) throw new Error(key.error?.message ?? '無法取得通知金鑰');
    const existing = await registration.pushManager.getSubscription();
    if (existing && bufferToBase64Url(existing.options.applicationServerKey) !== key.publicKey) await existing.unsubscribe();
    const subscription = (await registration.pushManager.getSubscription()) ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) });
    const saved = await (await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) })).json();
    if (!saved.ok) throw new Error(saved.error?.message ?? '伺服器沒有存下這台裝置的訂閱');
    setFeedback({ tone: 'ok', text: '這台裝置已訂閱通知。建議按「傳送測試通知」確認。' });
  }

  async function resubscribe() {
    const registration = await navigator.serviceWorker.getRegistration();
    const current = await registration?.pushManager.getSubscription();
    if (current) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: current.endpoint }) });
      await current.unsubscribe();
    }
    await subscribe();
  }

  async function disable() {
    const registration = await navigator.serviceWorker.getRegistration();
    const current = await registration?.pushManager.getSubscription();
    if (current) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: current.endpoint }) });
      await current.unsubscribe();
    }
    setFeedback({ tone: 'ok', text: '這台裝置的通知已關閉。其他裝置不受影響。' });
  }

  async function test() {
    const body = await (await fetch('/api/push/test', { method: 'POST' })).json();
    if (!body.ok) throw new Error(body.error?.message ?? '測試通知沒有送出');
    if (body.noSubscription) { setFeedback({ tone: 'error', text: '沒有任何已訂閱的裝置，推播沒有送出。請先在這台裝置開啟通知。' }); return; }
    const accepted = body.devices.filter((d: DeviceResult) => d.outcome === 'accepted').length;
    setFeedback({
      tone: accepted === body.devices.length ? 'ok' : accepted ? 'warn' : 'error',
      text: accepted
        ? `已提交發送：${accepted} / ${body.devices.length} 台裝置的推播服務已接受。伺服器無法確認裝置是否已顯示，請看這台裝置有沒有跳出通知。`
        : '推播服務拒絕了所有裝置，見下方原因。',
      details: body.devices
    });
  }

  async function checkScheduler() {
    const body = await (await fetch('/api/cron/catchup', { method: 'POST' })).json();
    if (!body.ok) throw new Error(body.error?.message ?? '排程檢查失敗');
    setFeedback({ tone: 'ok', text: body.ran ? '已立即執行一次排程，到期的提醒已處理。' : '排程五分鐘內剛執行過，狀態正常。' });
  }

  if (!device) return <p className="hint">檢查這台裝置的通知狀態…</p>;

  const apple = device.platform === 'iPhone' || device.platform === 'iPad';
  const needsInstall = apple && !device.standalone;
  const subscribed = Boolean(device.subscription);
  const keyMismatch = Boolean(server && device.subscriptionKey && device.subscriptionKey !== server.publicKey);
  const serverMismatch = subscribed && server && !server.server_has_this_device;
  const lastSend = server?.history.find(h => h.status !== 'pending');
  const lastFailure = server?.history.find(h => h.last_error);
  const needsAction = needsInstall || device.permission === 'denied' || !subscribed || keyMismatch || serverMismatch || device.sw === 'failed';

  const rows: Array<[string, string, 'ok' | 'warn' | 'error' | 'muted']> = [
    ['裝置', `${device.platform === 'other' ? '其他' : device.platform} · ${device.browser}${device.standalone ? ' · 主畫面 App' : ''}`, 'muted'],
    ['推播支援', device.supported ? '支援' : needsInstall ? '需先加入主畫面' : '不支援', device.supported ? 'ok' : 'error'],
    ['通知權限', device.permission === 'granted' ? '已允許' : device.permission === 'denied' ? '已封鎖' : device.permission === 'default' ? '尚未詢問' : '不支援', device.permission === 'granted' ? 'ok' : device.permission === 'denied' ? 'error' : 'warn'],
    ['Service Worker', device.sw === 'registered' ? '運作中' : device.sw === 'failed' ? `註冊失敗${device.swError ? `：${device.swError}` : ''}` : device.sw === 'registering' ? '註冊中' : device.sw === 'missing' ? '尚未註冊' : '不支援', device.sw === 'registered' ? 'ok' : device.sw === 'failed' ? 'error' : 'warn'],
    ['這台裝置的訂閱', subscribed ? (keyMismatch ? '有，但金鑰與伺服器不一致' : '有') : '沒有', subscribed && !keyMismatch ? 'ok' : 'error'],
    ['伺服器端紀錄', !subscribed ? '—' : server?.server_has_this_device ? '相符' : '伺服器沒有這台裝置', !subscribed ? 'muted' : server?.server_has_this_device ? 'ok' : 'error'],
    ['最後成功送達推播服務', fmt(server?.devices.find(d => d.is_this)?.last_success_at), 'muted'],
    ['排程最後執行', server?.scheduler.last ? `${fmt(server.scheduler.last.at)}（${server.scheduler.age_minutes} 分鐘前 · ${server.scheduler.last.source === 'github-actions' ? 'GitHub' : server.scheduler.last.source === 'app-catchup' ? '開啟 App 時補跑' : server.scheduler.last.source}）` : '尚無紀錄', server?.scheduler.healthy ? 'ok' : 'warn'],
    ['最後一次發送', lastSend ? `${KIND_LABEL[lastSend.kind] ?? lastSend.kind} · ${STATUS_LABEL[lastSend.status] ?? lastSend.status} · ${fmt(lastSend.accepted_at ?? lastSend.created_at)}` : '尚無紀錄', lastSend?.status === 'provider_accepted' ? 'ok' : lastSend ? 'warn' : 'muted'],
    ['最近失敗原因', lastFailure?.last_error ?? '無', lastFailure ? 'error' : 'muted']
  ];

  return (
    <div className="notify-diag">
      <div className="diag-head">
        <div>
          <b>{needsAction ? '這台裝置需要處理' : '這台裝置可以接收通知'}</b>
          <p className="hint">提醒會在前一晚與當天早上送出，每天 08:00 送今日摘要。所有通知也會保留在站內紀錄。</p>
        </div>
        <span className={`state-chip ${needsAction ? 'error' : 'ok'}`}>{needsAction ? '需要處理' : '正常'}</span>
      </div>

      <dl className="diag-grid">
        {rows.map(([label, value, tone]) => <div key={label}><dt>{label}</dt><dd className={`tone-${tone}`}>{value}</dd></div>)}
      </dl>

      <div className="row diag-actions">
        {!subscribed && device.supported && device.permission !== 'denied' && <button className="primary" disabled={Boolean(busy)} data-loading={busy === 'subscribe' || undefined} onClick={() => void run('subscribe', subscribe)}>{busy === 'subscribe' ? '開啟中…' : '開啟通知'}</button>}
        {subscribed && <button className="primary" disabled={Boolean(busy)} data-loading={busy === 'test' || undefined} onClick={() => void run('test', test)}>{busy === 'test' ? '發送中…' : '傳送測試通知'}</button>}
        {device.supported && device.permission !== 'denied' && <button disabled={Boolean(busy)} data-loading={busy === 'resubscribe' || undefined} onClick={() => void run('resubscribe', resubscribe)}>{busy === 'resubscribe' ? '重新訂閱中…' : '重新建立訂閱'}</button>}
        <button disabled={Boolean(busy)} data-loading={busy === 'scheduler' || undefined} onClick={() => void run('scheduler', checkScheduler)}>{busy === 'scheduler' ? '檢查中…' : '檢查排程'}</button>
        <button className="ghost" disabled={Boolean(busy)} onClick={() => setShowHistory(s => !s)}>{showHistory ? '收起通知紀錄' : '查看通知紀錄'}</button>
        {subscribed && <button className="ghost" disabled={Boolean(busy)} onClick={() => void run('disable', disable)}>取消這台裝置的通知</button>}
      </div>

      {feedback && (
        <div className={`diag-feedback tone-${feedback.tone}`} role="status">
          <p>{feedback.text}</p>
          {feedback.details && <ul>{feedback.details.map(d => <li key={d.device}>{d.platform}：{OUTCOME_LABEL[d.outcome] ?? d.outcome}{d.error && d.outcome !== 'accepted' ? `（${d.error}）` : ''}</li>)}</ul>}
        </div>
      )}

      {server && server.devices.length > 0 && (
        <div className="diag-devices">
          <p className="section-label">已訂閱的裝置</p>
          <ul>{server.devices.map(d => <li key={d.device}><b>{d.platform}{d.is_this ? '（這台）' : ''}</b><span>訂閱 {fmt(d.created_at)} · 最後送達推播服務 {fmt(d.last_success_at)}</span></li>)}</ul>
        </div>
      )}

      {showHistory && server && (
        <div className="diag-history">
          <p className="section-label">通知紀錄</p>
          {server.history.length === 0 ? <p className="hint">還沒有通知紀錄。</p> : (
            <ul>{server.history.map(h => (
              <li key={h.key}>
                <div><b>{h.title}</b><span className={`state-chip ${h.status === 'provider_accepted' ? 'ok' : h.status === 'failed' || h.status === 'expired' ? 'error' : 'pending'}`}>{STATUS_LABEL[h.status] ?? h.status}</span></div>
                <small>{KIND_LABEL[h.kind] ?? h.kind} · 建立 {fmt(h.created_at)} · 嘗試 {h.attempts} 次{h.next_retry_at ? ` · 下次重試 ${fmt(h.next_retry_at)}` : ''}</small>
                {h.last_error && <small className="tone-error">{h.last_error}</small>}
              </li>
            ))}</ul>
          )}
        </div>
      )}

      <details className="diag-guide" open={device.permission === 'denied' || needsInstall}>
        <summary>收不到通知？排除步驟</summary>
        {apple ? (
          <ol>
            <li>用 Safari 打開網站 → 分享 →「加入主畫面」，之後一律從主畫面圖示打開。</li>
            <li>在主畫面 App 裡打開這一頁，按「開啟通知」，在跳出的視窗按「允許」。</li>
            <li>iPhone「設定」→「通知」→ NOIRXU AI → 開啟「允許通知」，並勾選「鎖定畫面」與「橫幅」。</li>
            <li>「設定」→「專注模式」：若有開啟，把 NOIRXU AI 加入允許的 App。</li>
            <li>仍收不到：按「重新建立訂閱」，再按「傳送測試通知」。</li>
          </ol>
        ) : device.platform === 'Mac' ? (
          <ol>
            <li>Safari →「設定」→「網站」→「通知」，找到 noirxu-ai.vercel.app，設為「允許」。</li>
            <li>Mac「系統設定」→「通知」→ Safari → 開啟「允許通知」，提示樣式選「橫幅」或「提示」。</li>
            <li>「系統設定」→「專注模式」：確認目前沒有擋住 Safari 的通知。</li>
            <li>回到這一頁按「開啟通知」或「重新建立訂閱」，再按「傳送測試通知」。</li>
          </ol>
        ) : (
          <ol>
            <li>在瀏覽器的網站設定中允許 noirxu-ai.vercel.app 的通知。</li>
            <li>確認作業系統允許此瀏覽器顯示通知。</li>
            <li>按「重新建立訂閱」，再按「傳送測試通知」。</li>
          </ol>
        )}
        <p className="hint">「推播服務已接受」代表 Apple / Google 的推播服務收下了訊息，不代表裝置一定已經顯示；裝置是否跳出通知要以實際畫面為準。</p>
      </details>
    </div>
  );
}
