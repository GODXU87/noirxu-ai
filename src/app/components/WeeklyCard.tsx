'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

// The weekly review card: this week against last week, one section per source, and SASUKE's
// cross-system observations at the top (only the ones the data supports).

export interface WeeklyCardData {
  kind: 'weekly';
  range: { from: string; to: string; prev_from: string; prev_to: string };
  training: Array<{ type: string; label: string; this_minutes: number; last_minutes: number; this_count: number; change_pct: number | null; km: number }> | null;
  sleep: { this_avg_s: number; last_avg_s: number | null; nights: number; short_nights: number } | null;
  spending: { currency: string; this_total: number; last_total: number; change_pct: number | null; top: Array<{ name: string; amount: number }> } | null;
  trading: Array<{ currency: string; closed: number; win_rate: number | null; net_pnl: number; last_net_pnl: number | null }> | null;
  tasks: { done: number; open_overdue: number } | null;
  insights: string[];
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
const n = (v: number) => Math.round(v).toLocaleString('en-US');

function Change({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <b className="muted">—</b>;
  const good = invert ? value <= 0 : value >= 0;
  return <b className={good ? 'tone-up' : 'tone-down'}>{value > 0 ? '+' : ''}{value}%</b>;
}

function Section({ icon, label, meta, children }: { icon: IconName; label: string; meta?: string; children: ReactNode }) {
  return (
    <section className="brief-sec">
      <p className="brief-label"><Icon name={icon} size={15} />{label}{meta && <span>{meta}</span>}</p>
      {children}
    </section>
  );
}

export function WeeklyCard({ data }: { data: WeeklyCardData }) {
  const sleepDiff = data.sleep?.last_avg_s ? Math.round((data.sleep.this_avg_s - data.sleep.last_avg_s) / 60) : null;
  const totalThis = data.training?.reduce((a, t) => a + t.this_minutes, 0) ?? 0;
  const totalLast = data.training?.reduce((a, t) => a + t.last_minutes, 0) ?? 0;
  return (
    <article className="brief">
      <header className="brief-head">
        <span className="brief-kicker">本週回顧 · {md(data.range.from)}–{md(data.range.to)}（對照 {md(data.range.prev_from)}–{md(data.range.prev_to)}）</span>
        <h3>Sir，這一週</h3>
      </header>

      {data.insights.length > 0 && (
        <Section icon="report" label="SASUKE 的觀察">
          <ul className="brief-list">{data.insights.map(i => <li key={i}>{i}</li>)}</ul>
        </Section>
      )}

      {data.training && (
        <Section icon="heart" label="訓練" meta={`${n(totalLast)} → ${n(totalThis)} 分`}>
          {data.training.length ? (
            <ul className="brief-quotes">
              {data.training.map(t => <li key={t.type}><span>{t.label} · {t.this_count} 次{t.km ? ` · ${t.km} km` : ''}</span><span className="brief-num">{t.last_minutes} → {t.this_minutes} 分</span><Change value={t.change_pct} /></li>)}
            </ul>
          ) : <p className="muted">最近兩週沒有運動紀錄。</p>}
        </Section>
      )}

      {data.sleep && (
        <Section icon="sun" label="睡眠" meta={`${data.sleep.nights} 晚`}>
          <div className="brief-weather">
            <b>{hm(data.sleep.this_avg_s)}</b>
            <span>平均{sleepDiff !== null ? `，比上週${sleepDiff >= 0 ? `多 ${sleepDiff}` : `少 ${-sleepDiff}`} 分` : ''}{data.sleep.short_nights ? ` · ${data.sleep.short_nights} 晚不到 6.5 小時` : ''}</span>
          </div>
        </Section>
      )}

      {data.spending && (
        <Section icon="wallet" label="支出" meta={data.spending.currency}>
          <ul className="brief-quotes">
            <li><span>本週</span><span className="brief-num">上週 {n(data.spending.last_total)}</span><b>{n(data.spending.this_total)}</b></li>
            <li><span>變化</span><span /><Change value={data.spending.change_pct} invert /></li>
          </ul>
          {data.spending.top.length > 0 && <div className="brief-chips">{data.spending.top.map(c => <span key={c.name} className="brief-chip">{c.name} <b>{n(c.amount)}</b></span>)}</div>}
        </Section>
      )}

      {data.trading && (
        <Section icon="chart" label="交易" meta="Journal">
          {data.trading.length ? (
            <ul className="brief-quotes">
              {data.trading.map(t => <li key={t.currency}><span>{t.currency} · 平倉 {t.closed} 筆{t.win_rate !== null ? ` · 勝率 ${t.win_rate}%` : ''}</span><span className="brief-num">{t.last_net_pnl !== null ? `上週 ${n(t.last_net_pnl)}` : ''}</span><b className={t.net_pnl >= 0 ? 'tone-up' : 'tone-down'}>{t.net_pnl >= 0 ? '+' : ''}{n(t.net_pnl)}</b></li>)}
            </ul>
          ) : <p className="muted">這週沒有平倉的交易。</p>}
        </Section>
      )}

      {data.tasks && (
        <Section icon="check" label="事項">
          <p className="brief-prose">完成 {data.tasks.done} 件{data.tasks.open_overdue ? `，還有 ${data.tasks.open_overdue} 件逾期` : '，沒有逾期的事'}。</p>
        </Section>
      )}

      <p className="brief-foot">交易數字依幣別分開計算，不是投資建議；健康數據來自 Garmin，不是醫療診斷。</p>
    </article>
  );
}
