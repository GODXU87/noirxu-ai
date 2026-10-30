import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import type { DeviceResult, PushMessage, SendReport } from '@/push/service';

// Durable delivery state for every notification (reminders, briefing, water).
//
// Before this, a notification was "claimed" in notification_log and then sent once; if no
// device was subscribed or the push service failed, it was still treated as done and was
// lost. Now each notification has a record that moves through
//   pending → sending → provider_accepted | retry_pending → … → failed | expired
// with a lease (so a crashed run can be retried), exponential backoff, an expiry, the reason
// for each failure and the result per device. "provider_accepted" only means a push service
// accepted the message; it never claims the device displayed it.
//
// Records live in the existing settings table (sealed, compare-and-set) so this works with the
// current database grants. A dedicated table is prepared in supabase/pending for approval.

/** 'grouped' = sent as part of a combined notification (see digest_key), not on its own. */
/** 'held' = kept in the inbox only (quiet hours or daily limit for proactive alerts), never pushed. */
export type DeliveryStatus = 'pending' | 'claimed' | 'sending' | 'provider_accepted' | 'retry_pending' | 'failed' | 'expired' | 'grouped' | 'held';
const TERMINAL: DeliveryStatus[] = ['provider_accepted', 'failed', 'expired', 'grouped', 'held'];

export interface DeliveryRecord {
  key: string;
  kind: string;
  user_id: string;
  message: PushMessage;
  status: DeliveryStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  lease_until?: string;
  next_retry_at?: string;
  accepted_at?: string;
  last_error?: string;
  devices?: DeviceResult[];
  /** For 'grouped': the combined notification that carried this one. */
  digest_key?: string;
  /** For 'held': why it was not pushed. */
  held_reason?: string;
  /** Reported by the service worker after it showed the notification (a real device receipt). */
  displayed_at?: string;
  /** Reported when the user tapped the notification. */
  opened_at?: string;
}

export interface InboxEntry { key: string; kind: string; title: string; body: string; url?: string; created_at: string; read: boolean }

export const MAX_ATTEMPTS = 8;
const LEASE_MS = 90_000;
const INBOX_LIMIT = 100;

