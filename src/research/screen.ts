// SASUKE Market Intelligence — research prototype (Phase C3).
//
// Pipeline: trigger → research job → (saved report, after C3 storage is approved) → notify.
// This module is the research job's core. It is deterministic and uses only RADAR's
// read-only integration API plus Journal open positions. No AI model, no paid API.
//
// It never invents numbers: every price, level and score is a RADAR field from the
// published snapshot, labelled with RADAR's trade date. Missing fields are listed as
// missing. News and announcements have no source yet, so they are reported as such.
// It produces research candidates and conditions, not orders or buy advice.

export type ReportKind = 'premarket' | 'postmarket';

/** Columns of RADAR scan "noirxu_list" (radar_get_noirxu_buy_list_v0232). */
export interface NoirxuListRow {
  buy_rank?: number | null; recommendation_status?: string | null; market_state?: string | null; setup_label?: string | null;
  market: string; symbol: string; name?: string | null; sector_name?: string | null;
  current_price?: number | null; entry_low?: number | null; entry_high?: number | null; stop_loss?: number | null; take_profit?: number | null;
  resistance_price?: number | null; risk_pct?: number | null; reward_risk?: number | null; stock_radar_score?: number | null;
  relative_strength_5d?: number | null; relative_strength_20d?: number | null;
  ma5?: number | null; ma10?: number | null; ma20?: number | null; ma60?: number | null; ma100?: number | null;
  bias_ma20_pct?: number | null; volume_ratio_20d?: number | null; institutional_positive_days_5d?: number | null; reason_text?: string | null;
}
/** Columns used from scan "confluence" (radar_get_confluence_radar_v0217). */
export interface ConfluenceRow { market: string; symbol: string; confluence_count?: number | null; confluence_state?: string | null; trading_theme_name?: string | null; supply_chain_name?: string | null }
/** Columns used from scan "technical" (radar_get_technical_radar_v0215). */
export interface TechnicalRow { market: string; symbol: string; signal_count?: number | null; technical_state?: string | null; rsi14?: number | null; trend_stack?: string | null; breakout_20d?: boolean | null; breakout_60d?: boolean | null }

export interface ResearchInput {
  kind: ReportKind;
  now: Date;
  publication: { trade_date: string; published_at: string } | null;
  noirxuList: NoirxuListRow[];
  confluence: ConfluenceRow[];
  technical: TechnicalRow[];
  /** Symbols already held in Journal (open positions), when Journal is connected. */
  heldSymbols: string[] | null;
}

/**
 * Screening rules, fixed and versioned. The score only orders candidates that already
 * passed the hard filters; it has NOT been validated against history and does not
 * represent a probability of profit.
 */
export const RULES = {
  version: 'c3-proto-1',
  hardFilters: {
    needsPlan: 'entry_low、entry_high、stop_loss 都有值',
    minRewardRisk: 1.5,
    maxRiskPct: 8,
    minRadarScore: 60,
    maxBiasMa20Pct: 12
  },
  weights: { radarScore: 0.35, rewardRisk: 0.2, confluence: 0.15, technical: 0.15, institutional: 0.15 },
  maxCandidates: 5
} as const;

export interface Candidate {
  rank: number;
  market: string; symbol: string; name: string | null; sector: string | null;
  research_score: number;
  radar: { score: number | null; trade_date: string; reason: string | null; setup: string | null };
  trend: string[];
  levels: { current: number | null; entry_low: number; entry_high: number; stop_loss: number; take_profit: number | null; resistance: number | null };
  indicators: Record<string, number | null>;
  catalysts: string[];
  news: { status: 'no_source'; note: string };
  entry_conditions: string[];
  invalidation: string[];
  risks: string[];
  missing: string[];
  held: boolean;
  conclusion: string;
}

