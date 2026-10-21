'use client';

import { useCallback, useEffect, useState } from 'react';
import { monthBounds, taipeiToday } from '@/lib/tool-labels';
import { callTool, Links, ProposalCard, ToolData, type InvokeResult } from '../components/shared';

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

export function Overview({ connected }: { connected: Record<string, boolean> }) {
  const month = taipeiToday().slice(0, 7);
  const [analytics, setAnalytics] = useState<InvokeResult | null>();
  const [budget, setBudget] = useState<InvokeResult | null>();
  const [performance, setPerformance] = useState<InvokeResult | null>();
  const [radar, setRadar] = useState<InvokeResult | null>();

  const loadLedger = useCallback(() => {
    if (!connected.ledger) { setAnalytics(null); setBudget(null); return; }
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
        {connected.ledger ? <QuickEntry onSaved={loadLedger} /> : <section className="card"><h2>快速記帳</h2><p className="hint">先到 <a href="/connections">連線</a> 頁連接 Ledger。</p></section>}
        <Panel title="Ledger 本月收支" result={analytics} empty="尚未連接 Ledger。" />
        <Panel title="Ledger 本月預算" result={budget} empty="尚未連接 Ledger。" />
        <Panel title="Journal 本月績效" result={performance} empty="尚未連接 Trading Journal。" />
        <Panel title="RADAR 資料" result={radar} empty="RADAR 整合尚未設定。" />
      </div>
    </main>
  );
}