export function backoffMs(attempts: number) {
  return Math.min(2 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

export class DeliveryService {
  constructor(
    private readonly store: AgendaStore,
    private readonly vault: TokenVault,
    private readonly send: (userId: string, message: PushMessage, now: Date) => Promise<SendReport>
  ) {}

  private settingKey(key: string) { return `notify:${key}`; }

  private open<T>(sealed: string | null, key: string): T | null {
    return sealed ? JSON.parse(this.vault.open(sealed, key)) as T : null;
  }

  async get(key: string): Promise<DeliveryRecord | null> {
    const k = this.settingKey(key);
    return this.open<DeliveryRecord>(await this.store.getSetting(k), k);
  }

  /** Compare-and-set update; returns the stored record, or null if another run changed it first. */
  private async transition(key: string, expected: string | null, next: DeliveryRecord): Promise<boolean> {
    const k = this.settingKey(key);
    return this.store.compareAndSetSetting(k, expected, this.vault.seal(JSON.stringify(next), k));
  }

  /**
   * Delivers `message` once under `key`. Safe to call on every scheduler run: it creates the
   * record the first time (and files it in the in-app inbox), then sends only when the
   * notification is due for an attempt and no other run holds the lease.
   */
  async deliver(input: { key: string; kind: string; userId: string; message: PushMessage; expiresAt: Date; now: Date; inbox?: boolean }): Promise<DeliveryRecord> {
    const { key, now } = input;
    const k = this.settingKey(key);
    let sealed = await this.store.getSetting(k);
    let record = this.open<DeliveryRecord>(sealed, k);

    if (!record) {
      const fresh: DeliveryRecord = {
        key, kind: input.kind, user_id: input.userId, message: input.message, status: 'pending', attempts: 0,
        created_at: now.toISOString(), updated_at: now.toISOString(), expires_at: input.expiresAt.toISOString()
      };
      if (await this.transition(key, null, fresh) && input.inbox !== false) await this.addToInbox(input.userId, { key, kind: input.kind, title: input.message.title, body: input.message.body, url: input.message.url, created_at: now.toISOString(), read: false });
      sealed = await this.store.getSetting(k);
      record = this.open<DeliveryRecord>(sealed, k)!;
    }

    if (TERMINAL.includes(record.status)) return record;
    if (now.getTime() > Date.parse(record.expires_at)) {
      const expired = { ...record, status: 'expired' as const, updated_at: now.toISOString(), last_error: record.last_error ?? '超過有效時間仍未送出' };
      return (await this.transition(key, sealed, expired)) ? expired : (await this.get(key))!;
    }
    if ((record.status === 'sending' || record.status === 'claimed') && record.lease_until && Date.parse(record.lease_until) > now.getTime()) return record;
    if (record.status === 'retry_pending' && record.next_retry_at && Date.parse(record.next_retry_at) > now.getTime()) return record;

    // Retries send the caller's current message (e.g. today's water total), not the first draft.
    const sending: DeliveryRecord = { ...record, message: input.message, status: 'sending', attempts: record.attempts + 1, lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), updated_at: now.toISOString() };
    if (!(await this.transition(key, sealed, sending))) return (await this.get(key))!;

    let report: SendReport | null = null;
    let error: string | undefined;
    try {
      report = await this.send(record.user_id, { ...sending.message, key }, now);
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : '發送時發生錯誤';
    }

    let next: DeliveryRecord;
    if (report && report.sent > 0) {
      next = { ...sending, status: 'provider_accepted', accepted_at: now.toISOString(), devices: report.devices, last_error: undefined, lease_until: undefined, next_retry_at: undefined };
    } else {
      const reason = error ?? (report?.noSubscription ? '沒有任何已訂閱通知的裝置' : summarize(report!.devices));
      const finalAttempt = sending.attempts >= MAX_ATTEMPTS;
      next = {
        ...sending,
        status: finalAttempt ? 'failed' : 'retry_pending',
        devices: report?.devices,
        last_error: reason,
        lease_until: undefined,
        next_retry_at: finalAttempt ? undefined : new Date(now.getTime() + backoffMs(sending.attempts)).toISOString()
      };
    }
    next.updated_at = new Date().toISOString();
    // Receipts can arrive before the provider request returns. Merge only receipt fields
    // into this attempt's result; never overwrite a newer attempt or return unpersisted success.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentSealed = await this.store.getSetting(k);
      const current = this.open<DeliveryRecord>(currentSealed, k);
      if (!current) throw new Error('notification delivery record missing');
      if (current.status !== 'sending' || current.attempts !== sending.attempts || current.lease_until !== sending.lease_until) return current;
      const merged = { ...next, displayed_at: current.displayed_at, opened_at: current.opened_at };
      if (await this.transition(key, currentSealed, merged)) return merged;
    }
    throw new Error('notification delivery is busy, retry later');
  }

  /**
   * Keeps the record and inbox entry of a notification that goes out inside a combined
   * notification (digest) instead of on its own. Idempotent.
   */
  async recordGrouped(input: { key: string; kind: string; userId: string; message: PushMessage; digestKey: string; expiresAt: Date; now: Date }): Promise<DeliveryRecord> {
    const existing = await this.get(input.key);
    if (existing) return existing;
    const record: DeliveryRecord = {
      key: input.key, kind: input.kind, user_id: input.userId, message: input.message, status: 'grouped', attempts: 0,
      created_at: input.now.toISOString(), updated_at: input.now.toISOString(), expires_at: input.expiresAt.toISOString(), digest_key: input.digestKey
    };
    if (await this.transition(input.key, null, record)) {
      await this.addToInbox(input.userId, { key: input.key, kind: input.kind, title: input.message.title, body: input.message.body, url: input.message.url, created_at: input.now.toISOString(), read: false });
      return record;
    }
    return (await this.get(input.key))!;
  }

  /**
   * Device receipt from the service worker. Only a notification owned by `userId` can be
   * marked; the first time of each event is kept. Without a receipt the app never claims a
   * notification was shown — "provider_accepted" only means the push service took it.
   */
  async markReceipt(userId: string, key: string, event: 'displayed' | 'opened', now: Date): Promise<boolean> {
    const k = this.settingKey(key);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sealed = await this.store.getSetting(k);
      const record = this.open<DeliveryRecord>(sealed, k);
      if (!record || record.user_id !== userId) return false;
      const field = event === 'displayed' ? 'displayed_at' : 'opened_at';
      const next: DeliveryRecord = { ...record, [field]: now.toISOString() };
      if (record[field] || await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(next), k))) {
        if (event === 'opened') await this.markRead(userId, [key]);
        return true;
      }
    }
    return false;
  }

  /** Files a notification in the inbox without pushing it (status 'held'). Idempotent. */
  async hold(input: { key: string; kind: string; userId: string; message: PushMessage; reason: string; now: Date }): Promise<DeliveryRecord> {
    const existing = await this.get(input.key);
    if (existing) return existing;
    const record: DeliveryRecord = {
      key: input.key, kind: input.kind, user_id: input.userId, message: input.message, status: 'held', attempts: 0,
      created_at: input.now.toISOString(), updated_at: input.now.toISOString(), expires_at: input.now.toISOString(), held_reason: input.reason
    };
    if (await this.transition(input.key, null, record)) {
      await this.addToInbox(input.userId, { key: input.key, kind: input.kind, title: input.message.title, body: input.message.body, url: input.message.url, created_at: input.now.toISOString(), read: false });
      return record;
    }
    return (await this.get(input.key))!;
  }

  // In-app inbox: every notification is filed here when it is created, so nothing is lost
  // while no device is subscribed. It does not replace system notifications when offline.

  private inboxKey(userId: string) { return `inbox:${userId}`; }

  async inbox(userId: string): Promise<InboxEntry[]> {
    const k = this.inboxKey(userId);
    return this.open<InboxEntry[]>(await this.store.getSetting(k), k) ?? [];
  }

  private async updateInbox(userId: string, change: (list: InboxEntry[]) => InboxEntry[]) {
    const k = this.inboxKey(userId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sealed = await this.store.getSetting(k);
      const list = this.open<InboxEntry[]>(sealed, k) ?? [];
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(change(list)), k))) return;
    }
  }

  async addToInbox(userId: string, entry: InboxEntry) {
    await this.updateInbox(userId, list => [entry, ...list.filter(e => e.key !== entry.key)].slice(0, INBOX_LIMIT));
  }

  async markRead(userId: string, keys: string[] | 'all') {
    await this.updateInbox(userId, list => list.map(e => (keys === 'all' || keys.includes(e.key) ? { ...e, read: true } : e)));
  }

  /** Inbox entries joined with their delivery records, newest first. */
  async history(userId: string, limit = 30) {
    const entries = (await this.inbox(userId)).slice(0, limit);
    return Promise.all(entries.map(async entry => ({ ...entry, delivery: await this.get(entry.key) })));
  }
}

function summarize(devices: DeviceResult[]) {
  return devices.map(d => `${d.platform}：${d.error ?? d.outcome}`).join('；') || '推播失敗';
}
