'use client';

import { useCallback, useEffect, useState } from 'react';
import { money, monthBounds, taipeiToday } from '@/lib/tool-labels';
import { Icon } from '../components/Icon';
import { LedgerDraftCard } from '../components/assistant';
import { AgendaList, callTool, Links, ProposalCard, ToolData, type AgendaView, type InvokeResult } from '../components/shared';

const EXPENSE_METHODS = ['信用卡', '現金', '轉帳', 'LINE Pay', 'Apple Pay', '悠遊卡'];
const INCOME_METHODS = ['轉帳', '現金', 'LINE Pay', '其他'];
const NAMES: Record<string, string> = { ledger: 'Ledger', journal: 'Journal', radar: 'RADAR', gmail: 'Gmail' };

export type Loaded = InvokeResult | null | undefined;

export function Panel({ label, result, children }: { label: string; result: Loaded; children?: React.ReactNode }) {
  if (result === null) return null;
  return (
    <section className="card">
      <p className="section-label">{label}</p>
      {result === undefined && <p className="hint">載入中…</p>}
      {result?.status === 'error' && <p className="status-error">{result.message}</p>}
      {result?.status === 'ok' && <>{ToolData({ tool: result.tool, data: result.data })}<Links links={result.links} /></>}
      {children}
    </section>
  );
}

function Hero({ analytics, assets, month }: { analytics: Loaded; assets: Loaded; month: string }) {
  const a = analytics?.status === 'ok' ? analytics.data as any : null;
  const w = assets?.status === 'ok' ? assets.data as any : null;
  return (
    <section className="panel hero">
      <div className="hero-main">
        <span>{Number(month.slice(5))} 月支出{a ? ` · ${a.currency}` : ''}</span>
        <strong>{a ? money(a.summary.expense) : analytics === undefined ? '…' : '—'}</strong>
        {a?.comparison?.expense?.change != null && <small>較上月 {a.comparison.expense.change >= 0 ? '增加' : '減少'} {Math.abs(a.comparison.expense.change)}%</small>}
        {analytics?.status === 'error' && <small className="status-error">{analytics.message}</small>}
      </div>
      <div className="hero-stats">
        <div><span>本月收入</span><b className="tone-up">{a ? money(a.summary.income) : '—'}</b></div>
        <div><span>本月淨額</span><b className={a && a.summary.netFlow < 0 ? 'tone-down' : 'tone-up'}>{a ? money(a.summary.netFlow) : '—'}</b></div>
        <div><span>淨資產 TWD</span><b>{w ? money(w.net_worth) : '—'}</b></div>
      </div>
    </section>
  );
}

