import 'server-only';
import { Pool } from 'pg';
import { CredentialStore, MemoryCredentialBackend, type CredentialBackend } from '@/connections/credentials';
import { SupabaseUserConnection } from '@/connections/supabase-user';
import { TokenVault } from '@/connections/vault';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore, type HubStore } from '@/hub/store';
import { PgCredentialBackend, PgHubStore } from '@/hub/pg-store';
import type { ConnectionId } from '@/hub/types';
import { GmailService } from '@/tools/gmail/google';
import { gmailTools } from '@/tools/gmail/tools';
import { journalTools } from '@/tools/journal/tools';
import { ledgerTools } from '@/tools/ledger/tools';
import { RadarClient, radarTools } from '@/tools/radar/tools';
import { MemoryAgendaStore, PgAgendaStore, type AgendaStore } from '@/agenda/store';
import { PushService } from '@/push/service';
import { DeliveryService } from '@/notify/delivery';
import { ProactiveNotifier } from '@/notify/policy';
import { CostGuard } from '@/cost/guard';
import type { MemorySource } from '@/router/memory';
import { agendaTools } from '@/tools/agenda/tools';
import { assistantTools } from '@/tools/assistant/tools';
import { healthTools } from '@/tools/health/tools';
import { WaterService } from '@/health/service';
import { loadFeatureFlags, type FeatureFlags } from '@/lib/features';
import { ledgerAssetTools } from '@/tools/ledger/assets';
import { taskTools } from '@/tools/tasks/tools';
import { garminTools } from '@/tools/garmin/tools';
import { GarminClient } from '@/garmin/client';
import { GarminConnectionStore, type GarminAdapter } from '@/garmin/adapter';
import { TaskService } from '@/tasks/service';
import { eveningBriefing, morningBriefing } from './tick';
import { loadConfig, type AppConfig } from './config';

export interface Hub {
  config: AppConfig;
  features: FeatureFlags;
  storageMode: 'database' | 'memory';
  registry: ToolRegistry;
  executor: Executor;
  ledger: SupabaseUserConnection;
  journal: SupabaseUserConnection;
  radar: RadarClient;
  gmail: GmailService;
  agenda: AgendaStore;
  push: PushService;
  delivery: DeliveryService;
  cost: CostGuard;
  /** Long-term memory (Phase C2) once approved; null until then. */
  memory: MemorySource | null;
  vault: TokenVault;
  water: WaterService;
  /** Background tasks (feature 'tasks'); null when the feature is off. */
  tasks: TaskService | null;
  /** Garmin Personal API client (feature 'garmin'); null when the feature is off. */
  garmin: GarminAdapter | null;
  isConnected: (userId: string, connection: ConnectionId) => Promise<boolean>;
}

/**
 * The hub must log in as the limited noirxu_ai_app role, never as postgres or another
 * broad account, so a misconfigured URL fails loudly instead of running with admin rights.
 */
export function assertLimitedDatabaseRole(url: string) {
  let user = '';
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    throw new HubConfigError('NOIRXU_AI_DATABASE_URL 格式不正確。');
  }
  if (user !== 'noirxu_ai_app' && !user.startsWith('noirxu_ai_app.')) {
    throw new HubConfigError(`NOIRXU_AI_DATABASE_URL 的使用者必須是 noirxu_ai_app（目前是 ${user.split('.')[0] || '空白'}）。請把網址裡的「postgres.」改成「noirxu_ai_app.」。`);
  }
}

export class HubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubConfigError';
  }
}

