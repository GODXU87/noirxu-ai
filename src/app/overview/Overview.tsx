'use client';

import { useCallback, useEffect, useState } from 'react';
import { monthBounds, taipeiToday } from '@/lib/tool-labels';
import { Notifications } from '../components/Notifications';
import { AgendaList, callTool, Links, ProposalCard, ToolData, type AgendaView, type InvokeResult } from '../components/shared';

const EXPENSE_METHODS = ['信用卡', '現金', '轉帳', 'LINE Pay', 'Apple Pay', '悠遊卡'];
const INCOME_METHODS = ['轉帳', '現金', 'LINE Pay', '其他'];

function Panel({ title, result, empty }: { title: string; result: InvokeResult | null | undefined; empty?: string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {result === undefined && <p className="hint">載入中…</p>}
      {result === null && <p className="hint">{empty}</p>}
      {result?.status === 'error' && <p className="status-error">{result.message}</p>}
      {result?.status === 'ok' && <>{ToolData({ tool: result.tool, data: result.data })}<Links links={result.links} /></>}
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

  return (
    <section className="card">
      <h2>快速記帳<span className="seg">
        <button type="button" className={type === 'expense' ? 'on' : ''} onClick={() => switchType('expense')}>支出</button>
        <button type="button" className={type === 'income' ? 'on' : ''} onClick={() => switchType('income')}>收入</button>
      </span></h2>
      {proposal ? (
        <>
          <ProposalCard result={proposal} onDone={(_, outcome) => { if (outcome?.status === 'succeeded') { onSaved(); setForm(prev => ({ ...prev, amount: '', merchant: '', note: '' })); } }} />
          <button type="button" onClick={() => setProposal(null)}>再記一筆</button>
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
          <label><span>備註</span><input value={form.note} onChange={e => set('note', e.target.value)} maxLength={200} placeholder="選填" /></label>
          {error && <p className="status-error">{error}</p>}
          <button className="primary" disabled={busy || !form.amount || !form.category_id}>{busy ? '處理中…' : '下一步：確認'}</button>
        </form>
      )}
    </section>
  );
}

function AgendaCard() {
  const [items, setItems] = useState<AgendaView[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const result = await callTool('agenda.items.list', { days: 60 });
    if (result.status === 'ok') setItems((result.data as { items: AgendaView[] }).items);
    else if (result.status === 'error') setMessage(result.message);
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

  async function done(id: string) {
    const result = await callTool('agenda.items.update', { id, status: 'done' });
    if (result.status === 'ok') void load();
    else if (result.status === 'error') setMessage(result.message);
  }

  return (
    <section className="card span-2">
      <h2>近期事項<small className="muted">依重要程度排序</small></h2>
      <form className="quick-add" onSubmit={add}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="例如：11/11 要教學演示 很重要" maxLength={300} />
        <button className="primary" disabled={busy || !text.trim()}>記下</button>
      </form>
      {message && <p className="hint">{message}</p>}
      {items === null ? <p className="hint">載入中…</p> : <AgendaList items={items} onDone={done} />}
    </section>
  );
}

export function Overview({ connected }: { connected: Record<string, boolean> }) {
  const month = taipeiToday().slice(0, 7);
  const [analytics, setAnalytics] = useState<InvokeResult | null>();
  const [budget, setBudget] = useState<InvokeResult | null>();
  const [performance, setPerformance] = useState<InvokeResult | null>();
  const [radar, setRadar] = useState<InvokeResult | null>();
  const [assets, setAssets] = useState<InvokeResult | null>();

  const loadLedger = useCallback(() => {
    if (!connected.ledger) { setAnalytics(null); setBudget(null); setAssets(null); return; }
    void callTool('ledger.assets.summary', {}).then(setAssets);
    void callTool('ledger.analytics.get', { month }).then(setAnalytics);
    void callTool('ledger.budget.summary', { month }).then(setBudget);
  }, [connected.ledger, month]);

  useEffect(() => {
    loadLedger();
    if (connected.journal) void callTool('journal.performance.summary', monthBounds(month)).then(setPerformance); else setPerformance(null);
    if (connected.radar) void callTool('radar.status', {}).then(setRadar); else setRadar(null);
  }, [connected.journal, connected.radar, loadLedger, month]);

  return (
    <main className="overview">
      <h1 className="page-title">{Number(month.slice(5))} 月總覽</h1>
      <div className="cards">
        <AgendaCard />
        {connected.ledger ? <QuickEntry onSaved={loadLedger} /> : <section className="card"><h2>快速記帳</h2><p className="hint">先到 <a href="/connections">連線</a> 頁連接 Ledger。</p></section>}
        <Panel title="Ledger 本月收支" result={analytics} empty="尚未連接 Ledger。" />
        <Panel title="Ledger 本月預算" result={budget} empty="尚未連接 Ledger。" />
        <Panel title="資產與淨資產" result={assets} empty="尚未連接 Ledger。" />
        <Panel title="Journal 本月績效" result={performance} empty="尚未連接 Trading Journal。" />
        <Panel title="RADAR 資料" result={radar} empty="RADAR 整合尚未設定。" />
        <section className="card"><h2>通知</h2><Notifications compact /></section>
      </div>
    </main>
  );
}
