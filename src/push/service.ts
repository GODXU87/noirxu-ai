import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { isAllowedPushEndpoint } from './endpoints';

export interface PushMessage {
  title: string;
  body: string;
  /** Page to open when the notification is tapped. */
  url?: string;
  tag?: string;
}

interface VapidKeys { publicKey: string; privateKey: string }

const SETTING_KEY = 'vapid_keys_v1';
const SUBJECT = 'mailto:ai@noirxu.com';

/**
 * Web Push with VAPID keys that the app generates once and keeps encrypted in its own
 * settings table, so nobody has to create or paste a key.
 */
export class PushService {
  private keys: VapidKeys | null = null;

  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}

  private async vapid(): Promise<VapidKeys> {
    if (this.keys) return this.keys;
    let sealed = await this.store.getSetting(SETTING_KEY);
    if (!sealed) {
      const generated = webpush.generateVAPIDKeys();
      sealed = await this.store.putSettingIfAbsent(SETTING_KEY, this.vault.seal(JSON.stringify(generated), SETTING_KEY));
    }
    this.keys = JSON.parse(this.vault.open(sealed, SETTING_KEY)) as VapidKeys;
    return this.keys;
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async subscribe(userId: string, subscription: { endpoint: string }, userAgent: string) {
    await this.store.savePushSubscription({ endpoint: subscription.endpoint, user_id: userId, subscription, user_agent: userAgent });
  }

  async unsubscribe(endpoint: string) {
    await this.store.deletePushSubscription(endpoint);
  }

  /**
   * Sends to every device of the user and reports each device separately. "accepted" only
   * means the browser's push service took the message; it does not prove the device showed it.
   * Subscriptions the push service says are gone (404/410) are removed.
   */
  async send(userId: string, message: PushMessage, now = new Date()): Promise<SendReport> {
    const keys = await this.vapid();
    const subs = await this.store.listPushSubscriptions(userId);
    const devices = await Promise.all(subs.map(async (sub): Promise<DeviceResult> => {
      const base = { device: deviceId(sub.endpoint), platform: platformOf(sub.user_agent ?? '') };
      if (!isAllowedPushEndpoint(sub.endpoint)) return { ...base, outcome: 'invalid_endpoint', retryable: false, error: '訂閱端點不在允許的推播服務清單內' };
      try {
        await webpush.sendNotification(sub.subscription as webpush.PushSubscription, JSON.stringify(message), {
          vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 60 * 60,
          urgency: 'high'
        });
        await this.store.markPushSuccess(sub.endpoint, now).catch(() => undefined);
        return { ...base, outcome: 'accepted', retryable: false };
      } catch (error) {
        const result = classifyPushError(error);
        if (result.outcome === 'gone') await this.store.deletePushSubscription(sub.endpoint).catch(() => undefined);
        return { ...base, ...result };
      }
    }));
    const sent = devices.filter(d => d.outcome === 'accepted').length;
    return { sent, failed: devices.length - sent, devices, noSubscription: devices.length === 0 };
  }

  /** This user's devices without their keys, for the diagnostics panel. */
  async devices(userId: string) {
    return (await this.store.listPushSubscriptions(userId)).map(sub => ({
      device: deviceId(sub.endpoint),
      platform: platformOf(sub.user_agent ?? ''),
      service: new URL(sub.endpoint).hostname,
      created_at: sub.created_at ?? null,
      last_success_at: sub.last_success_at ?? null
    }));
  }
}

export type DeviceOutcome = 'accepted' | 'rejected' | 'gone' | 'vapid_mismatch' | 'rate_limited' | 'provider_error' | 'network_error' | 'invalid_endpoint';
export interface DeviceResult { device: string; platform: string; outcome: DeviceOutcome; retryable: boolean; status?: number; error?: string }
export interface SendReport { sent: number; failed: number; devices: DeviceResult[]; noSubscription: boolean }

/** Short, stable id for a subscription that does not reveal the endpoint. */
export function deviceId(endpoint: string) {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 10);
}

export function platformOf(userAgent: string) {
  if (/iPhone|iPod/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return /Chrome|Edg|Firefox/.test(userAgent) ? 'Mac（Chromium/Firefox）' : 'Mac Safari';
  if (/Windows/.test(userAgent)) return 'Windows';
  return '其他裝置';
}

export function classifyPushError(error: unknown): Omit<DeviceResult, 'device' | 'platform'> {
  const status = (error as { statusCode?: number }).statusCode;
  const body = String((error as { body?: string }).body ?? '').slice(0, 160);
  if (status === 404 || status === 410) return { outcome: 'gone', retryable: false, status, error: '訂閱已失效（裝置取消或過期），需要在該裝置重新開啟通知' };
  if (status === 401 || status === 403) return { outcome: 'vapid_mismatch', retryable: false, status, error: `推播服務拒絕金鑰（VAPID 不一致）${body ? `：${body}` : ''}` };
  if (status === 429) return { outcome: 'rate_limited', retryable: true, status, error: '推播服務限流，稍後重試' };
  if (status && status >= 500) return { outcome: 'provider_error', retryable: true, status, error: `推播服務暫時錯誤（${status}）` };
  if (status) return { outcome: 'rejected', retryable: false, status, error: `推播服務拒絕（${status}）${body ? `：${body}` : ''}` };
  return { outcome: 'network_error', retryable: true, error: error instanceof Error ? error.message.slice(0, 160) : '網路錯誤' };
}
