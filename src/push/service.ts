import webpush from 'web-push';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';

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

  /** Sends to every device of the user; drops subscriptions the push service says are gone. */
  async send(userId: string, message: PushMessage): Promise<{ sent: number; failed: number }> {
    const keys = await this.vapid();
    const subs = await this.store.listPushSubscriptions(userId);
    let sent = 0;
    let failed = 0;
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(sub.subscription as webpush.PushSubscription, JSON.stringify(message), {
          vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 60 * 60,
          urgency: 'high'
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.store.deletePushSubscription(sub.endpoint);
      }
    }));
    return { sent, failed };
  }
}
