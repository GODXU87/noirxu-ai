import { describe, expect, it, vi } from 'vitest';
import { radarSection } from '@/briefing/sections';
import { quoteFromCsv, usMarketLine } from '@/markets/us';
import { classify } from '@/router/intents';
import { DEFAULT_PLACE, weatherFromResponse, weatherLine } from '@/weather/open-meteo';

describe('weather (Open-Meteo daily format)', () => {
  it('summarises today and gives practical advice', () => {
    const w = weatherFromResponse({ daily: { time: ['2026-10-30'], weather_code: [61], temperature_2m_max: [27.4], temperature_2m_min: [21.2], precipitation_probability_max: [70], precipitation_sum: [6.2], uv_index_max: [5.1] } }, DEFAULT_PLACE);
    expect(weatherLine(w)).toBe('林口雨 21–27°C，降雨機率 70%，出門帶傘');
    expect(() => weatherFromResponse({ error: true }, DEFAULT_PLACE)).toThrow('格式不符');
  });
});

describe('US close (daily CSV)', () => {
  it('reads the last close and the day change, and labels the data date', () => {
    const csv = 'Date,Open,High,Low,Close,Volume\n2026-10-27,5800,5850,5790,5820.5,1\n2026-10-28,5825,5880,5810,5870.1,1';
    const q = quoteFromCsv(csv, '^spx', 'S&P 500');
    expect(q).toEqual({ symbol: '^spx', label: 'S&P 500', date: '2026-10-28', close: 5870.1, change_pct: 0.85 });
    expect(usMarketLine([q, { ...q, label: '費半', change_pct: -1.2 }])).toBe('美股（10/28 收盤）：S&P 500 +0.85%、費半 -1.20%');
    expect(() => quoteFromCsv('<html>blocked</html>', '^spx', 'S&P 500')).toThrow('格式不符');
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
    expect(r).toEqual({
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
