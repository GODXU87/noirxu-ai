'use client';

import { useState } from 'react';
import type { ConnectionStatus } from '@/server/connections';

interface TestResult { ok: boolean; tool: string; code?: string; message?: string; tradeDate?: string | null }

const GMAIL_MESSAGES: Record<string, string> = {
  connected: 'Gmail 授權完成。',
  denied: '你取消了 Google 授權，沒有任何變更。',
  error: 'Google 授權沒有完成，請再試一次。'
};

function GmailSetup({ redirectUri }: { redirectUri: string | null }) {
  return (
    <div className="setup">
      <p className="hint">Gmail 需要你自己的 Google Cloud OAuth 用戶端（NOIRXU AI 不會使用任何其他服務的 Gmail 憑證）：</p>
      <ol>
        <li>到 Google Cloud Console 建立專案，啟用「Gmail API」。</li>
        <li>OAuth 同意畫面：使用者類型選「外部」，新增範圍 <code>gmail.readonly</code> 與 <code>gmail.send</code>，並把自己的 Gmail 加入「測試使用者」。</li>
        <li>建立「OAuth 用戶端 ID」，類型「網頁應用程式」，已授權的重新導向 URI 填：<br /><code>{redirectUri ?? 'https://<你的 NOIRXU AI 網域>/api/connections/gmail/callback'}</code></li>
        <li>把用戶端 ID、密鑰、重新導向 URI 設為伺服器環境變數 <code>GOOGLE_OAUTH_CLIENT_ID</code>、<code>GOOGLE_OAUTH_CLIENT_SECRET</code>、<code>GOOGLE_OAUTH_REDIRECT_URI</code>，重新部署。</li>
      </ol>
      <p className="hint">注意：OAuth 應用維持「測試中」狀態時，Google 的授權每 7 天會失效一次，需要回來重新連接；要長期有效必須送 Google 審核。</p>
    </div>
  );
}

function Card({ status, onChange }: { status: ConnectionStatus; onChange: () => void }) {
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
    if (result.ok) setMessage({ ok: true, text: status.id === 'radar' ? `連線正常，最近市場資料日期：${result.tradeDate ?? '未知'}` : `連線正常（${result.tool}）` });
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

  return (
    <section className="card">
      <h2>{status.name}<span className={`pill ${status.connected ? 'on' : ''}`}>{!status.configured ? '未設定' : status.connected ? '已連線' : '未連線'}</span></h2>
      {status.id === 'gmail' && status.connected && (
        <p className="hint">帳號：{status.account ?? '—'}<br />授權範圍：讀信 {status.grants?.read ? '✓' : '✗'}　寄信 {status.grants?.send ? '✓' : '✗'}</p>
      )}
      {!status.configured && (status.id === 'gmail' ? <GmailSetup redirectUri={null} /> : <p className="hint">{status.setupHint}</p>)}

      {status.configured && (status.id === 'ledger' || status.id === 'journal') && !status.connected && (
        <form onSubmit={connect}>
          <p className="hint">用你在 {status.name} 的帳號登入。密碼只用來登入一次，不會被儲存；之後以你的身分存取，原系統的權限規則照常生效。</p>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
          <input type="password" placeholder="密碼" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          <button className="primary" disabled={busy}>連接</button>
        </form>
      )}

      {status.configured && status.id === 'gmail' && (
        <div className="row">
          {!status.grants?.read && <a href="/api/connections/gmail/authorize?grant=read"><button type="button" className="primary">授權讀信</button></a>}
          {!status.grants?.send && <a href="/api/connections/gmail/authorize?grant=send"><button type="button">另外授權寄信</button></a>}
        </div>
      )}

      <div className="row">
        {status.configured && (status.connected || status.id === 'radar') && <button onClick={test} disabled={busy}>測試連線</button>}
        {status.connected && status.id !== 'radar' && <button className="danger" onClick={disconnect} disabled={busy}>斷開連接</button>}
      </div>
      {message && <p className="hint" style={{ color: message.ok ? 'var(--accent)' : 'var(--danger)' }}>{message.text}</p>}

      <details>
        <summary>可用工具（{status.tools.length}）</summary>
        <ul>{status.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.kind !== 'read' ? '（需確認）' : ''}</li>)}</ul>
      </details>
    </section>
  );
}

export function Connections({ initial, gmailResult, redirectUri }: { initial: ConnectionStatus[]; gmailResult: string | null; redirectUri: string | null }) {
  const [statuses, setStatuses] = useState(initial);
  async function refresh() {
    const response = await fetch('/api/connections');
    const body = await response.json();
    if (body.ok) setStatuses(body.connections);
  }
  return (
    <>
      {gmailResult && GMAIL_MESSAGES[gmailResult] && <p className="banner">{GMAIL_MESSAGES[gmailResult]}</p>}
      <div className="cards">{statuses.map(status => <Card key={status.id} status={status} onChange={refresh} />)}</div>
      {redirectUri && <p className="hint">Gmail 重新導向 URI：<code>{redirectUri}</code></p>}
    </>
  );
}
