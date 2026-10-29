'use client';

import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '@/server/connections';
import { toolLabel } from '@/lib/tool-labels';
import { Notifications } from '../components/Notifications';

interface TestResult { ok: boolean; tool: string; code?: string; message?: string; tradeDate?: string | null }

const GMAIL_MESSAGES: Record<string, string> = {
  connected: 'Gmail 授權完成。',
  denied: '你取消了 Google 授權，沒有任何變更。',
  error: 'Google 授權沒有完成，請再試一次。'
};

const DESCRIPTIONS: Record<string, string> = {
  ledger: '記帳、預算、分析、資產與淨資產',
  journal: '交易紀錄、績效與統計',
  radar: '台股市場資料、個股分析與掃描',
  gmail: '搜尋、閱讀、撰寫與寄送郵件'
};

function GmailSetup({ redirectUri }: { redirectUri: string | null }) {
  return (
    <details className="setup">
      <summary>設定步驟（需要你自己的 Google Cloud OAuth 用戶端）</summary>
      <ol>
        <li>到 Google Cloud Console 建立專案，啟用「Gmail API」。</li>
        <li>OAuth 同意畫面：使用者類型選「外部」，新增範圍 <code>gmail.readonly</code> 與 <code>gmail.send</code>，把自己的 Gmail 加入「測試使用者」。</li>
        <li>建立「OAuth 用戶端 ID」（網頁應用程式），重新導向 URI 填：<br /><code>{redirectUri ?? 'https://noirxu-ai.vercel.app/api/connections/gmail/callback'}</code></li>
        <li>把用戶端 ID、密鑰、重新導向 URI 設為 Vercel 環境變數 <code>GOOGLE_OAUTH_CLIENT_ID</code>、<code>GOOGLE_OAUTH_CLIENT_SECRET</code>、<code>GOOGLE_OAUTH_REDIRECT_URI</code>，再重新部署。</li>
      </ol>
      <p className="hint">OAuth 應用維持「測試中」時，Google 的授權每 7 天會失效一次，需要回來重新連接。</p>
    </details>
  );
}

function Connection({ status, onChange, redirectUri }: { status: ConnectionStatus; onChange: () => void; redirectUri: string | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function post(path: string, body?: unknown) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      return await response.json();
    } catch {
      return { ok: false, error: { message: '網路錯誤' } };
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    const result = await post(`/api/connections/${status.id}/test`) as TestResult & { error?: { message: string } };
    if (result.ok) setMessage({ ok: true, text: status.id === 'radar' ? `連線正常 · 最近市場資料日期 ${result.tradeDate ?? '未知'}` : '連線正常' });
    else setMessage({ ok: false, text: result.message ?? result.error?.message ?? '測試失敗' });
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    const result = await post(`/api/connections/${status.id}/connect`, { email, password });
    setPassword('');
    if (result.ok) { setMessage({ ok: true, text: `已連接 ${result.account}` }); onChange(); }
    else setMessage({ ok: false, text: result.error?.message ?? '連接失敗' });
  }

  async function disconnect() {
    const result = await post(`/api/connections/${status.id}/disconnect`);
    if (result.ok) { setMessage({ ok: true, text: '已斷開並撤銷授權。' }); onChange(); }
    else setMessage({ ok: false, text: result.error?.message ?? '斷開失敗' });
  }

  const badge = !status.configured ? '未設定' : status.connected ? '已連線' : '未連線';

  return (
    <section className="card conn">
      <div className="conn-head">
        <span className={`dot ${status.connected ? 'on' : ''}`} />
        <div><h2>{status.name}</h2><p className="conn-meta">{DESCRIPTIONS[status.id]}</p></div>
        <span className={`pill ${status.connected ? 'on' : ''}`}>{badge}</span>
      </div>

      {status.id === 'gmail' && status.connected && (
        <p className="conn-meta">帳號 {status.account ?? '—'} · 讀信 {status.grants?.read ? '已授權' : '未授權'} · 寄信 {status.grants?.send ? '已授權' : '未授權'}</p>
      )}
      {!status.configured && (status.id === 'gmail' ? <GmailSetup redirectUri={redirectUri} /> : <p className="hint">{status.setupHint}</p>)}

      {status.configured && (status.id === 'ledger' || status.id === 'journal') && !status.connected && (
        <form onSubmit={connect}>
          <input type="email" placeholder={`${status.name} 的 Email`} value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
          <input type="password" placeholder="密碼" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          <button className="primary" disabled={busy}>{busy ? '連接中…' : '連接'}</button>
          <p className="hint">密碼只用來登入一次，不會儲存。之後以你的身分存取，原系統的權限規則照常生效。</p>
        </form>
      )}

      {status.configured && status.id === 'gmail' && (
        <div className="row">
          {!status.grants?.read && <a href="/api/connections/gmail/authorize?grant=read"><button type="button" className="primary">授權讀信</button></a>}
          {!status.grants?.send && <a href="/api/connections/gmail/authorize?grant=send"><button type="button">另外授權寄信</button></a>}
        </div>
      )}

      {(status.connected || (status.configured && status.id === 'radar')) && (
        <div className="row">
          <button className="ghost" onClick={test} disabled={busy}>測試連線</button>
          {status.connected && status.id !== 'radar' && <button className="danger" onClick={disconnect} disabled={busy}>斷開連接</button>}
        </div>
      )}
      {message && <p className="hint" style={{ color: message.ok ? 'var(--accent)' : 'var(--danger)' }}>{message.text}</p>}

      <details>
        <summary>可用功能 {status.tools.length} 項</summary>
        <p className="hint" style={{ marginTop: 6 }}>{status.tools.map(tool => `${toolLabel(tool.name)}${tool.kind !== 'read' ? '（需確認）' : ''}`).join('、')}</p>
      </details>
    </section>
  );
}

