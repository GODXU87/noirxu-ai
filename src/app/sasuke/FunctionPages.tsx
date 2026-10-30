'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AgendaCard, Panel, type Loaded } from '../overview/Overview';
import { Icon, type IconName } from '../components/Icon';
import { WaterMeter } from '../components/assistant';
import { callTool, TaskCard } from '../components/shared';
import { monthBounds } from '@/lib/tool-labels';
import { listConversations } from './conversations';
import { HistoryDialog } from './SasukeNav';
import { GoalsPanel } from '../components/Goals';
import { useTaskList } from './useTaskList';
import { LongTermMemory } from './LongTermMemory';

// Function pages for the SASUKE interface. Each one manages one area in detail and hands
// everyday work back to the conversation through "ask" links (/?c=new&ask=…), so the chat
// stays the main way to get things done.

export function askHref(question: string) {
  return `/?c=new&t=${Date.now().toString(36)}&ask=${encodeURIComponent(question)}`;
}

function Ask({ question, label, icon }: { question: string; label: string; icon: IconName }) {
  // The rendered href is stable (server and browser agree); the unique one is made on tap.
  const router = useRouter();
  return <Link className="fp-ask" href={`/?c=new&ask=${encodeURIComponent(question)}`} onClick={e => { e.preventDefault(); router.push(askHref(question)); }}><Icon name={icon} size={15} />{label}</Link>;
}

function Head({ title, lead }: { title: string; lead: string }) {
  return <div className="page-head"><div><h1>{title}</h1><p className="hint">{lead}</p></div></div>;
}

function NotConnected({ name }: { name: string }) {
  return (
    <section className="card fp-empty">
      <p>{name} 尚未連接。</p>
      <Link href="/connections"><button className="primary">前往設定與連線<Icon name="arrow" size={16} /></button></Link>
    </section>
  );
}

export function TasksView({ goalId }: { goalId?: string } = {}) {
  return (
    <main className="stack fp">
      <Head title="任務中心" lead="你交代的事項與提醒。SASUKE 在對話中執行的每個工具步驟，會直接顯示在對話裡。" />
      <div className="fp-asks">
        <Ask question="依重要程度幫我排今天和這週的事，指出時間衝突。" label="請 SASUKE 排優先順序" icon="check" />
        <Ask question="有哪些事已經過期了？" label="檢查過期事項" icon="bell" />
      </div>
      <GoalsPanel initialGoalId={goalId} />
      <AutoTasks />
      <AgendaCard />
    </main>
  );
}

/** Background tasks (recurring reminders, scheduled briefings, spending watches). */
function AutoTasks() {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: state, updatedAt, refreshing, offline, error, refresh } = useTaskList(all);
  const [actionError, setActionError] = useState('');
  const halted = Boolean(state?.halted);
  async function toggleHalt() {
    if (!halted && !window.confirm('停止所有背景自動任務？任務與紀錄都會保留，之後可以恢復。')) return;
    setBusy(true); setActionError('');
    const result = await callTool('tasks.halt', { halted: !halted });
    setBusy(false);
    if (result.status !== 'ok') setActionError(result.status === 'error' ? result.message : '操作未完成。');
  }
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2>自動任務</h2>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="ghost" onClick={() => setAll(a => !a)}>{all ? '只看進行中' : '含已結束'}</button>
          <button type="button" className="ghost" disabled={refreshing || offline} onClick={refresh}>{refreshing ? '更新中…' : '重新整理'}</button>
          {state && <button type="button" className={halted ? 'primary' : 'ghost'} disabled={busy} onClick={() => void toggleHalt()}>{halted ? '恢復自動任務' : '緊急停止'}</button>}
        </div>
      </div>
      <p className="hint" role="status" aria-live="polite">{offline ? '目前離線；顯示上次讀取的資料。' : refreshing ? '正在更新任務…' : error ?? '此頁可見且連線時，每 20 秒檢查更新。'}{updatedAt && <> 最後更新 <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></>}</p>
      {actionError && <p className="hint tone-error" role="alert">{actionError}</p>}
      {halted && <p className="banner danger">所有背景自動任務已停止。任務與紀錄都保留，按「恢復自動任務」從下一個排程繼續。</p>}
      {!state ? <p className="hint">{offline ? '連線恢復後會重新讀取。' : error ? '尚未取得任務資料，可重新整理。' : '讀取中…'}</p>
        : state.tasks.length ? <div className="task-list">{state.tasks.map(t => <TaskCard key={t.id} task={t} />)}</div>
        : <p className="hint">還沒有自動任務。在對話裡說「每天早上 8 點提醒我喝水」或「每天晚上幫我整理明天的工作，重要的事再通知我」就會建立。</p>}
      <div className="fp-asks"><Ask question="如果這個月餐飲支出超過 5000 元就提醒我" label="建立支出監看" icon="chart" /></div>
    </section>
  );
}