export interface ResearchReport {
  kind: ReportKind;
  idempotency_key: string;
  generated_at: string;
  data: { trade_date: string | null; published_at: string | null; expected_trade_date: string; status: 'fresh' | 'stale' | 'missing' };
  rules_version: string;
  candidates: Candidate[];
  excluded: Array<{ symbol: string; reason: string }>;
  summary: string;
  sources: string[];
  cost: { model_calls: number; estimated_usd: number };
  disclaimer: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
function taipeiParts(now: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now);
  const get = (t: string) => f.find(p => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, weekday: get('weekday') };
}
function shift(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function weekdayOf(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function previousWeekday(date: string) {
  let d = shift(date, -1);
  while ([0, 6].includes(weekdayOf(d))) d = shift(d, -1);
  return d;
}

/**
 * The trade date a report should be based on. Exchange holidays are not known here, so a
 * weekday holiday shows up as "stale"; the report then says the data is not today's
 * rather than pretending.
 */
export function expectedTradeDate(kind: ReportKind, now: Date) {
  const { date } = taipeiParts(now);
  const isWeekday = ![0, 6].includes(weekdayOf(date));
  if (kind === 'postmarket' && isWeekday) return date;
  return previousWeekday(kind === 'postmarket' ? shift(date, 1) : date);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const f2 = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

function trendNotes(r: NoirxuListRow, t: TechnicalRow | undefined): string[] {
  const out: string[] = [];
  const [ma5, ma10, ma20, ma60] = [num(r.ma5), num(r.ma10), num(r.ma20), num(r.ma60)];
  if (ma5 !== null && ma10 !== null && ma20 !== null && ma60 !== null) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) out.push('均線多頭排列（MA5 > MA10 > MA20 > MA60）');
    else if (ma5 < ma10 && ma10 < ma20) out.push('短均線在中期均線之下，趨勢偏弱');
    else out.push('均線糾結，方向未明');
  }
  const vr = num(r.volume_ratio_20d);
  if (vr !== null) out.push(vr >= 1.5 ? `量能放大（20 日量比 ${f2(vr)}）` : vr < 0.8 ? `量能偏縮（20 日量比 ${f2(vr)}）` : `量能持平（20 日量比 ${f2(vr)}）`);
  if (t?.trend_stack) out.push(`RADAR 趨勢判讀：${t.trend_stack}`);
  if (t?.breakout_60d) out.push('突破 60 日區間'); else if (t?.breakout_20d) out.push('突破 20 日區間');
  return out;
}

/** Runs the screen and builds the report. Pure: all inputs are passed in. */
export function buildResearchReport(input: ResearchInput): ResearchReport {
  const expected = expectedTradeDate(input.kind, input.now);
  const pub = input.publication;
  const status: ResearchReport['data']['status'] = !pub ? 'missing' : pub.trade_date < expected ? 'stale' : 'fresh';
  const base = {
    kind: input.kind,
    idempotency_key: `research:${input.kind}:${expected}`,
    generated_at: input.now.toISOString(),
    data: { trade_date: pub?.trade_date ?? null, published_at: pub?.published_at ?? null, expected_trade_date: expected, status },
    rules_version: RULES.version,
    sources: ['NOIRXU RADAR 唯讀 API（noirxu_list、confluence、technical）', ...(input.heldSymbols ? ['NOIRXU Trading Journal 未平倉部位'] : [])],
    cost: { model_calls: 0, estimated_usd: 0 },
    disclaimer: '研究與決策輔助，不是投資建議，也不保證獲利；本系統不會下單。'
  };

  // Never produce candidates from data that is not the expected trading day.
  if (status !== 'fresh') {
    return {
      ...base, candidates: [], excluded: [],
      summary: status === 'missing'
        ? 'RADAR 目前沒有可用的發布資料，這次不產生候選名單。'
        : `RADAR 最新資料是 ${pub!.trade_date}，還不是 ${expected} 的資料（可能尚未更新或當天休市）。這次不產生候選名單，避免用舊資料當成最新行情。`
    };
  }

  const conf = new Map(input.confluence.map(c => [`${c.market}:${c.symbol}`, c]));
  const tech = new Map(input.technical.map(t => [`${t.market}:${t.symbol}`, t]));
  const held = new Set((input.heldSymbols ?? []).map(s => s.toUpperCase()));
  const excluded: ResearchReport['excluded'] = [];
  const scored: Array<{ row: NoirxuListRow; score: number }> = [];
  const H = RULES.hardFilters;

  for (const row of input.noirxuList) {
    const [lo, hi, stop, rr, risk, score, bias] = [num(row.entry_low), num(row.entry_high), num(row.stop_loss), num(row.reward_risk), num(row.risk_pct), num(row.stock_radar_score), num(row.bias_ma20_pct)];
    const reason =
      lo === null || hi === null || stop === null ? '缺少進場區間或停損價'
      : rr === null || rr < H.minRewardRisk ? `報酬風險比 ${f2(rr)} 低於 ${H.minRewardRisk}`
      : risk === null || risk > H.maxRiskPct ? `風險幅度 ${f2(risk)}% 高於 ${H.maxRiskPct}%`
      : score === null || score < H.minRadarScore ? `RADAR 評分 ${f2(score)} 低於 ${H.minRadarScore}`
      : bias !== null && bias > H.maxBiasMa20Pct ? `距 MA20 乖離 ${f2(bias)}% 過大（追高風險）`
      : null;
    if (reason) { excluded.push({ symbol: row.symbol, reason }); continue; }
    const c = conf.get(`${row.market}:${row.symbol}`);
    const t = tech.get(`${row.market}:${row.symbol}`);
    const W = RULES.weights;
    const research = 100 * (
      W.radarScore * Math.min(1, score! / 100)
      + W.rewardRisk * Math.min(1, rr! / 3)
      + W.confluence * Math.min(1, (num(c?.confluence_count) ?? 0) / 6)
      + W.technical * Math.min(1, (num(t?.signal_count) ?? 0) / 5)
      + W.institutional * Math.min(1, (num(row.institutional_positive_days_5d) ?? 0) / 5));
    scored.push({ row, score: Math.round(research * 10) / 10 });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates: Candidate[] = [];
  for (const { row, score } of scored) {
    if (candidates.length >= RULES.maxCandidates) break;
    const isHeld = held.has(row.symbol.toUpperCase());
    if (isHeld) { excluded.push({ symbol: row.symbol, reason: 'Journal 已有未平倉部位，避免重複曝險' }); continue; }
    const c = conf.get(`${row.market}:${row.symbol}`);
    const t = tech.get(`${row.market}:${row.symbol}`);
    const lo = num(row.entry_low)!; const hi = num(row.entry_high)!; const stop = num(row.stop_loss)!;
    const resistance = num(row.resistance_price); const current = num(row.current_price);
    const missing = [
      current === null ? '現價' : '', resistance === null ? '壓力價' : '', num(row.take_profit) === null ? '目標價' : '',
      num(row.ma60) === null ? 'MA60' : '', !c ? '多訊號共振資料' : '', !t ? '技術掃描資料' : ''
    ].filter(Boolean);
    const risks = [`停損幅度約 ${f2(num(row.risk_pct))}%`];
    if (resistance !== null && current !== null && resistance > current && (resistance - current) / current < 0.03) risks.push(`距壓力 ${f2(resistance)} 不到 3%，上方空間有限`);
    if ((num(t?.rsi14) ?? 0) >= 75) risks.push(`RSI14 ${f2(num(t?.rsi14))} 偏高，短線過熱`);
    if (num(row.bias_ma20_pct) !== null && num(row.bias_ma20_pct)! > 8) risks.push(`距 MA20 乖離 ${f2(num(row.bias_ma20_pct))}%`);
    risks.push('隔日開盤跳空可能直接穿越進場區間或停損');

    candidates.push({
      rank: candidates.length + 1,
      market: row.market, symbol: row.symbol, name: row.name ?? null, sector: row.sector_name ?? null,
      research_score: score,
      radar: { score: num(row.stock_radar_score), trade_date: pub!.trade_date, reason: row.reason_text ?? null, setup: row.setup_label ?? null },
      trend: trendNotes(row, t),
      levels: { current, entry_low: lo, entry_high: hi, stop_loss: stop, take_profit: num(row.take_profit), resistance },
      indicators: { ma5: num(row.ma5), ma10: num(row.ma10), ma20: num(row.ma20), ma60: num(row.ma60), ma100: num(row.ma100), bias_ma20_pct: num(row.bias_ma20_pct), volume_ratio_20d: num(row.volume_ratio_20d), relative_strength_5d: num(row.relative_strength_5d), relative_strength_20d: num(row.relative_strength_20d), rsi14: num(t?.rsi14), institutional_positive_days_5d: num(row.institutional_positive_days_5d) },
      catalysts: [c?.trading_theme_name ? `題材：${c.trading_theme_name}` : '', c?.supply_chain_name ? `供應鏈：${c.supply_chain_name}` : '', c?.confluence_state ? `共振狀態：${c.confluence_state}` : ''].filter(Boolean),
      news: { status: 'no_source', note: '尚未整合新聞與公告來源，沒有查證重大訊息；進場前請自行確認公開資訊觀測站。' },
      entry_conditions: [`價格回到 RADAR 進場區間 ${f2(lo)}～${f2(hi)}（${pub!.trade_date} 資料）`, '進場當天量能不低於 20 日均量', '大盤沒有出現 RADAR 風險警示'],
      invalidation: [`收盤跌破停損 ${f2(stop)}`, '量縮跌破 MA20', 'RADAR 下一交易日將此股移出清單'],
      risks,
      missing,
      held: false,
      conclusion: `研究候選（第 ${candidates.length + 1} 名，研究分數 ${score}）：符合 ${RULES.version} 的篩選條件，只在條件成立時才考慮，非買進建議。`
    });
  }

  const summary = candidates.length
    ? `${pub!.trade_date} 資料共 ${input.noirxuList.length} 檔進入 RADAR 清單，${candidates.length} 檔通過篩選列為研究候選。`
    : '今日沒有符合條件的買進候選。';
  return { ...base, candidates, excluded, summary };
}
