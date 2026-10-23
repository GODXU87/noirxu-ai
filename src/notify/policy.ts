import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { taipeiDate } from '@/lib/dates';
import type { PushMessage } from '@/push/service';
import type { DeliveryRecord, DeliveryService } from './delivery';

// Limits for proactive notifications — the ones SASUKE decides to send (spending watches,
// budget alerts, task results), not the reminders the user asked for at a set time. Over the
// limit, or in quiet hours, a notification is filed in the inbox instead of pushed: nothing
// is dropped. Critical alerts are the exception and always push.

export type NotifyPriority = 'critical' | 'high' | 'normal' | 'low';
export interface ProactivePrefs { daily_cap: number; quiet_start: string | null; quiet_end: string | null }
export const DEFAULT_PROACTIVE: ProactivePrefs = { daily_cap: 6, quiet_start: '23:00', quiet_end: '07:00' };
export const PROACTIVE_PREFS_KEY = 'notify:proactive:prefs';

function taipeiHHMM(at: Date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

export function inQuietHours(prefs: ProactivePrefs, now: Date) {
  if (!prefs.quiet_start || !prefs.quiet_end || prefs.quiet_start === prefs.quiet_end) return false;
  const t = taipeiHHMM(now);
  return prefs.quiet_start < prefs.quiet_end ? t >= prefs.quiet_start && t < prefs.quiet_end : t >= prefs.quiet_start || t < prefs.quiet_end;
}

/**
 * critical: always push. high: may exceed the daily cap, but respects quiet hours.
 * normal / low: respect both.
 */
export function decide(input: { priority: NotifyPriority; now: Date; sentToday: number; prefs: ProactivePrefs }): { action: 'push' } | { action: 'inbox'; reason: string } {
  if (input.priority === 'critical') return { action: 'push' };
  if (inQuietHours(input.prefs, input.now)) return { action: 'inbox', reason: `靜音時段（${input.prefs.quiet_start}–${input.prefs.quiet_end}）` };
  if (input.priority !== 'high' && input.sentToday >= input.prefs.daily_cap) return { action: 'inbox', reason: `今天主動通知已達 ${input.prefs.daily_cap} 則上限` };
  return { action: 'push' };
}

export class ProactiveNotifier {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault, private readonly delivery: DeliveryService) {}

  async prefs(): Promise<ProactivePrefs> {
    try { return { ...DEFAULT_PROACTIVE, ...JSON.parse((await this.store.getSetting(PROACTIVE_PREFS_KEY)) ?? '{}') }; } catch { return DEFAULT_PROACTIVE; }
  }

  private countKey(userId: string, now: Date) { return `notify:proactive:count:${userId}:${taipeiDate(now)}`; }

  async sentToday(userId: string, now: Date): Promise<number> {
    const k = this.countKey(userId, now);
    const sealed = await this.store.getSetting(k);
    return sealed ? Number(this.vault.open(sealed, k)) : 0;
  }

  private async bump(userId: string, now: Date) {
    const k = this.countKey(userId, now);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sealed = await this.store.getSetting(k);
      const n = sealed ? Number(this.vault.open(sealed, k)) : 0;
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(String(n + 1), k))) return;
    }
  }

  /** Sends once under `key` (the stable event id), or files it in the inbox when over the limits. */
  async notify(input: { key: string; kind: string; userId: string; message: PushMessage; priority: NotifyPriority; now: Date; expiresAt: Date }): Promise<DeliveryRecord> {
    const existing = await this.delivery.get(input.key);
    if (!existing) {
      const verdict = decide({ priority: input.priority, now: input.now, sentToday: await this.sentToday(input.userId, input.now), prefs: await this.prefs() });
      if (verdict.action === 'inbox') return this.delivery.hold({ ...input, reason: verdict.reason });
      await this.bump(input.userId, input.now);
    }
    return this.delivery.deliver({ key: input.key, kind: input.kind, userId: input.userId, message: input.message, now: input.now, expiresAt: input.expiresAt });
  }
}