export function ResearchView({ connected, radarUrl }: { connected: Record<string, boolean>; radarUrl: string | null }) {
  const [radar, setRadar] = useState<Loaded>();
  const [performance, setPerformance] = useState<Loaded>();
  const [symbol, setSymbol] = useState('');
  useEffect(() => {
    if (connected.radar) void callTool('radar.status', {}).then(setRadar); else setRadar(null);
    if (connected.journal) {
      const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()).slice(0, 7);
      void callTool('journal.performance.summary', monthBounds(month)).then(setPerformance);
    } else setPerformance(null);
  }, [connected.radar, connected.journal]);
  const code = symbol.trim().toUpperCase();
  return (
    <main className="stack fp">
      <Head title="投資研究" lead="RADAR 的真實資料與你的 Journal 紀錄。研究結果註明資料日期與失效條件，不提供買賣保證，也不會自動下單。" />
      {!connected.radar ? <NotConnected name="NOIRXU RADAR" /> : (
        <>
          <form className="fp-symbol" onSubmit={e => { e.preventDefault(); if (code) window.location.assign(askHref(`幫我研究 ${code}：用 RADAR 的資料說明評分、訊號、資料日期、風險與失效條件。`)); }}>
            <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="股票代號，例如 2330" aria-label="股票代號" inputMode="text" maxLength={10} />
            <button className="primary" disabled={!code}>研究這檔</button>
          </form>
          <div className="fp-asks">
            <Ask question="RADAR 最新一個交易日有哪些值得注意的訊號？註明資料日期。" label="最新訊號" icon="chart" />
            <Ask question="RADAR 的資料目前更新到哪一天？" label="資料更新狀態" icon="calendar" />
            {radarUrl && <a className="fp-ask" href={radarUrl} target="_blank" rel="noreferrer"><Icon name="link" size={15} />開啟 RADAR</a>}
          </div>
          <Panel label="RADAR 資料狀態" result={radar} />
        </>
      )}
      {connected.journal && (
        <>
          <div className="fp-asks"><Ask question="我這個月的交易績效如何？勝率、損益和最大的問題是什麼？" label="檢討本月交易" icon="report" /></div>
          <Panel label="Journal 本月績效" result={performance} />
        </>
      )}
    </main>
  );
}

export function MailView({ connected }: { connected: Record<string, boolean> }) {
  return (
    <main className="stack fp">
      <Head title="郵件" lead="SASUKE 可以整理信件、擬回覆草稿；寄出前一律顯示收件人、主旨與內文，等你確認。" />
      {!connected.gmail ? <NotConnected name="Gmail" /> : (
        <div className="fp-asks">
          <Ask question="整理我最近的未讀信件，列出需要我回覆或處理的。" label="整理未讀信件" icon="mail" />
          <Ask question="最近有哪些信需要我回覆？幫我各擬一份草稿，先不要寄。" label="擬回覆草稿" icon="edit" />
          <Ask question="這週有沒有帳單、繳費或行程相關的信？" label="找帳單與行程" icon="calendar" />
        </div>
      )}
    </main>
  );
}

interface InboxRow { key: string; title: string; body: string; created_at: string; read: boolean; status: string }
const STATUS: Record<string, string> = { provider_accepted: '推播服務已接受', grouped: '已合併通知', retry_pending: '待重試', failed: '推播失敗', expired: '未推播', pending: '等待中', sending: '發送中' };

