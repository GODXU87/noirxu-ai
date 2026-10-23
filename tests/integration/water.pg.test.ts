import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { WaterService } from '@/health/service';

// Real PostgreSQL (sh scripts/test-db.sh), connected as the limited noirxu_ai_app role.
const url = process.env.NOIRXU_TEST_DATABASE_URL;
const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const DAY = '2026-10-23';

describe.skipIf(!url)('C0 on real PostgreSQL (noirxu_ai_app)', () => {
  // Three pools = three server instances / devices with their own connections.
  const pools = url ? [0, 1, 2].map(() => new Pool({ connectionString: url, max: 1 })) : [];
  const devices = pools.map(pool => new WaterService(new PgAgendaStore(pool), vault));
  afterAll(async () => { await Promise.all(pools.map(p => p.end())); });
  const user = () => `it-${randomUUID()}`;

  it('30 simultaneous logs from 3 instances: none lost, none duplicated, totals consistent', async () => {
    const u = user();
    const amounts = Array.from({ length: 30 }, (_, i) => 100 + i); // distinct, so duplicates would show
    await Promise.all(amounts.map((ml, i) => devices[i % 3].log(u, DAY, ml, new Date())));
    for (const device of devices) {
      const day = await device.day(u, DAY);
      expect(day.entries).toHaveLength(30);
      expect(day.entries.map(e => e.ml).sort((a, b) => a - b)).toEqual(amounts);
      expect(day.total_ml).toBe(amounts.reduce((a, b) => a + b, 0));
    }
  }, 60_000);

  it('logs and undos racing each other keep total == sum of entries', async () => {
    const u = user();
    for (let i = 0; i < 10; i += 1) await devices[0].log(u, DAY, 200, new Date());
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => devices[(i + 1) % 3].undo(u, DAY)),
      ...Array.from({ length: 5 }, (_, i) => devices[i % 3].log(u, DAY, 300, new Date()))
    ]);
    const day = await devices[2].day(u, DAY);
    expect(day.entries).toHaveLength(10);
    expect(day.total_ml).toBe(day.entries.reduce((s, e) => s + e.ml, 0));
  }, 60_000);

  it('goal changes persist and are seen by every instance; concurrent edits merge', async () => {
    const u = user();
    await Promise.all([devices[0].updatePrefs(u, { goal_ml: 2500 }), devices[1].updatePrefs(u, { enabled: false }), devices[2].updatePrefs(u, { interval_hours: 3 })]);
    for (const device of devices) expect(await device.prefs(u)).toMatchObject({ goal_ml: 2500, enabled: false, interval_hours: 3 });
  }, 60_000);

  it('leaves other rows untouched and stores only ciphertext', async () => {
    const u = user();
    const store = new PgAgendaStore(pools[0]);
    await store.putSetting(`unrelated:${u}`, 'existing-value');
    await devices[0].log(u, DAY, 640, new Date());
    expect(await store.getSetting(`unrelated:${u}`)).toBe('existing-value');
    const { rows } = await pools[0].query('select sealed from noirxu_ai.settings where key = $1', [`water_day:${u}:${DAY}`]);
    expect(rows[0].sealed).not.toContain('640');
  });

  it('the app role cannot delete settings rows or read outside its schema', async () => {
    await expect(pools[0].query('delete from noirxu_ai.settings where key = $1', ['x'])).rejects.toThrow(/permission denied/);
    await expect(pools[0].query('select * from outside_data.secrets')).rejects.toThrow(/permission denied/);
  });
});
