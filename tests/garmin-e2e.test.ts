import { describe, expect, it, vi } from 'vitest';
import type { GarminAdapter } from '@/garmin/adapter';
import { garminTools } from '@/tools/garmin/tools';
import { chatHub, ctxAt, fakeOpenAI } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');
const { morningBriefing } = await import('@/server/tick');

const NOW = '2026-10-29T01:00:00Z'; // Thursday 09:00 Taipei
const sleep = (date: string, h: number) => ({ date, duration_s: h * 3600, deep_s: 4320, light_s: null, rem_s: 4560, awake_s: 600, awake_count: 0, quality: null, result: null, start_local: '23:40', end_local: '07:16', avg_hr: null, avg_sleep_stress: null, tonight_bedtime: null });
const garmin: GarminAdapter = {
  configured: true,
  sleep: async (_u, date) => sleep(date, 7.6),
  sleepRange: async () => ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].map(d => sleep(d, 7)),
  recovery: async date => ({ date: String(date), hrv_last_night_avg: 58, hrv_weekly_avg: 61, hrv_status: 'BALANCED', hrv_balanced_low: 52, hrv_balanced_high: 70, body_battery_at_wake: 71, body_battery_latest: 64, resting_hr: 52, resting_hr_7d_avg: 54, sleep_s: 27360, not_available: [] }),
  daily: async () => { throw new Error('not used'); },
  activities: async () => [],
  activity: async () => { throw new Error('not used'); }
};

describe('Garmin body status end to end', () => {
  it('answers "昨晚睡得怎樣" with the analysis and no model call, and leads the morning briefing with it', async () => {
    const { hub } = chatHub();
    garminTools(garmin).forEach(t => hub.registry.register(t));
    hub.garmin = garmin;
    const { client, requests } = fakeOpenAI();
    const r = await handleChat(hub, ctxAt(NOW), { style: 'professional', history: [], text: '昨晚睡得怎樣', clients: { openai: () => client } });
    expect(requests).toHaveLength(0);
    expect(r.ok && r.reply).toMatch(/^早安，Sir。昨晚睡了 7 小時 36 分（23:40–07:16），比平常多睡了 36 分鐘/);
    expect(r.ok && r.reply).toContain('今天的健身可以放心照計畫來');
    expect(r.ok && r.reply).toContain('難得狀態這麼好，別浪費了。');
    const brief = await morningBriefing(hub, 'owner', new Date(NOW));
    expect(brief.body.split('\n')[0]).toBe('身體：睡 7h36m · HRV 平衡 · BB 71 → 健身照計畫');
    // Hydration stays out of the briefing (the water reminders cover it); a direct question keeps it.
    expect(brief.card.health?.hydration_ml).toBeNull();
    expect(brief.card.health?.narrative.join()).not.toContain('水今天');
    expect(brief.card.health?.narrative.at(-1)).toBe('難得狀態這麼好，別浪費了。');
    expect(r.ok && r.reply).toContain('水今天喝到');
  });
});
