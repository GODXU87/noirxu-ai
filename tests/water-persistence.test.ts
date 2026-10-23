import { describe, expect, it } from 'vitest';
import { MemoryAgendaStore, PgAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { WaterService } from '@/health/service';

const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const DAY = '2026-10-23';
const at = new Date('2026-10-23T04:00:00Z');

/** Yields between every read and write so concurrent calls really interleave. */
class InterleavingStore extends MemoryAgendaStore {
  override async getSetting(key: string) { const v = await super.getSetting(key); await new Promise(r => setTimeout(r, Math.random() * 3)); return v; }
}

describe('C0: water persistence', () => {
  it('keeps the second and later entries, and a fresh instance (refresh / other device) sees them', async () => {
    const store = new MemoryAgendaStore();
    const phone = new WaterService(store, vault);
    await phone.log('owner', DAY, 300, at);
    await phone.log('owner', DAY, 500, at);
    await phone.log('owner', DAY, 250, at);
    const mac = new WaterService(store, vault);
    expect(await mac.day('owner', DAY)).toMatchObject({ total_ml: 1050 });
    expect((await mac.day('owner', DAY)).entries.map(e => e.ml)).toEqual([300, 500, 250]);
  });

  it('persists goal changes and later edits', async () => {
    const store = new MemoryAgendaStore();
    await new WaterService(store, vault).updatePrefs('owner', { goal_ml: 2500 });
    await new WaterService(store, vault).updatePrefs('owner', { enabled: false });
    expect(await new WaterService(store, vault).prefs('owner')).toMatchObject({ goal_ml: 2500, enabled: false, start: '09:00' });
  });

  it('undo removes only the last entry and stays removed', async () => {
    const store = new MemoryAgendaStore();
    const water = new WaterService(store, vault);
    await water.log('owner', DAY, 300, at);
    await water.log('owner', DAY, 500, at);
    expect((await water.undo('owner', DAY)).removed).toBe(500);
    expect(await new WaterService(store, vault).day('owner', DAY)).toMatchObject({ total_ml: 300 });
    await water.undo('owner', DAY);
    expect(await water.undo('owner', DAY)).toMatchObject({ removed: null, day: { total_ml: 0 } });
  });

  it('loses nothing when many devices log at the same moment', async () => {
    const store = new InterleavingStore();
    const devices = [new WaterService(store, vault), new WaterService(store, vault), new WaterService(store, vault)];
    await Promise.all(Array.from({ length: 12 }, (_, i) => devices[i % 3].log('owner', DAY, 100, at)));
    const day = await devices[0].day('owner', DAY);
    expect(day.total_ml).toBe(1200);
    expect(day.entries).toHaveLength(12);
  });

  it('a plain read-then-write would have lost entries (shows the race is real)', async () => {
    const store = new InterleavingStore();
    const naive = async () => {
      const raw = await store.getSetting('k');
      const total = raw ? Number(raw) : 0;
      await store.putSetting('k', String(total + 100));
    };
    await Promise.all(Array.from({ length: 12 }, naive));
    expect(Number(await store.getSetting('k'))).toBeLessThan(1200);
  });

  it('gives up with a clear CONFLICT error instead of silently dropping a write', async () => {
    const store = new MemoryAgendaStore();
    store.compareAndSetSetting = async () => false;
    await expect(new WaterService(store, vault).log('owner', DAY, 300, at)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps users apart and stores only encrypted, key-bound values', async () => {
    const store = new MemoryAgendaStore();
    const water = new WaterService(store, vault);
    await water.log('owner', DAY, 700, at);
    expect(await water.day('someone-else', DAY)).toMatchObject({ total_ml: 0 });
    expect([...store.settings.values()].some(v => v.includes('700') || v.includes('total_ml'))).toBe(false);
    // A sealed value copied under another key cannot be opened.
    store.settings.set(`water_day:someone-else:${DAY}`, store.settings.get(`water_day:owner:${DAY}`)!);
    await expect(water.day('someone-else', DAY)).rejects.toThrow();
  });
});

describe('C0: PgAgendaStore compare-and-set SQL', () => {
  function pool(rowCount: number) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    return { queries, query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [], rowCount }; } };
  }

  it('inserts only when absent, updates only when unchanged, inside noirxu_ai', async () => {
    const insert = pool(1);
    expect(await new PgAgendaStore(insert as any).compareAndSetSetting('k', null, 'v1')).toBe(true);
    expect(insert.queries[0].text).toMatch(/insert into noirxu_ai\.settings[\s\S]*on conflict \(key\) do nothing/);

    const update = pool(0);
    expect(await new PgAgendaStore(update as any).compareAndSetSetting('k', 'v1', 'v2')).toBe(false);
    expect(update.queries[0].text).toMatch(/update noirxu_ai\.settings set sealed = \$3[\s\S]*where key = \$1 and sealed = \$2/);
    expect(update.queries[0].values).toEqual(['k', 'v1', 'v2']);
  });
});