export function Connections({ initial, gmailResult, redirectUri, garmin = false }: { initial: ConnectionStatus[]; gmailResult: string | null; redirectUri: string | null; garmin?: boolean }) {
  const [statuses, setStatuses] = useState(initial);
  async function refresh() {
    const response = await fetch('/api/connections');
    const body = await response.json();
    if (body.ok) setStatuses(body.connections);
  }
  return (
    <main className="stack">
      {gmailResult && GMAIL_MESSAGES[gmailResult] && <p className="banner">{GMAIL_MESSAGES[gmailResult]}</p>}
      <div>
        <p className="section-label">資料來源</p>
        <div className="conn-list cards two">{statuses.map(status => <Connection key={status.id} status={status} onChange={refresh} redirectUri={redirectUri} />)}{garmin && <GarminCard />}</div>
      </div>
      <div>
        <p className="section-label">AI 成本保護</p>
        <section className="card"><p className="hint">本地能回答的問題不呼叫付費 AI；可設定每日、每月上限並查看實際用量。</p><div className="row"><a href="/cost"><button type="button">查看與設定</button></a></div></section>
        <p className="section-label">通知</p>
        <section className="card"><Notifications /></section>
      </div>
    </main>
  );
}

/** Garmin Connect Personal API key (feature 'garmin'). The key is sent once, sealed on the server and never shown again. */
function GarminCard() {
  const [status, setStatus] = useState<any>(null);
  const [key, setKey] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { void fetch('/api/garmin').then(r => r.json()).then(b => setStatus(b.ok ? b.garmin : null)); }, []);
  async function call(method: 'POST' | 'DELETE', body?: unknown) {
    setBusy(true); setMessage('');
    const res = await fetch('/api/garmin', { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (!res?.ok) { setMessage(res?.error?.message ?? '操作失敗'); return; }
    setStatus(res.garmin); setKey('');
    if (res.check) setMessage(res.check.message);
  }
  return (
    <section className="card conn">
      <div className="conn-head"><b>Garmin Connect</b><span className={`state-chip ${status?.connected ? (status.key_expired || status.last_error ? 'error' : 'ok') : ''}`}>{status?.connected ? (status.key_expired ? '金鑰已過期' : status.last_error ? '需要處理' : '已設定') : '未連接'}</span></div>
      <p className="hint">唯讀，只讀你自己的 Garmin 資料。使用 Garmin 官方 Personal API，不需要也不會詢問 Garmin 帳號密碼。運動與健康指標僅供參考，不是醫療診斷。</p>
      {status?.connected ? (
        <>
          <p className="hint">金鑰 {status.key_hint}{status.key_expires_on ? ` · 到期 ${status.key_expires_on}` : ''} · 最後檢查 {status.last_check_at ? new Date(status.last_check_at).toLocaleString('zh-TW') : '—'}{status.last_check_status ? `（HTTP ${status.last_check_status}）` : ''}</p>
          <p className="hint">最後同步 {status.last_sync_at ? new Date(status.last_sync_at).toLocaleString('zh-TW') : '尚未同步'}{status.last_error ? ` · 最近錯誤：${String(status.last_error).replace(/。$/, '')}` : ''}。SASUKE 需要時才讀取，不另外保存你的健康資料。</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="primary" disabled={busy} onClick={() => void call('POST', { action: 'sync' })}>立即同步</button>
            <button type="button" disabled={busy} onClick={() => void call('POST', { action: 'verify' })}>重新檢查金鑰</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { if (window.confirm('中斷 Garmin 連接並刪除保存的金鑰？')) void call('DELETE'); }}>中斷連接</button>
          </div>
        </>
      ) : (
        <form className="stack" onSubmit={e => { e.preventDefault(); void call('POST', { api_key: key, key_expires_on: expires || null }); }}>
          <ol className="hint">
            <li>用電腦登入 Garmin Connect 網頁 → 設定 → Personal API Key（connect.garmin.com/app/settings/personalApiToken）。</li>
            <li>按 Create Key，閱讀並接受條款，選擇到期時間，再按 Create。</li>
            <li>金鑰只會顯示一次：複製後貼到下面（不要貼在聊天裡）。</li>
          </ol>
          <input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="貼上 Garmin Personal API Key" aria-label="Garmin Personal API Key" />
          <label className="hint">金鑰到期日（選填）<input type="date" value={expires} onChange={e => setExpires(e.target.value)} /></label>
          <button className="primary" disabled={busy || key.trim().length < 16}>儲存並檢查</button>
        </form>
      )}
      {message && <p className="hint">{message}</p>}
    </section>
  );
}
