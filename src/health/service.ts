import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { DEFAULT_WATER_PREFS, type WaterDay, type WaterPrefs } from './water';

/**
 * Water preferences and daily totals, kept encrypted in NOIRXU AI's own settings table
 * (one row for preferences, one row per day). No source system is involved.
 */
export class WaterService {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}

  private async read<T>(key: string): Promise<T | null> {
    const sealed = await this.store.getSetting(key);
    return sealed ? JSON.parse(this.vault.open(sealed, key)) as T : null;
  }

  private async write(key: string, value: unknown) {
    await this.store.putSetting(key, this.vault.seal(JSON.stringify(value), key));
  }

  async prefs(userId: string): Promise<WaterPrefs> {
    return { ...DEFAULT_WATER_PREFS, ...(await this.read<Partial<WaterPrefs>>(`water_prefs:${userId}`)) };
  }

  async updatePrefs(userId: string, patch: Partial<WaterPrefs>): Promise<WaterPrefs> {
    const next = { ...(await this.prefs(userId)), ...patch };
    await this.write(`water_prefs:${userId}`, next);
    return next;
  }

  async day(userId: string, date: string): Promise<WaterDay> {
    return (await this.read<WaterDay>(`water_day:${userId}:${date}`)) ?? { date, total_ml: 0, entries: [] };
  }

  async log(userId: string, date: string, ml: number, at: Date): Promise<WaterDay> {
    const day = await this.day(userId, date);
    const next = { date, entries: [...day.entries, { at: at.toISOString(), ml }], total_ml: day.total_ml + ml };
    await this.write(`water_day:${userId}:${date}`, next);
    return next;
  }

  async undo(userId: string, date: string): Promise<{ day: WaterDay; removed: number | null }> {
    const day = await this.day(userId, date);
    const last = day.entries.at(-1);
    if (!last) return { day, removed: null };
    const next = { date, entries: day.entries.slice(0, -1), total_ml: day.total_ml - last.ml };
    await this.write(`water_day:${userId}:${date}`, next);
    return { day: next, removed: last.ml };
  }
}
