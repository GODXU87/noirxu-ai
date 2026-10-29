import { describe, expect, it, vi } from 'vitest';
import type { GarminActivity, GarminAdapter } from '@/garmin/adapter';
import { classify } from '@/router/intents';
import { runLocal } from '@/router/local';
import { garminTools } from '@/tools/garmin/tools';
import { chatHub, ctxAt, fakeOpenAI } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');
const NOW = '2026-10-29T01:00:00Z'; // Thursday 09:00 Taipei

const night = (date: string, h: number) => ({ date, duration_s: Math.round(h * 3600), deep_s: null, light_s: null, rem_s: null, awake_s: null, awake_count: null, quality: null, result: null, start_local: null, end_local: null, avg_hr: null, avg_sleep_stress: null, tonight_bedtime: null });
const act = (date: string, type: string, min: number, km = 0): GarminActivity => ({ id: `${date}${type}`, name: type, type, start_local: `${date}T19:00:00`, duration_s: min * 60, distance_m: km * 1000, calories: null, avg_hr: null, max_hr: null, aerobic_te: null, anaerobic_te: null, training_load: null, elevation_gain_m: null });
const garmin: GarminAdapter = {
  configured: true,
  sleepRange: async () => [
    ...['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map(d => night(d, 7.5)),
    night('2026-10-23', 7), night('2026-10-24', 6), night('2026-10-25', 6.2), night('2026-10-26', 7.4), night('2026-10-27', 6.1), night('2026-10-28', 7), night('2026-10-29', 7.2)
  ],
  activities: async () => [act('2026-10-18', 'running', 40, 7), act('2026-10-20', 'badminton', 90), act('2026-10-24', 'running', 50, 9), act('2026-10-26', 'badminton', 120), act('2026-10-28', 'strength_training', 60)],
  sleep: async () => { throw new Error('not used'); },
  recovery: async () => { throw new Error('not used'); },
  daily: async () => { throw new Error('not used'); },
  activity: async () => { throw new Error('not used'); }
};

function setup() {
  const { hub } = chatHub();
  garminTools(garmin).forEach(t => hub.registry.register(t));
  hub.garmin = garmin;
  const ctx = ctxAt(NOW);
  const deps = { executor: hub.executor, ctx, memory: null, isConnected: async () => false };
  return { hub, ctx, deps };
}

describe('more questions answered without AI', () => {
  it('recognises weather, US stocks, training, sleep trend and capability questions — and leaves real requests to the model', () => {
    expect(classify('今天天氣如何？')).toEqual({ kind: 'weather', day: 0 });
    expect(classify('明天會下雨嗎')).toEqual({ kind: 'weather', day: 1 });
    expect(classify('要帶傘嗎')).toEqual({ kind: 'weather', day: 0 });
    expect(classify('昨晚美股收盤')).toEqual({ kind: 'markets_us' });
    expect(classify('你會做什麼')).toEqual({ kind: 'capabilities' });
    expect(classify('今天怎麼練')).toEqual({ kind: 'garmin', which: 'status' });
    expect(classify('這週訓練量和上週比較')).toEqual({ kind: 'garmin', which: 'compare' });
    expect(classify('這週跑步量比上週增加多少')).toEqual({ kind: 'garmin', which: 'compare' });
    expect(classify('最近 7 晚的睡眠趨勢')).toEqual({ kind: 'garmin', which: 'sleep_trend' });
    expect(classify('最近有什麼事')?.kind).toBe('agenda');
    expect(classify('這個月花了多少錢')?.kind).toBe('ledger_month');
    for (const t of ['天氣很熱我不想動', '美股要不要買', '幫我想一下這週的訓練怎麼排比較好', '比較台積電和聯電']) expect(classify(t), t).toBeNull();
  });

  it('answers weather and US stocks from the sources, addressing Sir', async () => {
    const { deps } = setup();
    const weather = await runLocal({ kind: 'weather', day: 1 }, { ...deps, weather: async () => ({ date: '2026-10-30', place: '林口', summary: '陣雨', code: 80, temp_max: 26.4, temp_min: 21.2, rain_chance: 70, rain_mm: 3, uv_max: 5, advice: ['出門帶傘'], source: 'Open-Meteo' }) });
    expect(weather.reply).toMatch(/Sir/);
    expect(weather.reply).toContain('明天林口陣雨 21–26°C，降雨機率 70%');
    expect(weather.reply).toContain('出門帶傘');
    const off = await runLocal({ kind: 'weather', day: 0 }, deps);
    expect(off.reply).toContain('沒有開啟');
    const us = await runLocal({ kind: 'markets_us' }, { ...deps, usQuotes: async () => ({ quotes: [{ symbol: 'SPY', label: 'S&P 500 (SPY)', date: '2026-10-28', close: 612.3, change_pct: 0.42 }], errors: ['NVDA 查詢太快'] }) });
    expect(us.reply).toContain('美股 10/28 收盤');
    expect(us.reply).toContain('S&P 500 (SPY) 612.3（+0.42%）');
    expect(us.reply).toContain('另有 1 檔暫時讀不到');
    expect(us.reply).toContain('不是投資建議');
  });

  it('compares training weeks and reads the sleep trend with fixed arithmetic', async () => {
    const { deps } = setup();
    const compare = await runLocal({ kind: 'garmin', which: 'compare' }, deps);
    expect(compare.reply).toContain('總量 130 → 230 分鐘（+77%）');
    expect(compare.reply).toContain('羽球：1 次 120 分（上週 90 分，+33%）');
    expect(compare.reply).toContain('留意恢復');
    const trend = await runLocal({ kind: 'garmin', which: 'sleep_trend' }, deps);
    expect(trend.reply).toMatch(/^Sir，最近 7 晚平均睡 6 小時 \d+ 分，比前一週少 \d+ 分鐘/);
    expect(trend.reply).toContain('最短 10/24 6 小時 0 分');
    expect(trend.reply).toContain('有 3 晚不到 6.5 小時');
  });

  it('runs the home tile and body page questions locally, with no model call', async () => {
    const { hub } = setup();
    process.env.OPENAI_API_KEY = 'sk-test';
    const { client, requests } = fakeOpenAI();
    for (const text of ['這週訓練量和上週比較', '最近 7 晚的睡眠趨勢', '你會做什麼']) {
      const r = await handleChat(hub, ctxAt(NOW), { style: 'professional', history: [], text, clients: { openai: () => client } });
      expect(r.ok && r.route.source, text).not.toBe('ai');
      expect(r.ok && r.reply, text).toMatch(/Sir/);
    }
    expect(requests).toHaveLength(0);
    delete process.env.OPENAI_API_KEY;
  });
});

describe('task parsing does not swallow ordinary questions', () => {
  it('leaves a question with 週末 / 每天 but no reminder to the model', () => {
    for (const t of ['幫我想個週末去哪走走', '每天喝咖啡會不會不好', '週末適合跑長距離嗎']) expect(classify(t), t).toBeNull();
    expect(classify('每週六早上提醒我')?.kind).toBe('task_create');
  });
});
