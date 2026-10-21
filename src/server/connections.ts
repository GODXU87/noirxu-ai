import 'server-only';
import { ToolError } from '@/hub/errors';
import { CONNECTION_IDS, type ConnectionId, type ToolContext } from '@/hub/types';
import { GMAIL_SCOPES } from '@/tools/gmail/google';
import type { Hub } from './hub';

export interface ConnectionStatus {
  id: ConnectionId;
  name: string;
  configured: boolean;
  connected: boolean;
  account: string | null;
  tools: Array<{ name: string; kind: string }>;
  grants?: { read: boolean; send: boolean };
  setupHint: string | null;
}

const NAMES: Record<ConnectionId, string> = { ledger: 'NOIRXU Ledger', journal: 'NOIRXU Trading Journal', radar: 'NOIRXU RADAR', gmail: 'Gmail' };
const SETUP: Record<ConnectionId, string> = {
  ledger: '需要伺服器環境變數 LEDGER_SUPABASE_URL、LEDGER_SUPABASE_ANON_KEY（Ledger 的公開 anon key）。',
  journal: '需要伺服器環境變數 JOURNAL_SUPABASE_URL、JOURNAL_SUPABASE_ANON_KEY（Journal 的公開 anon key）。',
  radar: '需要 RADAR 部署整合 API（feature/ai-integration-api），並在兩邊設定同一組 RADAR_INTEGRATION_TOKEN；NOIRXU AI 另需 RADAR_INTEGRATION_URL。',
  gmail: '需要 Google Cloud OAuth 用戶端：GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET、GOOGLE_OAUTH_REDIRECT_URI。'
};

export function assertConnectionId(value: string): ConnectionId {
  if (!(CONNECTION_IDS as readonly string[]).includes(value)) throw new ToolError('NOT_FOUND', '沒有這個連線。');
  return value as ConnectionId;
}

export async function connectionStatuses(hub: Hub, userId: string): Promise<ConnectionStatus[]> {
  const tools = (id: ConnectionId) => hub.registry.list().filter(tool => tool.connection === id).map(tool => ({ name: tool.name, kind: tool.kind }));
  const account = async (id: 'ledger' | 'journal') => {
    const connection = hub[id];
    return (await connection.isConnected(userId)) ? 'connected' : null;
  };
  const gmail = await hub.gmail.connection(userId);
  const configured: Record<ConnectionId, boolean> = { ledger: hub.ledger.configured, journal: hub.journal.configured, radar: hub.radar.configured, gmail: hub.gmail.configured };
  return Promise.all(CONNECTION_IDS.map(async id => ({
    id,
    name: NAMES[id],
    configured: configured[id],
    connected: await hub.isConnected(userId, id),
    account: id === 'gmail' ? gmail?.email ?? null : id === 'radar' ? null : await account(id),
    tools: tools(id),
    ...(id === 'gmail' ? { grants: { read: Boolean(gmail?.scopes.includes(GMAIL_SCOPES.read)), send: Boolean(gmail?.scopes.includes(GMAIL_SCOPES.send)) } } : {}),
    setupHint: configured[id] ? null : SETUP[id]
  })));
}

/** Runs one harmless read through the normal executor path, so the test exercises auth and RLS for real. */
export async function testConnection(hub: Hub, id: ConnectionId, ctx: ToolContext) {
  const probe: Record<ConnectionId, [string, unknown]> = {
    ledger: ['ledger.categories.list', {}],
    journal: ['journal.trades.list', { limit: 1 }],
    radar: ['radar.status', {}],
    gmail: ['gmail.messages.search', { query: 'in:inbox', max_results: 1 }]
  };
  const [tool, input] = probe[id];
  const result = await hub.executor.invoke(tool, input, ctx);
  if (result.status === 'ok') {
    const tradeDate = id === 'radar' ? (result.data as { publication?: { trade_date?: string } }).publication?.trade_date ?? null : null;
    return { ok: true, tool, tradeDate };
  }
  return { ok: false, tool, code: result.status === 'error' ? result.code : 'INTERNAL', message: result.status === 'error' ? result.message : '' };
}
