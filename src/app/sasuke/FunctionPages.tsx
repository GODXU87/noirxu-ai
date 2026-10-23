'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AgendaCard, Panel, type Loaded } from '../overview/Overview';
import { Icon, type IconName } from '../components/Icon';
import { WaterMeter } from '../components/assistant';
import { callTool, TaskCard } from '../components/shared';
import { monthBounds } from '@/lib/tool-labels';
import { listConversations } from './conversations';
import { HistoryDialog } from './SasukeNav';

// Function pages for the SASUKE interface. Each one manages one area in detail and hands
// everyday work back to the conversation through "ask" links (/?c=new&ask=…), so the chat
// stays the main way to get things done.

export function askHref(question: string) {
  return `/?c=new&t=${Date.now().toString(36)}&ask=${encodeURIComponent(question)}`;
}

function Ask({ question, label, icon }: { question: string; label: string; icon: IconName }) {
  return <Link className="fp-ask" href={askHref(question)}><Icon name={icon} size={15} />{label}</Link>;
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

export function TasksView() {
  return (
    <main className="stack fp">
      <Head title="任務中心" lead="你交代的事項與提醒。SASUKE 在對話中執行的每個工具步驟，會直接顯示在對話裡。" />
      <div className="fp-asks">
        <Ask question="依重要程度幫我排今天和這週的事，指出時間衝突。" label="請 SASUKE 排優先順序" icon="check" />
        <Ask question="有哪些事已經過期了？" label="檢查過期事項" icon="bell" />
      </div>
      <AutoTasks />
      <AgendaCard />
    </main>
  );
}

/** Background tasks (recurring reminders, scheduled briefings, spending watches). */
function AutoTasks() {
  const [state, setState] = useState<{ tasks: any[] } | { error: string } | undefined>();
  const [all, setAll] = useState(false);
  useEffect(() => {
    void callTool('tasks.list', { include_finished: all }).then(r => setState(r.status === 'ok' ? r.data as { tasks: any[] } : { error: r.status === 'error' && r.code === 'UNKNOWN_TOOL' ? '自動任務功能目前沒有開啟。' : '任務清單目前讀不到。' }));
  }, [all]);
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>自動任務</h2>
        <button type="button" className="ghost" onClick={() => setAll(a => !a)}>{all ? '只看進行中' : '含已結束'}</button>
      </div>
      {!state ? <p className="hint">讀取中…</p>
        : 'error' in state ? <p className="hint">{state.error}</p>
        : state.tasks.length ? <div className="task-list">{state.tasks.map(t => <TaskCard key={t.id} task={t} />)}</div>
        : <p className="hint">還沒有自動任務。在對話裡說「每天早上 8 點提醒我喝水」或「每週一早上 9 點給我早報」就會建立。</p>}
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
const STATUS: Record<string, string> = { provider_accepted: '已推播', grouped: '已合併通知', retry_pending: '待重試', failed: '推播失敗', expired: '未推播', pending: '等待中', sending: '發送中' };

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
      <Head title="提醒與生活" lead="喝水、提醒與通知紀錄。通知的開啟與故障排除在「設定與連線」。" />
      {waterEnabled && (
        <section className="card">
          <p className="section-label">今日飲水</p>
          {water ? <WaterMeter data={water} onChange={setWater} /> : <div className="mc-skeleton" aria-hidden="true"><i /><i /></div>}
          <div className="fp-asks"><Ask question="依我今天的活動量，調整喝水目標和提醒時間。" label="調整喝水設定" icon="drop" /></div>
        </section>
      )}
      <section className="card">
        <p className="section-label">通知紀錄<small><Link href="/connections">通知設定</Link></small></p>
        {inbox === null ? <div className="mc-skeleton" aria-hidden="true"><i /><i /></div> : inbox.length === 0 ? <p className="hint">還沒有通知。提醒、今日摘要和喝水提醒都會記在這裡。</p> : (
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
      <Head title="個人記憶" lead="SASUKE 記住的偏好與重要決定，以及你的對話紀錄。" />
      <section className="card">
        <p className="section-label">長期記憶</p>
        <p className="hint">尚未啟用。長期記憶需要在資料庫新增資料表（已設計完成，等待你核准）。啟用前，SASUKE 只會記得同一段對話裡的內容；帳務、交易與行情一律以 Ledger、Journal、RADAR 的即時資料為準，不會用記憶代替。</p>
      </section>
      <section className="card">
        <p className="section-label">對話紀錄</p>
        <p className="hint">{count === null ? '讀取中…' : `這台裝置上有 ${count} 段對話，不會自動刪除。`}</p>
        <div className="row"><button type="button" onClick={() => setOpen(true)}><Icon name="history" size={16} />開啟對話紀錄</button></div>
      </section>
      {open && <HistoryDialog onClose={() => setOpen(false)} />}
    </main>
  );
}