function build(): Hub {
  const config = loadConfig();
  let store: HubStore;
  let backend: CredentialBackend;
  let storageMode: Hub['storageMode'];
  let agenda: AgendaStore;

  if (config.hubDatabaseUrl) {
    assertLimitedDatabaseRole(config.hubDatabaseUrl);
    // Small pool: serverless instances each hold their own; the role is capped at 10 connections.
    const pool = new Pool({ connectionString: config.hubDatabaseUrl, max: 2, ssl: { rejectUnauthorized: false } });
    store = new PgHubStore(pool);
    backend = new PgCredentialBackend(pool);
    agenda = new PgAgendaStore(pool);
    storageMode = 'database';
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('NOIRXU_AI_DATABASE_URL is required in production');
  } else {
    store = new MemoryHubStore();
    backend = new MemoryCredentialBackend();
    agenda = new MemoryAgendaStore();
    storageMode = 'memory';
  }

  const vault = new TokenVault(config.tokenEncryptionKey ?? undefined);
  const credentials = new CredentialStore(backend, vault);
  const push = new PushService(agenda, vault);
  const delivery = new DeliveryService(agenda, vault, (userId, message, now) => push.send(userId, message, now));
  const proactiveNotifier = new ProactiveNotifier(agenda, vault, delivery);
  const water = new WaterService(agenda, vault);
  const cost = new CostGuard(agenda, vault);
  const ledger = new SupabaseUserConnection('ledger', config.ledger.supabase, credentials);
  const journal = new SupabaseUserConnection('journal', config.journal.supabase, credentials);
  const radar = new RadarClient(config.radar);
  const gmail = new GmailService(config.google, credentials);

  const features = loadFeatureFlags();
  const garmin = features.garmin ? new GarminClient(new GarminConnectionStore(agenda, vault), agenda, vault) : null;
  const registry = new ToolRegistry();
  // Assistant tools call other tools through the executor, which is created below.
  let executor: Executor | null = null;
  let hub: Hub | null = null;
  const invoke: Executor['invoke'] = (name, input, ctx) => executor!.invoke(name, input, ctx);
  const tasks = features.tasks ? new TaskService({
    store: agenda, vault, executor: { invoke }, proposals: { getProposal: id => store.getProposal(id) },
    notify: async ({ key, userId, message, now, proactive }) => {
      const expiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
      return proactive ? proactiveNotifier.notify({ key, kind: 'task', userId, message, now, expiresAt, priority: 'normal' }) : delivery.deliver({ key, kind: 'task', userId, message, now, expiresAt });
    },
    briefing: async (which, userId, now) => {
      if (which === 'evening') return eveningBriefing(hub!, userId, now);
      const brief = await morningBriefing(hub!, userId, now);
      return { ...brief, important: brief.lines.some(l => /^【(緊急|重要)】/.test(l)) };
    },
    redeliver: async (key, now) => {
      const record = await delivery.get(key);
      if (!record) return null;
      return (await delivery.deliver({ key, kind: record.kind, userId: record.user_id, message: record.message, expiresAt: new Date(record.expires_at), now })).status;
    }
  }) : null;
  for (const tool of [
    ...ledgerTools({ connection: ledger, appUrl: config.ledger.appUrl }),
    ...ledgerAssetTools({ connection: ledger, appUrl: config.ledger.appUrl }),
    ...agendaTools(agenda),
    ...journalTools({ connection: journal, appUrl: config.journal.appUrl }),
    ...radarTools(radar),
    ...gmailTools(gmail),
    ...(features.water ? healthTools(water) : []),
    ...assistantTools({ agenda, water: features.water ? water : undefined, features, isConnected: (userId, connection) => isConnected(userId, connection), invoke }),
    ...(tasks ? taskTools({ tasks, hasTool: name => Boolean(registry.get(name)) }) : []),
    ...(garmin ? garminTools(garmin) : [])
  ]) registry.register(tool);

  const isConnected = async (userId: string, connection: ConnectionId) => {
    switch (connection) {
      case 'ledger': return ledger.isConnected(userId);
      case 'journal': return journal.isConnected(userId);
      case 'radar': return radar.configured;
      case 'gmail': return gmail.configured && Boolean(await gmail.connection(userId));
    }
  };

  executor = new Executor({ registry, store, isConnected });
  hub = { config, features, storageMode, registry, executor, ledger, journal, radar, gmail, agenda, push, delivery, cost, memory: null, vault, water, tasks, garmin, isConnected };
  return hub;
}

const globalHub = globalThis as unknown as { __noirxuHub?: Hub };

export function getHub(): Hub {
  globalHub.__noirxuHub ??= build();
  return globalHub.__noirxuHub;
}
