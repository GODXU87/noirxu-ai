import { describe, expect, it } from 'vitest';
import { buildResearchReport, expectedTradeDate, RULES, type NoirxuListRow } from '@/research/screen';

const at = (taipei: string) => new Date(`${taipei}+08:00`);
const row = (symbol: string, patch: Partial<NoirxuListRow> = {}): NoirxuListRow => ({
  market: 'TWSE', symbol, name: `股票${symbol}`, sector_name: '半導體', current_price: 100, entry_low: 98, entry_high: 101, stop_loss: 94, take_profit: 112,
  resistance_price: 115, risk_pct: 5, reward_risk: 2.2, stock_radar_score: 80, ma5: 101, ma10: 99, ma20: 96, ma60: 90, ma100: 85, bias_ma20_pct: 4,
  volume_ratio_20d: 1.6, institutional_positive_days_5d: 4, reason_text: '量價齊揚', ...patch
});
const pub = (trade_date: string) => ({ trade_date, published_at: `${trade_date}T12:30:00Z` });

describe('C3 research: data dates (Asia/Taipei)', () => {
  it('knows which trade date each report needs', () => {
    expect(expectedTradeDate('postmarket', at('2026-10-23T21:00:00'))).toBe('2026-10-23'); // Fri evening → Fri
    expect(expectedTradeDate('premarket', at('2026-10-26T07:00:00'))).toBe('2026-10-23');  // Mon morning → Fri
    expect(expectedTradeDate('postmarket', at('2026-10-24T21:00:00'))).toBe('2026-10-23'); // Sat → Fri
    expect(expectedTradeDate('premarket', at('2026-10-23T07:00:00'))).toBe('2026-10-22');  // Fri morning → Thu
    // 21:00 Taipei is 13:00 UTC on the same date
    expect(expectedTradeDate('postmarket', new Date('2026-10-23T13:00:00Z'))).toBe('2026-10-23');
  });

  it('refuses to produce candidates from yesterday\'s data', () => {
    const r = buildResearchReport({ kind: 'postmarket', now: at('2026-10-23T21:00:00'), publication: pub('2026-10-22'), noirxuList: [row('2330')], confluence: [], technical: [], heldSymbols: null });
    expect(r.data.status).toBe('stale');
    expect(r.candidates).toEqual([]);
    expect(r.summary).toContain('還不是 2026-10-23');
    expect(buildResearchReport({ kind: 'postmarket', now: at('2026-10-23T21:00:00'), publication: null, noirxuList: [], confluence: [], technical: [], heldSymbols: null }).data.status).toBe('missing');
  });
});

describe('C3 research: screening', () => {
  const input = (rows: NoirxuListRow[], held: string[] | null = []) => ({ kind: 'postmarket' as const, now: at('2026-10-23T21:30:00'), publication: pub('2026-10-23'), noirxuList: rows, confluence: [{ market: 'TWSE', symbol: '2330', confluence_count: 5, trading_theme_name: 'AI 伺服器' }], technical: [{ market: 'TWSE', symbol: '2330', signal_count: 4, rsi14: 62 }], heldSymbols: held });

  it('applies the hard filters and explains every exclusion', () => {
    const r = buildResearchReport(input([
      row('2330'), row('1111', { reward_risk: 1.1 }), row('2222', { risk_pct: 12 }), row('3333', { stock_radar_score: 40 }),
      row('4444', { stop_loss: null }), row('5555', { bias_ma20_pct: 18 })
    ]));
    expect(r.candidates.map(c => c.symbol)).toEqual(['2330']);
    expect(Object.fromEntries(r.excluded.map(e => [e.symbol, e.reason]))).toMatchObject({
      1111: expect.stringContaining('報酬風險比'), 2222: expect.stringContaining('風險幅度'), 3333: expect.stringContaining('RADAR 評分'),
      4444: expect.stringContaining('停損'), 5555: expect.stringContaining('乖離')
    });
  });

  it('every level and score comes from RADAR, with its trade date; news is marked as having no source', () => {
    const [c] = buildResearchReport(input([row('2330')])).candidates;
    expect(c.levels).toEqual({ current: 100, entry_low: 98, entry_high: 101, stop_loss: 94, take_profit: 112, resistance: 115 });
    expect(c.radar).toMatchObject({ score: 80, trade_date: '2026-10-23', reason: '量價齊揚' });
    expect(c.trend.join()).toContain('多頭排列');
    expect(c.news.status).toBe('no_source');
    expect(c.entry_conditions[0]).toContain('98～101');
    expect(c.invalidation[0]).toContain('94');
    expect(c.catalysts).toContain('題材：AI 伺服器');
  });

  it('lists missing data instead of filling it in', () => {
    const [c] = buildResearchReport(input([row('2330', { current_price: null, resistance_price: null, ma60: null })])).candidates;
    expect(c.missing).toEqual(expect.arrayContaining(['現價', '壓力價', 'MA60']));
    expect(c.levels.current).toBeNull();
  });

  it('caps at 5, skips positions already held in Journal, and says so', () => {
    const rows = ['2330', '2317', '2454', '2308', '3711', '2382', '6669'].map(s => row(s));
    const r = buildResearchReport(input(rows, ['2317']));
    expect(r.candidates).toHaveLength(RULES.maxCandidates);
    expect(r.candidates.map(c => c.symbol)).not.toContain('2317');
    expect(r.excluded).toContainEqual({ symbol: '2317', reason: 'Journal 已有未平倉部位，避免重複曝險' });
  });

  it('says plainly when nothing qualifies, and costs nothing', () => {
    const r = buildResearchReport(input([row('1111', { reward_risk: 1 })]));
    expect(r.candidates).toEqual([]);
    expect(r.summary).toBe('今日沒有符合條件的買進候選。');
    expect(r.cost).toEqual({ model_calls: 0, estimated_usd: 0 });
    expect(r.idempotency_key).toBe('research:postmarket:2026-10-23');
    expect(r.disclaimer).toContain('不會下單');
  });
});
