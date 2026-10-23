import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { taipeiDate } from '@/lib/dates';
import type { CostMode } from '@/router/tier';
import type { TurnUsage } from '@/server/agent';
import { costOf } from './pricing';

// Server-side API budget: limits per task, per day and per month, a cap on model calls per
// task and on concurrent model turns, plus a monthly usage record (cost by model and by
// feature, local answers, cache hits, failures). When a limit is reached only the paid
// model stops; local answers keep working.

export interface CostConfig {
  mode: CostMode;
  per_task_usd: number;
  daily_usd: number;
  monthly_usd: number;
  max_calls_per_task: number;
  max_concurrent: number;
}

export const DEFAULT_COST_CONFIG: CostConfig = { mode: 'balanced', per_task_usd: 0.5, daily_usd: 3, monthly_usd: 30, max_calls_per_task: 8, max_concurrent: 2 };

interface Bucket { turns: number; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }
export interface MonthUsage {
  month: string;
  cost_usd: number;
  /** Turns whose model has no configured price: counted, cost unknown. */
  unpriced_turns: number;
  turns: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  by_model: Record<string, Bucket>;
  by_feature: Record<string, Bucket>;
  local: { count: number; by_intent: Record<string, number> };
  cache_hits: number;
  failures: number;
  budget_stops: number;
  days: Record<string, number>;
}

