import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';

// Last US session close from Alpha Vantage (GLOBAL_QUOTE; the user's own free key in
// ALPHAVANTAGE_API_KEY, never in the app or the chat). Feature 'us_markets'. The free plan
// allows 25 requests a day and about one a second: five symbols, read one per ~1.1 s, each kept
// for the Taipei day (sealed) so it is never asked for twice.
// Index levels are not on the free plan: the ETFs that track them are used and labelled as
// such. Prices only — research context, never a trading signal, never an order.

export interface UsQuote { symbol: string; label: string; date: string; close: number; change_pct: number | null }
export const US_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: 'SPY', label: 'S&P 500（SPY）' },
  { symbol: 'QQQ', label: 'Nasdaq 100（QQQ）' },
  { symbol: 'SOXX', label: '半導體（SOXX）' },
  { symbol: 'TSM', label: '台積電 ADR' },
  { symbol: 'NVDA', label: 'NVIDIA' }
];

/** Parses an Alpha Vantage GLOBAL_QUOTE response. Rate-limit and error notes are reported, not parsed. */
export function quoteFromAlphaVantage(body: unknown, symbol: string, label: string): UsQuote {
  const b = (body ?? {}) as Record<string, unknown>;
  const note = b.Note ?? b.Information ?? b['Error Message'];
  if (typeof note === 'string') throw new ToolError('UPSTREAM_UNAVAILABLE', /per second|sparingly|burst/i.test(note) ? `Alpha Vantage 查詢太快（${label}）` : /frequency|limit|premium|per day/i.test(note) ? `Alpha Vantage 今日額度已滿（${label}）` : `Alpha Vantage 拒絕查詢 ${label}`);
  const q = b['Global Quote'] as Record<string, string> | undefined;
  const close = Number(q?.['05. price']);
  const date = q?.['07. latest trading day'];
  if (!q || !Number.isFinite(close) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError('INVALID_OUTPUT', `美股資料格式不符（${label}），沒有使用。`);
  const pct = Number(String(q['10. change percent'] ?? '').replace('%', ''));
  return { symbol, label, date, close, change_pct: Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null };
}

export interface UsQuoteDeps { apiKey: string | undefined; store?: AgendaStore; vault?: TokenVault; now?: Date; fetcher?: typeof fetch }

const cacheKey = (now: Date) => `markets:us:${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now)}`;

export async function fetchUsQuotes(deps: UsQuoteDeps & { pauseMs?: number }, symbols = US_SYMBOLS): Promise<{ quotes: UsQuote[]; errors: string[] }> {
  if (!deps.apiKey) return { quotes: [], errors: ['ALPHAVANTAGE_API_KEY 尚未設定'] };
  const now = deps.now ?? new Date();
  const key = cacheKey(now);
  // Quotes already read today are kept (sealed) one by one, so a retry only asks for the missing
  // ones and the 25-a-day free quota is never spent twice on the same symbol.
  const cached: UsQuote[] = deps.store && deps.vault ? await deps.store.getSetting(key).then(s => (s ? JSON.parse(deps.vault!.open(s, key)) as UsQuote[] : [])) : [];
  const missing = symbols.filter(s => !cached.some(c => c.symbol === s.symbol));
  const fetcher = deps.fetcher ?? fetch;
  const fresh: UsQuote[] = [];
  const errors: string[] = [];
  const pause = deps.pauseMs ?? 1100;
  for (const [i, { symbol, label }] of missing.entries()) {
    // The free plan allows about one request per second.
    if (i > 0 && pause > 0) await new Promise(r => setTimeout(r, pause));
    try {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(deps.apiKey)}`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new ToolError('UPSTREAM_UNAVAILABLE', `${label}：HTTP ${response.status}`);
      fresh.push(quoteFromAlphaVantage(await response.json().catch(() => null), symbol, label));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${label}：讀取失敗`);
    }
  }
  const all = [...cached, ...fresh];
  if (deps.store && deps.vault && fresh.length) await deps.store.putSetting(key, deps.vault.seal(JSON.stringify(all), key));
  return { quotes: symbols.map(s => all.find(q => q.symbol === s.symbol)).filter((q): q is UsQuote => Boolean(q)), errors };
}

export function usMarketLine(quotes: UsQuote[]) {
  if (!quotes.length) return null;
  const date = quotes.map(q => q.date).sort().at(-1)!;
  const pct = (q: UsQuote) => (q.change_pct === null ? '' : ` ${q.change_pct > 0 ? '+' : ''}${q.change_pct.toFixed(2)}%`);
  return `美股（${date.slice(5).replace('-', '/')} 收盤）：${quotes.map(q => `${q.label}${pct(q)}`).join('、')}`;
}
