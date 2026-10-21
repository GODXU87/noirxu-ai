'use client';

import { useState } from 'react';
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

export function Connections({ initial, gmailResult, redirectUri }: { initial: ConnectionStatus[]; gmailResult: string | null; redirectUri: string | null }) {
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
        <div className="conn-list cards two">{statuses.map(status => <Connection key={status.id} status={status} onChange={refresh} redirectUri={redirectUri} />)}</div>
      </div>
      <div>
        <p className="section-label">通知</p>
        <section className="card"><Notifications /></section>
      </div>
    </main>
  );
}
