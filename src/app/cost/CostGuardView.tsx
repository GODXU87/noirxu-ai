'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { flash } from '../components/feedback';

type Mode = 'economy' | 'balanced' | 'quality';
interface Config { mode: Mode; per_task_usd: number; daily_usd: number; monthly_usd: number; max_calls_per_task: number; max_concurrent: number }
interface Bucket { turns: number; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }
interface Usage {
  month: string; cost_usd: number; unpriced_turns: number; turns: number; model_calls: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; by_model: Record<string, Bucket>; by_feature: Record<string, Bucket>;
  local: { count: number; by_intent: Record<string, number> }; cache_hits: number; failures: number; budget_stops: number;
}
interface Data { config: Config; usage: Usage; today_usd: number; savings: { usd: number; basis: string } | null; models: Array<{ model: string; priced: boolean }> }

const MODES: Array<[Mode, string, string]> = [
  ['economy', '極致節省', '能在本地處理的一律本地；AI 以輕量模式為主，只有明確的研究與規劃才用完整模式。'],
  ['balanced', '智慧平衡', '預設。本地能答的不呼叫 AI；一般問題用輕量模式，研究、規劃、多步驟工作用完整模式。'],
  ['quality', '品質優先', '本地能答的仍不呼叫 AI；需要 AI 時一律用完整模式與較長的回覆上限。']
];
const FEATURE: Record<string, string> = { chat_L2: '對話（輕量）', chat_L3: '對話（完整）' };
const INTENT: Record<string, string> = { greeting: '問候', identity: '介紹', datetime: '日期時間', calc: '計算', water_status: '飲水查詢', agenda: '待辦查詢', ledger_month: '月支出查詢', memory_recall: '記憶查詢' };

const usd = (n: number) => `US$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString('en-US');

export function CostGuardView() {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    const body = await (await fetch('/api/cost')).json().catch(() => null);
    if (body?.ok) { setData(body); setDraft(body.config); } else setError(body?.error?.message ?? '讀取失敗');
  };
  useEffect(() => { void load(); }, []);

  async function save(next: Partial<Config>, button?: HTMLButtonElement) {
    button?.setAttribute('data-loading', '');
    const body = await (await fetch('/api/cost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })).json().catch(() => null);
    button?.removeAttribute('data-loading');
    if (body?.ok) { flash(button, 'success'); await load(); } else { flash(button, 'error'); setError(body?.error?.message ?? '儲存失敗'); }
  }

  if (!data || !draft) return <main className="stack fp"><div className="page-head"><div><h1>AI 成本保護</h1></div></div>{error ? <p className="banner danger">{error}</p> : <div className="mc-skeleton" aria-hidden="true"><i /><i /><i /></div>}</main>;
  const u = data.usage;
  const remaining = Math.max(0, data.config.monthly_usd - u.cost_usd);
  const unpriced = data.models.filter(m => !m.priced);

  return (
    <main className="stack fp">
      <div className="page-head"><div><p className="eyebrow"><Link href="/connections">設定與連線</Link></p><h1>AI 成本保護</h1><p className="hint">SASUKE 能用規則或已連接系統直接回答時，不會呼叫付費 AI。以下數字都是這個月實際量測的結果（{u.month}）。</p></div></div>
      {error && <p className="banner danger">{error}</p>}
      {unpriced.length > 0 && <p className="banner">尚未設定 {unpriced.map(m => m.model).join('、')} 的單價，費用無法計算（次數與 Token 仍會記錄）。在 Vercel 設定 NOIRXU_AI_PRICES 即可，例如 {'{"gpt-5.5":{"input":1.25,"output":10,"cacheRead":0.125}}'}（數字請以 OpenAI 官網價格為準）。</p>}

      <dl className="cost-grid">
        <div><dt>本月 AI 費用</dt><dd>{usd(u.cost_usd)}{u.unpriced_turns > 0 && <small>另有 {u.unpriced_turns} 次未計價</small>}</dd></div>
        <div><dt>本月預算剩餘</dt><dd>{usd(remaining)}<small>上限 {usd(data.config.monthly_usd)} · 今天 {usd(data.today_usd)} / {usd(data.config.daily_usd)}</small></dd></div>
        <div><dt>本地處理（零 AI Token）</dt><dd>{num(u.local.count)}<small>次</small></dd></div>
        <div><dt>AI 回覆 / API 呼叫</dt><dd>{num(u.turns)}<small> 次回覆 · {num(u.model_calls)} 次呼叫</small></dd></div>
        <div><dt>Token（輸入 / 輸出）</dt><dd>{num(u.input_tokens)}<small> / {num(u.output_tokens)}</small></dd></div>
        <div><dt>快取</dt><dd>{num(u.cache_read_tokens)}<small> Token 讀取 · {num(u.cache_write_tokens)} 寫入 · 工具結果命中 {num(u.cache_hits)} 次</small></dd></div>
        <div><dt>估計節省</dt><dd>{data.savings ? usd(data.savings.usd) : '—'}<small>{data.savings ? data.savings.basis : '還沒有可量測的 AI 回覆可作為基準'}</small></dd></div>
        <div><dt>失敗 / 預算擋下</dt><dd>{num(u.failures)}<small> 次失敗 · {num(u.budget_stops)} 次因預算停止</small></dd></div>
      </dl>

      <section className="card">
        <p className="section-label">處理方式</p>
        <div className="cost-modes" role="radiogroup" aria-label="AI 使用模式">
          {MODES.map(([id, label, hint]) => (
            <button key={id} type="button" role="radio" aria-checked={data.config.mode === id} className={data.config.mode === id ? 'on' : ''} onClick={e => void save({ mode: id }, e.currentTarget)}>
              <b>{label}</b><span>{hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <p className="section-label">上限</p>
        <form className="cost-limits" onSubmit={e => { e.preventDefault(); void save(draft, (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement); }}>
          {([['per_task_usd', '單次請求上限（US$）', 0.01], ['daily_usd', '每日上限（US$）', 0.1], ['monthly_usd', '每月上限（US$）', 1], ['max_calls_per_task', '單次最多模型呼叫', 1], ['max_concurrent', '同時進行的 AI 工作', 1]] as const).map(([key, label, step]) => (
            <label key={key}><span>{label}</span><input type="number" inputMode="decimal" min={0} step={step} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /></label>
          ))}
          <button className="primary" type="submit">儲存上限</button>
        </form>
        <p className="hint">超過上限時只會停止付費 AI；喝水、待辦、記帳金額等本地查詢照常可用。</p>
      </section>

      {(Object.keys(u.by_model).length > 0 || Object.keys(u.local.by_intent).length > 0) && (
        <section className="card">
          <p className="section-label">明細</p>
          <table className="cost-table">
            <thead><tr><th>項目</th><th>次數</th><th>Token（入 / 出）</th><th>費用</th></tr></thead>
            <tbody>
              {Object.entries(u.by_model).map(([model, b]) => <tr key={model}><td>{model}</td><td>{b.turns}</td><td>{num(b.input_tokens)} / {num(b.output_tokens)}</td><td>{usd(b.cost_usd)}</td></tr>)}
              {Object.entries(u.by_feature).map(([f, b]) => <tr key={f}><td>{FEATURE[f] ?? f}</td><td>{b.turns}</td><td>{num(b.input_tokens)} / {num(b.output_tokens)}</td><td>{usd(b.cost_usd)}</td></tr>)}
              {Object.entries(u.local.by_intent).map(([k, n]) => <tr key={k}><td>本地 · {INTENT[k] ?? k}</td><td>{n}</td><td>0 / 0</td><td>{usd(0)}</td></tr>)}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
