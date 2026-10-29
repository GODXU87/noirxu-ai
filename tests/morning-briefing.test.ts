import { describe, expect, it, vi } from 'vitest';
import { radarSection } from '@/briefing/sections';
import { fetchUsQuotes, quoteFromAlphaVantage, usMarketLine } from '@/markets/us';
import { classify } from '@/router/intents';
import { DEFAULT_PLACE, weatherFromResponse, weatherLine } from '@/weather/open-meteo';

describe('weather (Open-Meteo daily format)', () => {
  it('summarises today and gives practical advice', () => {
    const w = weatherFromResponse({ daily: { time: ['2026-10-30'], weather_code: [61], temperature_2m_max: [27.4], temperature_2m_min: [21.2], precipitation_probability_max: [70], precipitation_sum: [6.2], uv_index_max: [5.1] } }, DEFAULT_PLACE);
    expect(weatherLine(w)).toBe('林口雨 21–27°C，降雨機率 70%，出門帶傘');
    expect(() => weatherFromResponse({ error: true }, DEFAULT_PLACE)).toThrow('格式不符');
  });
});

describe('US close (Alpha Vantage GLOBAL_QUOTE)', () => {
  const quote = (symbol: string, price: string, pct: string) => ({ 'Global Quote': { '01. symbol': symbol, '05. price': price, '07. latest trading day': '2026-10-28', '08. previous close': '0', '10. change percent': pct } });
  it('reads the close and change, labels the data date, and caches a complete day', async () => {
    const { MemoryAgendaStore } = await import('@/agenda/store');
    const { vault } = await import('./helpers/chat-hub');
    const store = new MemoryAgendaStore();
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); const s = new URL(url).searchParams.get('symbol')!; return new Response(JSON.stringify(quote(s, '100.5', s === 'SOXX' ? '-1.2034%' : '0.8521%'))); }) as unknown as typeof fetch;
    const now = new Date('2026-10-29T00:00:00Z');
    const first = await fetchUsQuotes({ apiKey: 'demo-key', store, vault, now, fetcher, pauseMs: 0 });
    expect(first.errors).toEqual([]);
    expect(first.quotes[0]).toEqual({ symbol: 'SPY', label: 'S&P 500（SPY）', date: '2026-10-28', close: 100.5, change_pct: 0.85 });
    expect(usMarketLine(first.quotes)).toBe('美股（10/28 收盤）：S&P 500（SPY） +0.85%、Nasdaq 100（QQQ） +0.85%、半導體（SOXX） -1.20%、台積電 ADR +0.85%、NVIDIA +0.85%');
    await fetchUsQuotes({ apiKey: 'demo-key', store, vault, now, fetcher, pauseMs: 0 });
    expect(urls).toHaveLength(5); // second call served from the day's cache
    expect(store.settings.get('markets:us:2026-10-29')).not.toContain('SPY');
  });

  it('reports rate limits and a missing key plainly, and never caches a partial day', async () => {
    const limited = (async () => new Response(JSON.stringify({ Information: 'We have detected your API key and our standard API rate limit is 25 requests per day.' }))) as unknown as typeof fetch;
    const r = await fetchUsQuotes({ apiKey: 'k', fetcher: limited, pauseMs: 0 });
    expect(r.quotes).toEqual([]);
    expect(r.errors[0]).toContain('今日額度已滿');
    expect(await fetchUsQuotes({ apiKey: undefined })).toEqual({ quotes: [], errors: ['ALPHAVANTAGE_API_KEY 尚未設定'] });
    expect(() => quoteFromAlphaVantage({ 'Global Quote': {} }, 'SPY', 'S&P 500')).toThrow('格式不符');
  });

  it('keeps what succeeded and only asks for the missing symbols on the next try', async () => {
    const { MemoryAgendaStore } = await import('@/agenda/store');
    const { vault } = await import('./helpers/chat-hub');
    const store = new MemoryAgendaStore();
    const now = new Date('2026-10-29T00:00:00Z');
    let calls = 0;
    // First round: only the first request succeeds (burst limit), the rest are refused.
    const burst = (async (url: string) => { calls += 1; const s = new URL(url).searchParams.get('symbol')!; return new Response(JSON.stringify(calls === 1 ? quote(s, '772.31', '0.34%') : { Information: 'Please consider spreading out your free API requests more sparingly (1 request per second).' })); }) as unknown as typeof fetch;
    const first = await fetchUsQuotes({ apiKey: 'k', store, vault, now, fetcher: burst, pauseMs: 0 });
    expect(first.quotes.map(q => q.symbol)).toEqual(['SPY']);
    expect(first.errors[0]).toContain('查詢太快');
    const asked: string[] = [];
    const ok = (async (url: string) => { const s = new URL(url).searchParams.get('symbol')!; asked.push(s); return new Response(JSON.stringify(quote(s, '100', '1%'))); }) as unknown as typeof fetch;
    const second = await fetchUsQuotes({ apiKey: 'k', store, vault, now, fetcher: ok, pauseMs: 0 });
    expect(asked).toEqual(['QQQ', 'SOXX', 'TSM', 'NVDA']);
    expect(second.quotes.map(q => q.symbol)).toEqual(['SPY', 'QQQ', 'SOXX', 'TSM', 'NVDA']);
  });
});

describe('RADAR section (integration API row fields)', () => {
  it('lists the NOIRXU list, stronger-than-market stocks and top money-flow sectors with the data date', async () => {
    const publication = { trade_date: '2026-10-29', published_at: null };
    const invoke = vi.fn(async (name: string, input: any) => {
      if (name === 'radar.sectors.analyze') return { status: 'ok', tool: name, data: { publication, data: { sectors: [{ name: '電子零組件', rank: 2, flow_score: 70 }, { name: '半導體', rank: 1, flow_score: 82 }, { name: '航運', rank: 3 }] } }, links: [] };
      const rows = input.kind === 'noirxu_list' ? [{ symbol: '2330', name: '台積電', setup_label: '多頭回測' }] : [{ symbol: '2454', name: '聯發科' }, { symbol: '3017', name: '奇鋐' }];
      return { status: 'ok', tool: name, data: { publication, data: { kind: input.kind, rows } }, links: [] };
    });
    const r = await radarSection(invoke as any, { userId: 'owner', now: () => new Date() });
    expect(r).toMatchObject({
      list: [{ symbol: '2330', name: '台積電', note: '多頭回測' }],
      strong: [{ symbol: '2454', name: '聯發科', note: null }, { symbol: '3017', name: '奇鋐', note: null }],
      sectors: ['半導體', '電子零組件', '航運'],
      trade_date: '2026-10-29',
      line: 'RADAR（10/29 資料）：NOIRXU 清單 2330 台積電（多頭回測）',
      detail: ['NOIRXU 清單：2330 台積電（多頭回測）', '強於大盤：2454 聯發科、3017 奇鋐', '資金流前三產業：半導體、電子零組件、航運']
    });
  });

  it('is left out when RADAR is unavailable', async () => {
    const invoke = vi.fn(async (name: string) => ({ status: 'error', tool: name, code: 'UPSTREAM_UNAVAILABLE', message: 'x' }));
    expect(await radarSection(invoke as any, { userId: 'owner', now: () => new Date() })).toBeNull();
  });

  it('"早報" and "晚報" open the full briefing locally', () => {
    expect(classify('早報')).toEqual({ kind: 'briefing', which: 'morning' });
    expect(classify('給我晚報')).toEqual({ kind: 'briefing', which: 'evening' });
  });
});