const emptyBucket = (): Bucket => ({ turns: 0, calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
const emptyMonth = (month: string): MonthUsage => ({ month, cost_usd: 0, unpriced_turns: 0, turns: 0, model_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, by_model: {}, by_feature: {}, local: { count: 0, by_intent: {} }, cache_hits: 0, failures: 0, budget_stops: 0, days: {} });

let running = 0;

export class CostGuard {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}

  private read<T>(sealed: string | null, key: string): T | null { return sealed ? JSON.parse(this.vault.open(sealed, key)) as T : null; }

  private async update<T>(key: string, empty: () => T, change: (value: T) => T) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sealed = await this.store.getSetting(key);
      const next = change(this.read<T>(sealed, key) ?? empty());
      if (await this.store.compareAndSetSetting(key, sealed, this.vault.seal(JSON.stringify(next), key))) return next;
    }
    return null;
  }

  async config(): Promise<CostConfig> {
    return { ...DEFAULT_COST_CONFIG, ...(this.read<Partial<CostConfig>>(await this.store.getSetting('cost:config'), 'cost:config') ?? {}) };
  }

  async setConfig(patch: Partial<CostConfig>) {
    return this.update<CostConfig>('cost:config', () => ({ ...DEFAULT_COST_CONFIG }), current => ({ ...DEFAULT_COST_CONFIG, ...current, ...patch }));
  }

  private monthKey(now: Date) { return `cost:usage:${taipeiDate(now).slice(0, 7)}`; }

  async usage(now = new Date()): Promise<MonthUsage> {
    const key = this.monthKey(now);
    return this.read<MonthUsage>(await this.store.getSetting(key), key) ?? emptyMonth(taipeiDate(now).slice(0, 7));
  }

  /** Whether a paid model turn may start now; holds a concurrency slot until release(). */
  async admit(now = new Date()): Promise<{ ok: true; config: CostConfig; release: () => void } | { ok: false; reason: string }> {
    const [config, usage] = await Promise.all([this.config(), this.usage(now)]);
    const today = usage.days[taipeiDate(now)] ?? 0;
    const stop = usage.cost_usd >= config.monthly_usd ? `本月 AI 預算 US$${config.monthly_usd} 已用完`
      : today >= config.daily_usd ? `今天的 AI 預算 US$${config.daily_usd} 已用完`
      : running >= config.max_concurrent ? '同時進行的 AI 工作已達上限，請稍等幾秒再試' : null;
    if (stop) {
      await this.update<MonthUsage>(this.monthKey(now), () => emptyMonth(usage.month), u => ({ ...u, budget_stops: u.budget_stops + 1 }));
      return { ok: false, reason: `${stop}。查詢喝水、待辦、記帳金額這類本地功能照常可用；要調整上限請到「設定與連線 → AI 成本保護」。` };
    }
    running += 1;
    let released = false;
    return { ok: true, config, release: () => { if (!released) { released = true; running -= 1; } } };
  }

  /** Stops a turn before the next model call once it would pass the per-task limits. */
  perTaskCheck(model: string, config: CostConfig) {
    return (usage: TurnUsage): string | null => {
      if (usage.calls >= config.max_calls_per_task) return `這個請求已用了 ${usage.calls} 次模型呼叫（上限 ${config.max_calls_per_task}），先停在這裡。上方卡片是已完成的部分；要繼續的話，請把需求拆小一點。`;
      const cost = costOf(model, usage);
      if (cost !== null && cost >= config.per_task_usd) return `這個請求的 AI 費用已達單次上限 US$${config.per_task_usd}，先停在這裡。上方卡片是已完成的部分。`;
      return null;
    };
  }

  async recordTurn(input: { model: string; feature: string; usage: TurnUsage; failed?: boolean; now?: Date }) {
    const now = input.now ?? new Date();
    const cost = costOf(input.model, input.usage);
    const day = taipeiDate(now);
    const add = (b: Bucket | undefined): Bucket => {
      const x = b ?? emptyBucket();
      return { turns: x.turns + 1, calls: x.calls + input.usage.calls, cost_usd: x.cost_usd + (cost ?? 0), input_tokens: x.input_tokens + input.usage.input_tokens, output_tokens: x.output_tokens + input.usage.output_tokens };
    };
    return this.update<MonthUsage>(this.monthKey(now), () => emptyMonth(day.slice(0, 7)), u => ({
      ...u,
      cost_usd: u.cost_usd + (cost ?? 0),
      unpriced_turns: u.unpriced_turns + (cost === null ? 1 : 0),
      turns: u.turns + 1,
      model_calls: u.model_calls + input.usage.calls,
      input_tokens: u.input_tokens + input.usage.input_tokens,
      output_tokens: u.output_tokens + input.usage.output_tokens,
      cache_read_tokens: u.cache_read_tokens + input.usage.cache_read_input_tokens,
      cache_write_tokens: u.cache_write_tokens + input.usage.cache_creation_input_tokens,
      by_model: { ...u.by_model, [input.model]: add(u.by_model[input.model]) },
      by_feature: { ...u.by_feature, [input.feature]: add(u.by_feature[input.feature]) },
      failures: u.failures + (input.failed ? 1 : 0),
      days: { ...u.days, [day]: (u.days[day] ?? 0) + (cost ?? 0) }
    }));
  }

  async recordLocal(intent: string, now = new Date()) {
    return this.update<MonthUsage>(this.monthKey(now), () => emptyMonth(taipeiDate(now).slice(0, 7)), u => ({
      ...u, local: { count: u.local.count + 1, by_intent: { ...u.local.by_intent, [intent]: (u.local.by_intent[intent] ?? 0) + 1 } }
    }));
  }

  async recordCacheHits(hits: number, now = new Date()) {
    if (!hits) return null;
    return this.update<MonthUsage>(this.monthKey(now), () => emptyMonth(taipeiDate(now).slice(0, 7)), u => ({ ...u, cache_hits: u.cache_hits + hits }));
  }
}

/**
 * Savings estimate: local answers this month times the measured average cost of a model turn
 * this month. Null until there is at least one priced model turn to measure against.
 */
export function estimatedSavings(usage: MonthUsage): { usd: number; basis: string } | null {
  const priced = usage.turns - usage.unpriced_turns;
  if (priced <= 0 || usage.local.count === 0) return null;
  const average = usage.cost_usd / priced;
  return { usd: average * usage.local.count, basis: `本月 ${usage.local.count} 次本地處理 × 本月實測平均每次 AI 回覆 US$${average.toFixed(4)}` };
}
