import { ToolError } from '@/hub/errors';

// Last US session close from Stooq's public daily CSV (free, no account). Feature 'us_markets'
// (opt-in, switched on only after the live format and symbols have been checked). Prices only:
// research context for the morning briefing, never a trading signal, and never an order.

export interface UsQuote { symbol: string; label: string; date: string; close: number; change_pct: number | null }
export const US_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: '^spx', label: 'S&P 500' },
  { symbol: '^ndq', label: 'Nasdaq' },
  { symbol: '^dji', label: '道瓊' },
  { symbol: '^sox', label: '費半' },
  { symbol: 'tsm.us', label: '台積電 ADR' },
  { symbol: 'nvda.us', label: 'NVIDIA' }
];

/** Parses "Date,Open,High,Low,Close,Volume" rows; the last two give the close and the day's change. */
export function quoteFromCsv(csv: string, symbol: string, label: string): UsQuote {
  const lines = csv.trim().split(/\r?\n/);
  const header = (lines[0] ?? '').toLowerCase().split(',');
  const dateAt = header.indexOf('date');
  const closeAt = header.indexOf('close');
  if (dateAt < 0 || closeAt < 0) throw new ToolError('INVALID_OUTPUT', `美股資料格式不符（${symbol}），沒有使用。`);
  const rows = lines.slice(1).map(l => l.split(',')).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[dateAt] ?? '') && Number.isFinite(Number(r[closeAt])));
  const last = rows.at(-1);
  if (!last) throw new ToolError('NOT_FOUND', `沒有 ${label} 的收盤資料。`);
  const prev = rows.at(-2);
  const close = Number(last[closeAt]);
  const change = prev ? Math.round(((close - Number(prev[closeAt])) / Number(prev[closeAt])) * 10000) / 100 : null;
  return { symbol, label, date: last[dateAt], close, change_pct: change };
}

export async function fetchUsQuotes(fetcher: typeof fetch = fetch, symbols = US_SYMBOLS): Promise<{ quotes: UsQuote[]; errors: string[] }> {
  const results = await Promise.all(symbols.map(async ({ symbol, label }) => {
    try {
      const response = await fetcher(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new ToolError('UPSTREAM_UNAVAILABLE', `${label}：HTTP ${response.status}`);
      // Only the last few rows are needed; the full history can be long.
      const text = await response.text();
      const lines = text.trim().split(/\r?\n/);
      return quoteFromCsv([lines[0], ...lines.slice(-3)].join('\n'), symbol, label);
    } catch (error) {
      return error instanceof Error ? error.message : `${label}：讀取失敗`;
    }
  }));
  return { quotes: results.filter((r): r is UsQuote => typeof r !== 'string'), errors: results.filter((r): r is string => typeof r === 'string') };
}

export function usMarketLine(quotes: UsQuote[]) {
  if (!quotes.length) return null;
  const date = quotes.map(q => q.date).sort().at(-1)!;
  const pct = (q: UsQuote) => (q.change_pct === null ? '' : ` ${q.change_pct > 0 ? '+' : ''}${q.change_pct.toFixed(2)}%`);
  return `美股（${date.slice(5).replace('-', '/')} 收盤）：${quotes.map(q => `${q.label}${pct(q)}`).join('、')}`;
}
