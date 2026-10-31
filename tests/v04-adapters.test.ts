import { describe, expect, it } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { budgetAlerts, fromLedgerBudget, parseThresholds, spendingAnomaly, spendingPace, totalsByCurrency } from '@/finance/intel';
import { GARMIN_TOKEN_URL, GarminConnectionStore, GarminNotConfigured, verifyGarminKey } from '@/garmin/adapter';
import { speakable, voiceSupport } from '@/lib/voice';
import { vault } from './helpers/chat-hub';

const budget = {
  currency: 'TWD',
  total: { limit: 20000, spent: 16400, status: 'warning' },
  categories: [
    { categoryId: 'food', name: '餐飲', limit: 6000, spent: 6300, status: 'over' },
    { categoryId: 'fun', name: '娛樂', limit: 3000, spent: 900, status: 'safe' },
    { categoryId: 'misc', name: '雜項', limit: 0, spent: 1200, status: 'unset' }
  ]
};

describe('finance intelligence (deterministic)', () => {
  it('alerts only on budgets the user set, once per level per month', () => {
    const lines = fromLedgerBudget(budget);
    expect(lines.map(l => l.key)).toEqual(['total', 'cat:food', 'cat:fun']); // 雜項 has no budget: never assumed
    const alerts = budgetAlerts(lines, '2026-10');
    expect(alerts.map(a => [a.line.name, a.level])).toEqual([['總預算', 'warn'], ['餐飲', 'over']]);
    expect(alerts[1]).toMatchObject({ key: 'finance:budget:2026-10:TWD:cat:food:over', title: '餐飲已超出預算', body: 'TWD 6,300 / 6,000（105%），超出 300' });
    expect(budgetAlerts(lines, '2026-10').map(a => a.key)).toEqual(alerts.map(a => a.key));
  });

  it('honours adjusted thresholds and rejects invalid ones', () => {
    const t = parseThresholds({ warn: 0.9 });
    expect(t).toEqual({ warn: 0.9, over: 1 });
    expect(budgetAlerts(fromLedgerBudget(budget), '2026-10', t as { warn: number; over: number }).map(a => a.line.name)).toEqual(['餐飲']);
    expect(parseThresholds({ warn: 1.2, over: 1 })).toHaveProperty('error');
    expect(parseThresholds({ warn: 0.3 })).toHaveProperty('error');
  });

  it('projects month-end spending only after enough days', () => {
    const line = { key: 'total', name: '總預算', currency: 'TWD', limit: 31000, spent: 15000 };
    expect(spendingPace(line, '2026-10-03')).toBeNull();
    expect(spendingPace(line, '2026-10-10')).toMatchObject({ elapsed_days: 10, days_in_month: 31, projected: 46500, expected_spent: 10000, ahead_of_pace: true });
  });

  it('flags anomalies against a robust baseline, never on too little or flat data', () => {
    expect(spendingAnomaly([300, 280], 5000)).toMatchObject({ status: 'insufficient', needed: 6 });
    expect(spendingAnomaly([300, 300, 300, 300, 300, 300], 900)).toMatchObject({ status: 'flat' });
    const history = [310, 280, 295, 330, 260, 300, 315, 290];
    expect(spendingAnomaly(history, 320).status).toBe('normal');
    expect(spendingAnomaly(history, 1200)).toMatchObject({ status: 'anomaly', median: 297.5 });
  });

  it('never adds different currencies together', () => {
    expect(totalsByCurrency([{ currency: 'TWD', amount: 100 }, { currency: 'USD', amount: 3.5 }, { currency: 'TWD', amount: 50 }])).toEqual({ TWD: 150, USD: 3.5 });
  });
});

describe('Garmin adapter (interface only until the official API is approved)', () => {
  it('returns an honest not-configured error instead of data', async () => {
    const garmin = new GarminNotConfigured();
    expect(garmin.configured).toBe(false);
    await expect(garmin.daily('owner', '2026-10-23')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(garmin.activities('owner', { from: '2026-10-01', to: '2026-10-23' })).rejects.toThrow('不會使用帳號密碼');
  });

  it('keeps the API key sealed, shows only a hint, records checks, and disconnects without leaving the key', async () => {
    const store = new MemoryAgendaStore();
    const conns = new GarminConnectionStore(store, vault);
    const now = new Date('2026-10-23T00:00:00Z');
    await conns.save('owner', { apiKey: 'gpk-secret-key-0123456789abcd', keyExpiresOn: '2026-10-25', now });
    expect(store.settings.get('garmin:connection:owner')).not.toContain('gpk-secret');
    const status = await conns.status('owner', now);
    expect(status).toMatchObject({ connected: true, key_hint: '…abcd', key_expired: false, last_check_status: null });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(await conns.status('owner', new Date('2026-10-26T00:00:00Z'))).toMatchObject({ key_expired: true });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
    const check = await verifyGarminKey(conns, 'owner', now, fake);
    expect(calls[0].url).toBe(GARMIN_TOKEN_URL);
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: { Authorization: 'ApiKey gpk-secret-key-0123456789abcd' } });
    expect(check).toMatchObject({ ok: false, status: 401 });
    expect(await conns.status('owner', now)).toMatchObject({ last_check_status: 401, last_error: expect.stringContaining('拒絕') });
    const good = (async () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86400 }), { status: 200 })) as unknown as typeof fetch;
    expect(await verifyGarminKey(conns, 'owner', now, good)).toMatchObject({ ok: true });
    expect(await conns.status('owner', now)).toMatchObject({ last_check_status: 200, last_error: null });

    await conns.disconnect('owner', now);
    expect(await conns.status('owner', now)).toEqual({ connected: false });
    expect(vault.open(store.settings.get('garmin:connection:owner')!, 'garmin:connection:owner')).not.toContain('gpk');
  });
});

describe('voice helpers (browser speech only)', () => {
  it('detects support and explains a fallback', () => {
    expect(voiceSupport({ webkitSpeechRecognition: class {}, speechSynthesis: {}, isSecureContext: true })).toEqual({ recognition: true, synthesis: true });
    expect(voiceSupport({ speechSynthesis: {}, isSecureContext: true })).toMatchObject({ recognition: false, synthesis: true, reason: expect.stringContaining('不支援語音輸入') });
    expect(voiceSupport({ SpeechRecognition: class {}, isSecureContext: false })).toMatchObject({ recognition: false, reason: '語音輸入需要 HTTPS。' });
    expect(voiceSupport(undefined).recognition).toBe(false);
  });

  it('reads back plain, short text', () => {
    expect(speakable('**本月**支出 [TWD 6,000](https://x.y)。')).toBe('本月支出 TWD 6,000。');
    const long = speakable(`${'今天有很多事情要處理。'.repeat(40)}`);
    expect(long.endsWith('詳細內容在畫面上。')).toBe(true);
    expect(long.length).toBeLessThan(240);
  });
});
