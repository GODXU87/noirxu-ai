import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { CredentialStore, MemoryCredentialBackend, type CredentialBackend } from '@/connections/credentials';
import { SupabaseUserConnection } from '@/connections/supabase-user';
import { TokenVault } from '@/connections/vault';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore, type HubStore } from '@/hub/store';
import { SupabaseCredentialBackend, SupabaseHubStore } from '@/hub/supabase-store';
import type { ConnectionId } from '@/hub/types';
import { GmailService } from '@/tools/gmail/google';
import { gmailTools } from '@/tools/gmail/tools';
import { journalTools } from '@/tools/journal/tools';
import { ledgerTools } from '@/tools/ledger/tools';
import { RadarClient, radarTools } from '@/tools/radar/tools';
import { loadConfig, type AppConfig } from './config';

export interface Hub {
  config: AppConfig;
  storageMode: 'database' | 'memory';
  registry: ToolRegistry;
  executor: Executor;
  ledger: SupabaseUserConnection;
  journal: SupabaseUserConnection;
  radar: RadarClient;
  gmail: GmailService;
  isConnected: (userId: string, connection: ConnectionId) => Promise<boolean>;
}

function build(): Hub {
  const config = loadConfig();
  let store: HubStore;
  let backend: CredentialBackend;
  let storageMode: Hub['storageMode'];

  if (config.hubDatabase) {
    const db = createClient(config.hubDatabase.url, config.hubDatabase.key, { auth: { persistSession: false, autoRefreshToken: false } });
    store = new SupabaseHubStore(db);
    backend = new SupabaseCredentialBackend(db);
    storageMode = 'database';
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('NOIRXU_AI_SUPABASE_URL / NOIRXU_AI_SUPABASE_SECRET_KEY are required in production');
  } else {
    store = new MemoryHubStore();
    backend = new MemoryCredentialBackend();
    storageMode = 'memory';
  }

  const credentials = new CredentialStore(backend, new TokenVault(config.tokenEncryptionKey ?? undefined));
  const ledger = new SupabaseUserConnection('ledger', config.ledger.supabase, credentials);
  const journal = new SupabaseUserConnection('journal', config.journal.supabase, credentials);
  const radar = new RadarClient(config.radar);
  const gmail = new GmailService(config.google, credentials);

  const registry = new ToolRegistry();
  for (const tool of [
    ...ledgerTools({ connection: ledger, appUrl: config.ledger.appUrl }),
    ...journalTools({ connection: journal, appUrl: config.journal.appUrl }),
    ...radarTools(radar),
    ...gmailTools(gmail)
  ]) registry.register(tool);

  const isConnected = async (userId: string, connection: ConnectionId) => {
    switch (connection) {
      case 'ledger': return ledger.isConnected(userId);
      case 'journal': return journal.isConnected(userId);
      case 'radar': return radar.configured;
      case 'gmail': return gmail.configured && Boolean(await gmail.connection(userId));
    }
  };

  return { config, storageMode, registry, executor: new Executor({ registry, store, isConnected }), ledger, journal, radar, gmail, isConnected };
}

const globalHub = globalThis as unknown as { __noirxuHub?: Hub };

export function getHub(): Hub {
  globalHub.__noirxuHub ??= build();
  return globalHub.__noirxuHub;
}
