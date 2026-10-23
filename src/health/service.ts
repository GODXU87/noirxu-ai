import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';
import { DEFAULT_WATER_PREFS, type WaterDay, type WaterPrefs } from './water';

const MAX_ATTEMPTS = 10;
const backoff = (attempt: number) => new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(200, 10 * 2 ** attempt)));

/**
 * Water preferences and daily totals, kept encrypted in NOIRXU AI's own settings table
 * (one row for preferences, one row per day). No source system is involved.
 *
 * Every change is read → modify → compare-and-set, retried on conflict, so two devices
 * logging at the same moment both count instead of one overwriting the other.
 */
export class WaterService {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}

  private open<T>(key: string, sealed: string | null): T | null {
    return sealed ? JSON.parse(this.vault.open(sealed, key)) as T : null;
  }

  private async read<T>(key: string): Promise<T | null> {
    return this.open<T>(key, await this.store.getSetting(key));
  }

  private async mutate<T, R>(key: string, change: (current: T | null) => { next: T; result: R } | null): Promise<R | null> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const sealed = await this.store.getSetting(key);
      const outcome = change(this.open<T>(key, sealed));
      if (!outcome) return null;
      if (await this.store.compareAndSetSetting(key, sealed, this.vault.seal(JSON.stringify(outcome.next), key))) return outcome.result;
      await backoff(attempt);
    }
    throw new ToolError('CONFLICT', '同時有其他裝置在更新，這筆沒有存進去，請再試一次。');
  }

  async prefs(userId: string): Promise<WaterPrefs> {
    return { ...DEFAULT_WATER_PREFS, ...(await this.read<Partial<WaterPrefs>>(`water_prefs:${userId}`)) };
  }

  async updatePrefs(userId: string, patch: Partial<WaterPrefs>): Promise<WaterPrefs> {
    const next = await this.mutate<Partial<WaterPrefs>, WaterPrefs>(`water_prefs:${userId}`, current => {
      const merged = { ...DEFAULT_WATER_PREFS, ...current, ...patch };
      return { next: merged, result: merged };
    });
    return next!;
  }

  async day(userId: string, date: string): Promise<WaterDay> {
    return (await this.read<WaterDay>(`water_day:${userId}:${date}`)) ?? { date, total_ml: 0, entries: [] };
  }

  async log(userId: string, date: string, ml: number, at: Date): Promise<WaterDay> {
    const next = await this.mutate<WaterDay, WaterDay>(`water_day:${userId}:${date}`, current => {
      const day = current ?? { date, total_ml: 0, entries: [] };
      const updated = { date, entries: [...day.entries, { at: at.toISOString(), ml }], total_ml: day.total_ml + ml };
      return { next: updated, result: updated };
    });
    return next!;
  }

  async undo(userId: string, date: string): Promise<{ day: WaterDay; removed: number | null }> {
    const result = await this.mutate<WaterDay, { day: WaterDay; removed: number }>(`water_day:${userId}:${date}`, current => {
      const last = current?.entries.at(-1);
      if (!current || !last) return null;
      const updated = { date, entries: current.entries.slice(0, -1), total_ml: current.total_ml - last.ml };
      return { next: updated, result: { day: updated, removed: last.ml } };
    });
    return result ?? { day: await this.day(userId, date), removed: null };
  }
}