export function AgendaCard() {
  const [items, setItems] = useState<AgendaView[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const result = await callTool('agenda.items.list', { days: 60 });
    if (result.status === 'ok') setItems((result.data as { items: AgendaView[] }).items);
    else if (result.status === 'error') { setItems([]); setMessage(result.message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setMessage('');
    const result = await callTool('agenda.items.create', { text });
    setBusy(false);
    if (result.status === 'ok') {
      const data = result.data as { item: AgendaView; reminders: unknown[] };
      setText('');
      setMessage(`已記下「${data.item.title}」· ${data.item.due_label}${data.reminders.length ? ` · 會提醒 ${data.reminders.length} 次` : ''}`);
      void load();
    } else if (result.status === 'error') setMessage(result.message);
  }

  return (
    <section className="card">
      <p className="section-label">近期事項<small>依重要程度排序 · 點一下可修改</small></p>
      <form className="quick-add" onSubmit={add}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="例如：11/11 要教學演示 很重要" maxLength={300} aria-label="新增事項" />
        <button className="primary" disabled={busy || !text.trim()} aria-label="記下"><Icon name="plus" size={18} /></button>
      </form>
      {message && <p className="hint">{message}</p>}
      {items === null ? <p className="hint">載入中…</p> : <AgendaList items={items} onChanged={load} emptyText="還沒有事項。在上面輸入一句話就能記下，會自動判斷日期與重要程度。" />}
    </section>
  );
}

interface Category { id: string; type: 'expense' | 'income'; name: string }

function QuickEntry({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState({ amount: '', category_id: '', occurred_on: taipeiToday(), payment_method: '現金', merchant: '', note: '' });
  const [proposal, setProposal] = useState<Extract<InvokeResult, { status: 'confirmation_required' }> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [line, setLine] = useState('');
  const [draft, setDraft] = useState<any>(null);
  const [draftKey, setDraftKey] = useState(0);

  async function sketch(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    const result = await callTool('assistant.ledger.draft', { text: line });
    setBusy(false);
    if (result.status === 'ok') { setDraft(result.data); setDraftKey(k => k + 1); }
    else if (result.status === 'error') { setError(result.code === 'UNKNOWN_TOOL' ? '一句話記帳目前已關閉，請用手動填寫。' : result.message); if (result.code === 'UNKNOWN_TOOL') setManual(true); }
  }

  useEffect(() => {
    void callTool('ledger.categories.list', {}).then(result => {
      if (result.status === 'ok') setCategories((result.data as { categories: Category[] }).categories);
      else if (result.status === 'error') setError(result.message);
    });
  }, []);

  const options = categories.filter(category => category.type === type);
  const methods = type === 'expense' ? EXPENSE_METHODS : INCOME_METHODS;
  const set = (key: keyof typeof form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  function switchType(next: 'expense' | 'income') {
    setType(next);
    setForm(prev => ({ ...prev, category_id: '', payment_method: next === 'expense' ? '現金' : '轉帳' }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setProposal(null);
    const result = await callTool(`ledger.${type}.create`, {
      amount: Number(form.amount), category_id: form.category_id, occurred_on: form.occurred_on,
      payment_method: form.payment_method, merchant: form.merchant, note: form.note
    });
    setBusy(false);
    if (result.status === 'confirmation_required') setProposal(result);
    else if (result.status === 'error') setError(result.message);
  }

  if (!manual) {
    return (
      <section className="card">
        <p className="section-label">記一筆<small><button type="button" className="link-button" onClick={() => setManual(true)}>手動填寫</button></small></p>
        {draft ? (
          <>
            <LedgerDraftCard key={draftKey} {...draft} onNote={note => { if (note.includes('執行成功')) onSaved(); }} />
            <button type="button" className="ghost" onClick={() => { setDraft(null); setLine(''); }}>再記一筆</button>
          </>
        ) : (
          <form className="quick-add" onSubmit={sketch}>
            <input value={line} onChange={e => setLine(e.target.value)} placeholder="例如：午餐 150 元 刷卡" maxLength={300} aria-label="一句話記帳" required />
            <button className="primary" disabled={busy || !line.trim()} aria-label="整理"><Icon name="arrow" size={18} /></button>
          </form>
        )}
        {error && <p className="status-error">{error}</p>}
        {!draft && <p className="hint">用一句話描述，我會整理成記帳草稿；你確認後才寫入 Ledger。</p>}
      </section>
    );
  }

  return (
    <section className="card">
      <p className="section-label">手動記帳
        <span className="seg" style={{ marginLeft: 'auto' }}>
          <button type="button" className={type === 'expense' ? 'on' : ''} onClick={() => switchType('expense')}>支出</button>
          <button type="button" className={type === 'income' ? 'on' : ''} onClick={() => switchType('income')}>收入</button>
        </span>
      </p>
      {proposal ? (
        <>
          <ProposalCard result={proposal} onDone={(_, outcome) => { if (outcome?.status === 'succeeded') { onSaved(); setForm(prev => ({ ...prev, amount: '', merchant: '', note: '' })); } }} />
          <button type="button" className="ghost" onClick={() => setProposal(null)}>再記一筆</button>
        </>
      ) : (
        <form className="entry" onSubmit={submit}>
          <label className="amount"><span>金額</span><input inputMode="decimal" type="number" min="0" step="any" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0" required /></label>
          <label><span>分類</span>
            <select value={form.category_id} onChange={e => set('category_id', e.target.value)} required>
              <option value="">選擇分類</option>
              {options.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <label><span>日期</span><input type="date" value={form.occurred_on} max={taipeiToday()} onChange={e => set('occurred_on', e.target.value)} required /></label>
          <label><span>付款方式</span>
            <select value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>{methods.map(method => <option key={method}>{method}</option>)}</select>
          </label>
          <label><span>{type === 'expense' ? '店家' : '來源'}</span><input value={form.merchant} onChange={e => set('merchant', e.target.value)} maxLength={80} placeholder="選填" /></label>
          <label className="amount" style={{ gridColumn: '1 / -1' }}><span>備註</span><input style={{ fontSize: 15, fontWeight: 400 }} value={form.note} onChange={e => set('note', e.target.value)} maxLength={200} placeholder="選填" /></label>
          {error && <p className="status-error">{error}</p>}
          <button className="primary" disabled={busy || !form.amount || !form.category_id}>{busy ? '處理中…' : '下一步：確認'}</button>
        </form>
      )}
    </section>
  );
}

/** `finance`: the SASUKE 財務 page — money only; the agenda lives in 任務中心. */
export function Overview({ connected, finance = false }: { connected: Record<string, boolean>; finance?: boolean }) {
  const today = taipeiToday();
  const month = today.slice(0, 7);
  const [analytics, setAnalytics] = useState<Loaded>();
  const [budget, setBudget] = useState<Loaded>();
  const [assets, setAssets] = useState<Loaded>();
  const [performance, setPerformance] = useState<Loaded>();
  const [radar, setRadar] = useState<Loaded>();

  const loadLedger = useCallback(() => {
    if (!connected.ledger) { setAnalytics(null); setBudget(null); setAssets(null); return; }
    void callTool('ledger.analytics.get', { month }).then(setAnalytics);
    void callTool('ledger.budget.summary', { month }).then(setBudget);
    void callTool('ledger.assets.summary', {}).then(setAssets);
  }, [connected.ledger, month]);

  useEffect(() => {
    loadLedger();
    if (connected.journal) void callTool('journal.performance.summary', monthBounds(month)).then(setPerformance); else setPerformance(null);
    if (connected.radar) void callTool('radar.status', {}).then(setRadar); else setRadar(null);
  }, [connected.journal, connected.radar, loadLedger, month]);

  const missing = Object.keys(NAMES).filter(id => !connected[id]);
  const date = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

  return (
    <main className="stack">
      <div className="page-head">
        <div><p className="eyebrow">{date}</p><h1>{finance ? '財務' : '總覽'}</h1></div>
        <div className="page-actions"><a href="/report"><button className="ghost"><Icon name="report" size={16} />本月報告</button></a></div>
      </div>

      {connected.ledger && <Hero analytics={analytics} assets={assets} month={month} />}

      <div className={finance ? 'cards' : 'cards two'}>
        {!finance && <AgendaCard />}
        {connected.ledger ? <QuickEntry onSaved={loadLedger} /> : (
          <section className="card">
            <p className="section-label">開始使用</p>
            <p className="hint">連接 Ledger 後，這裡會出現快速記帳，上方會顯示本月收支與淨資產。</p>
            <a href="/connections"><button className="primary">前往連線<Icon name="arrow" size={16} /></button></a>
          </section>
        )}
      </div>

      {(connected.ledger || connected.journal || connected.radar) && (
        <div className="cards two">
          <Panel label="本月預算" result={budget} />
          <Panel label="資產配置" result={assets} />
          <Panel label="Journal 本月績效" result={performance} />
          <Panel label="RADAR 資料" result={radar} />
        </div>
      )}

      {missing.length > 0 && (
        <div className="setup-strip">
          <span>尚未連接：</span>
          {missing.map(id => <a key={id} className="pill" href="/connections"><span className="dot" />{NAMES[id]}</a>)}
          <a href="/connections" style={{ marginLeft: 'auto' }}>設定 →</a>
        </div>
      )}
    </main>
  );
}