/** Today's body status from Garmin (the same rules as the briefings); hidden when Garmin is off. */
function BodyCard() {
  const [body, setBody] = useState<any>(undefined);
  useEffect(() => {
    void fetch('/api/today?part=body', { cache: 'no-store' }).then(r => r.json()).then(setBody).catch(() => setBody({ error: { message: '連線中斷，請重新整理。' } }));
  }, []);
  if (body?.off) return null;
  return (
    <section className="card body-card">
      <p className="section-label">身體狀況<small>Garmin · {body?.when === 'evening' ? '今天' : '昨晚與今天'}</small></p>
      {body === undefined ? <div className="mc-skeleton" aria-hidden="true"><i /><i /></div>
        : body.error ? (
          <>
            <p className="hint">{body.error.code === 'NOT_CONNECTED' ? 'Garmin 尚未連接。' : body.error.message}</p>
            {body.error.code === 'NOT_CONNECTED' && <div className="fp-asks"><Link className="fp-ask" href="/connections"><Icon name="link" size={15} />前往連接 Garmin</Link></div>}
          </>
        ) : (
          <>
            {body.headline && <p className="body-headline">{body.headline}</p>}
            {body.signals?.length > 0 && <div className="health-chips">{body.signals.map((sig: { key: string; tone: string; text: string }) => <span key={sig.key} className={`health-chip tone-${sig.tone}`}>{sig.text}</span>)}</div>}
            {body.narrative?.length > 0 && <div className="brief-prose">{body.narrative.map((p: string, i: number) => <p key={i}>{p}</p>)}</div>}
            <div className="fp-asks">
              <Ask question="今天怎麼練" label="今天怎麼練" icon="heart" />
              <Ask question="這週訓練量和上週比較" label="這週 vs 上週" icon="chart" />
              <Ask question="最近 7 晚的睡眠趨勢" label="睡眠趨勢" icon="sun" />
            </div>
            <p className="hint">裝置指標僅供參考，不是醫療診斷。</p>
          </>
        )}
    </section>
  );
}

export function LifeView({ water: waterEnabled }: { water: boolean }) {
  const [water, setWater] = useState<any>(null);
  const [inbox, setInbox] = useState<InboxRow[] | null>(null);
  useEffect(() => {
    if (waterEnabled) void callTool('health.water.status', {}).then(r => { if (r.status === 'ok') setWater(r.data); });
    void fetch('/api/inbox').then(r => r.json()).then(b => setInbox(b?.ok ? b.items : [])).catch(() => setInbox([]));
  }, [waterEnabled]);
  const when = (iso: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return (
    <main className="stack fp">
      <Head title="提醒與生活" lead="身體狀況、喝水、提醒與通知紀錄。通知的開啟與故障排除在「設定與連線」。" />
      <BodyCard />
      {waterEnabled && (
        <section className="card">
          <p className="section-label">今日飲水</p>
          {water ? <WaterMeter data={water} onChange={setWater} /> : <div className="mc-skeleton" aria-hidden="true"><i /><i /></div>}
          <div className="fp-asks"><Ask question="依我今天的活動量，調整喝水目標和提醒時間。" label="調整喝水設定" icon="drop" /></div>
        </section>
      )}
      <section className="card">
        <p className="section-label">通知紀錄<small><Link href="/connections">通知設定</Link></small></p>
        {inbox === null ? <div className="mc-skeleton" aria-hidden="true"><i /><i /></div> : inbox.length === 0 ? <p className="hint">還沒有通知。提醒、早晚報和喝水提醒都會記在這裡。</p> : (
          <ul className="fp-inbox">{inbox.map(i => <li key={i.key} className={i.read ? '' : 'unread'}><b>{i.title}</b>{i.body && <span>{i.body}</span>}<small>{when(i.created_at)} · {STATUS[i.status] ?? i.status}</small></li>)}</ul>
        )}
      </section>
    </main>
  );
}

export function MemoryView() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { setCount(listConversations().length); }, []);
  return (
    <main className="stack fp">
      <Head title="個人記憶" lead="SASUKE 記住的偏好、作息、目標與重要決定。只記你要它記的事，不會自動保存聊天內容；帳務、交易與行情一律以即時資料為準。" />
      <LongTermMemory />
      <section className="card">
        <p className="section-label">對話紀錄</p>
        <p className="hint">{count === null ? '讀取中…' : `這台裝置上有 ${count} 段對話，不會自動刪除。`}</p>
        <div className="row"><button type="button" onClick={() => setOpen(true)}><Icon name="history" size={16} />開啟對話紀錄</button></div>
      </section>
      {open && <HistoryDialog onClose={() => setOpen(false)} />}
    </main>
  );
}
