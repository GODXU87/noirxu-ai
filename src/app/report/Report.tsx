'use client';

import { useEffect, useState } from 'react';
import { money, monthBounds, taipeiToday } from '@/lib/tool-labels';
import { Icon } from '../components/Icon';
import { AgendaList, callTool, Links, ToolData, type AgendaView, type InvokeResult } from '../components/shared';

type Loaded = InvokeResult | null | undefined;

function shift(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function Section({ label, result, source }: { label: string; result: Loaded; source: string }) {
  if (result === null) return null;
  return (
    <section className="card">
      <p className="section-label">{label}<small>{source}</small></p>
      {result === undefined && <p className="hint">載入中…</p>}
      {result?.status === 'error' && <p className="status-error">{result.message}</p>}
      {result?.status === 'ok' && <>{ToolData({ tool: result.tool, data: result.data })}<div className="no-print"><Links links={result.links} /></div></>}
    </section>
  );
}

/** Plain-language summary built only from the numbers on this page (no AI, nothing invented). */
function summaryLines(analytics: Loaded, assets: Loaded, performance: Loaded, agenda: AgendaView[] | null): string[] {
  const lines: string[] = [];
  if (analytics?.status === 'ok') {
    const a = analytics.data as any;
    const change = a.comparison?.expense?.change;
    lines.push(`本月支出 ${a.currency} ${money(a.summary.expense)}${change != null ? `，較上月${change >= 0 ? '增加' : '減少'} ${Math.abs(change)}%` : ''}；收入 ${money(a.summary.income)}，淨額 ${money(a.summary.netFlow)}。`);
    const top = a.expense_by_category?.[0];
    if (top) lines.push(`最大支出類別是「${top.name}」，${a.currency} ${money(top.amount)}，佔 ${top.percentage}%。`);
  }
  if (assets?.status === 'ok') {
    const w = assets.data as any;
    lines.push(`目前淨資產 TWD ${money(w.net_worth)}（資產 ${money(w.gross_assets)}，負債 ${money(w.liabilities)}）。`);
  }
  if (performance?.status === 'ok') {
    const p = performance.data as any;
    for (const row of p.by_currency) lines.push(`${row.currency} 已平倉 ${row.closed_trades} 筆，勝率 ${row.win_rate_pct ?? '—'}%，淨損益 ${money(row.net_pnl)}。`);
    if (!p.by_currency.length) lines.push('本月沒有已平倉交易。');
  }
  if (agenda) {
    const urgent = agenda.filter(i => i.priority === 'urgent').length;
    lines.push(`未來 30 天有 ${agenda.length} 件待辦事項${urgent ? `，其中 ${urgent} 件緊急` : ''}。`);
  }
  return lines;
}

export function Report({ connected, requestedMonth }: { connected: Record<string, boolean>; requestedMonth: string | null }) {
  const current = taipeiToday().slice(0, 7);
  const month = requestedMonth && requestedMonth <= current ? requestedMonth : current;
  const [analytics, setAnalytics] = useState<Loaded>();
  const [budget, setBudget] = useState<Loaded>();
  const [assets, setAssets] = useState<Loaded>();
  const [performance, setPerformance] = useState<Loaded>();
  const [agenda, setAgenda] = useState<AgendaView[] | null>(null);
  // Set in the browser only, so the server render and hydration never disagree on the second.
  const [generatedAt, setGeneratedAt] = useState('');
  useEffect(() => setGeneratedAt(new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })), []);

  useEffect(() => {
    if (connected.ledger) {
      void callTool('ledger.analytics.get', { month }).then(setAnalytics);
      void callTool('ledger.budget.summary', { month }).then(setBudget);
      void callTool('ledger.assets.summary', {}).then(setAssets);
    } else { setAnalytics(null); setBudget(null); setAssets(null); }
    if (connected.journal) void callTool('journal.performance.summary', monthBounds(month)).then(setPerformance); else setPerformance(null);
    void callTool('agenda.items.list', { days: 30 }).then(r => setAgenda(r.status === 'ok' ? (r.data as { items: AgendaView[] }).items : []));
  }, [connected.ledger, connected.journal, month]);

  const lines = summaryLines(analytics, assets, performance, agenda);
  const label = `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;

  return (
    <main className="stack">
      <div className="page-head">
        <div><p className="eyebrow">個人財務與行程報告</p><h1>{label}</h1></div>
        <div className="page-actions">
          <a href={`/report?month=${shift(month, -1)}`}><button className="ghost" aria-label="上個月">‹</button></a>
          {month < current && <a href={`/report?month=${shift(month, 1)}`}><button className="ghost" aria-label="下個月">›</button></a>}
          <button className="ghost" onClick={() => window.print()}><Icon name="print" size={16} />列印 / PDF</button>
        </div>
      </div>

      <section className="panel">
        <p className="section-label">摘要</p>
        {lines.length ? <ul className="rich" style={{ margin: 0, paddingLeft: 18 }}>{lines.map(line => <li key={line}>{line}</li>)}</ul> : <p className="hint">尚無可彙整的資料。連接 Ledger 與 Journal 後，這裡會自動產生本月摘要。</p>}
      </section>

      <div className="report-grid">
        <Section label="收支分析" result={analytics} source="NOIRXU Ledger" />
        <Section label="預算" result={budget} source="NOIRXU Ledger" />
        <Section label="資產與淨資產" result={assets} source="NOIRXU Ledger · 今日" />
        <Section label="交易績效" result={performance} source="NOIRXU Trading Journal" />
      </div>

      <section className="card">
        <p className="section-label">未來 30 天事項<small>NOIRXU AI 記事</small></p>
        {agenda === null ? <p className="hint">載入中…</p> : <AgendaList items={agenda} />}
      </section>

      <p className="report-note">產生時間 {generatedAt}（台北時間）。所有數字直接取自各原系統，計算方式與原網站相同；資產為今日估值。這份報告不是投資建議。</p>
    </main>
  );
}
