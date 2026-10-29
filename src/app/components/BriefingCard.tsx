'use client';

import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

// The morning / evening briefing as one card: a section per source, scannable at a glance,
// details one tap away. Sources that are off or unavailable are simply absent; a list that
// could not be read says so instead of looking empty.

interface Quote { symbol: string; label: string; date: string; close: number; change_pct: number | null }
interface Stock { symbol: string; name: string; note: string | null }
export interface BriefingCardData {
  kind: 'morning' | 'evening';
  date: string;
  title: string;
  weather: { place: string; summary: string; temp_max: number | null; temp_min: number | null; rain_chance: number | null; advice: string[] } | null;
  health: { narrative: string[]; signals: Array<{ key: string; tone: string; text: string }>; hydration_ml: number | null } | null;
  us: { quotes: Quote[]; missing: number } | null;
  radar: { trade_date: string; list: Stock[] | null; strong: Stock[] | null; sectors: string[] | null } | null;
  agenda: string[];
  finance: string[];
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function Section({ icon, label, meta, children }: { icon: IconName; label: string; meta?: string; children: ReactNode }) {
  return (
    <section className="brief-sec">
      <p className="brief-label"><Icon name={icon} size={15} />{label}{meta && <span>{meta}</span>}</p>
      {children}
    </section>
  );
}

function Stocks({ title, stocks }: { title: string; stocks: Stock[] | null }) {
  return (
    <div className="brief-line">
      <span className="brief-key">{title}</span>
      {stocks === null ? <span className="muted">暫時讀不到</span>
        : stocks.length ? <span className="brief-chips">{stocks.map(s => <span key={s.symbol} className="brief-chip"><b>{s.symbol}</b> {s.name}{s.note ? <em>{s.note}</em> : null}</span>)}</span>
        : <span className="muted">今天沒有符合條件的個股</span>}
    </div>
  );
}

export function BriefingCard({ data }: { data: BriefingCardData }) {
  const [more, setMore] = useState(false);
  const weekday = WEEKDAY[new Date(`${data.date}T12:00:00+08:00`).getUTCDay()];
  const h = data.health;
  const usDate = data.us?.quotes.map(q => q.date).sort().at(-1);
  return (
    <article className="brief">
      <header className="brief-head">
        <span className="brief-kicker">{data.kind === 'morning' ? '早報' : '晚報'} · {md(data.date)} 週{weekday}</span>
        <h3>{data.title}</h3>
      </header>

      {data.weather && (
        <Section icon="sun" label={data.kind === 'evening' ? '明天天氣' : '天氣'} meta={data.weather.place}>
          <div className="brief-weather">
            <b>{data.weather.temp_min !== null && data.weather.temp_max !== null ? `${Math.round(data.weather.temp_min)}–${Math.round(data.weather.temp_max)}°` : '—'}</b>
            <span>{data.weather.summary}{data.weather.rain_chance !== null ? ` · 降雨 ${Math.round(data.weather.rain_chance)}%` : ''}</span>
          </div>
          {data.weather.advice.length > 0 && <div className="brief-chips">{data.weather.advice.map(a => <span key={a} className="brief-chip">{a}</span>)}</div>}
        </Section>
      )}

      {h && (
        <Section icon="heart" label={data.kind === 'evening' ? '今天的身體' : '身體'} meta="Garmin">
          {h.signals.length > 0 && <div className="health-chips">{h.signals.map(s => <span key={s.key} className={`health-chip tone-${s.tone}`}>{s.text}</span>)}{h.hydration_ml ? <span className="health-chip">補水 {h.hydration_ml.toLocaleString('en-US')} ml</span> : null}</div>}
          <div className="brief-prose">
            {(more ? h.narrative : h.narrative.slice(0, 1)).map((p, i) => <p key={i}>{p}</p>)}
          </div>
          {h.narrative.length > 1 && <button type="button" className="brief-more" onClick={() => setMore(m => !m)}>{more ? '收合' : '看完整分析與今天的建議'}</button>}
        </Section>
      )}

      {data.us && (
        <Section icon="up" label="美股" meta={usDate ? `${md(usDate)} 收盤` : undefined}>
          <ul className="brief-quotes">
            {data.us.quotes.map(q => (
              <li key={q.symbol}><span>{q.label}</span><span className="brief-num">{q.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span><b className={q.change_pct === null ? 'muted' : q.change_pct >= 0 ? 'tone-up' : 'tone-down'}>{q.change_pct === null ? '—' : `${q.change_pct > 0 ? '+' : ''}${q.change_pct.toFixed(2)}%`}</b></li>
            ))}
          </ul>
          {data.us.missing > 0 && <p className="hint">另有 {data.us.missing} 檔暫時讀不到，稍後再看會補上。</p>}
        </Section>
      )}

      {data.radar && (
        <Section icon="chart" label="RADAR" meta={`${md(data.radar.trade_date)} 資料`}>
          <Stocks title="NOIRXU 清單" stocks={data.radar.list} />
          <Stocks title="強於大盤" stocks={data.radar.strong} />
          {data.radar.sectors !== null && <div className="brief-line"><span className="brief-key">資金流前三</span><span className="brief-chips">{data.radar.sectors.map(s => <span key={s} className="brief-chip">{s}</span>)}</span></div>}
        </Section>
      )}

      <Section icon="calendar" label={data.kind === 'morning' ? '待辦與財務' : '今天與明天'}>
        {data.agenda.length || data.finance.length ? (
          <ul className="brief-list">{[...data.agenda, ...data.finance].map(l => <li key={l}>{l}</li>)}</ul>
        ) : <p className="muted">今天和近三天沒有待辦。</p>}
      </Section>

      <p className="brief-foot">行情與 RADAR 僅供研究參考，不是投資建議、不會自動下單；健康指標不是醫療診斷。</p>
    </article>
  );
}
