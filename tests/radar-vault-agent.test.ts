import { describe, expect, it, vi } from 'vitest';
import { TokenVault } from '@/connections/vault';
import { mapSupabaseError } from '@/connections/supabase-user';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { RadarClient, radarTools } from '@/tools/radar/tools';
import { ledgerTools } from '@/tools/ledger/tools';
import { FakeSupabase, fakeConnection } from './helpers/fake-supabase';

vi.mock('server-only', () => ({}));
const { claudeTools, runAgentTurn, toClaudeName } = await import('@/server/agent');

const KEY = Buffer.alloc(32, 9).toString('base64');

describe('TokenVault', () => {
  it('round-trips and binds ciphertext to its owner/connection', () => {
    const vault = new TokenVault(KEY);
    const sealed = vault.seal('refresh-token', 'owner:gmail');
    expect(sealed).not.toContain('refresh-token');
    expect(vault.open(sealed, 'owner:gmail')).toBe('refresh-token');
    expect(() => vault.open(sealed, 'other:gmail')).toThrow();
    const [v, iv, tag, body] = sealed.split('.');
    const tampered = [v, iv, tag, `${body.slice(0, -2)}AA`].join('.');
    expect(() => vault.open(tampered, 'owner:gmail')).toThrow();
  });

  it('refuses a missing or short key', () => {
    expect(() => new TokenVault('')).toThrow();
    expect(() => new TokenVault(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('mapSupabaseError', () => {
  it('treats a lost connection during a write as unknown outcome', () => {
    expect(mapSupabaseError({ message: 'TypeError: fetch failed' }, 'write').code).toBe('OUTCOME_UNKNOWN');
    expect(mapSupabaseError({ message: 'TypeError: fetch failed' }, 'read').code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapSupabaseError({ code: '28000', message: 'AUTH_REQUIRED' }, 'write').code).toBe('UNAUTHORIZED');
    expect(mapSupabaseError({ code: '22023', message: 'INVALID_TRANSACTION_AMOUNT' }, 'write').code).toBe('UPSTREAM_REJECTED');
  });
});

describe('RADAR client', () => {
  const envelope = { ok: true, publication: { trade_date: '2026-10-20', published_at: '2026-10-20T12:40:00Z' }, data: { sources: [] } };

  it('is not configured without URL and token, and never guesses data', async () => {
    const client = new RadarClient({ apiUrl: null, token: null, appUrl: null });
    expect(client.configured).toBe(false);
    await expect(client.get('/api/integration/v1/status')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('sends the bearer token and returns the publication date', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 })) as unknown as typeof fetch;
    const client = new RadarClient({ apiUrl: 'https://radar.example.test', token: 't'.repeat(40), appUrl: 'https://radar.example.test' }, fetchImpl);
    const result = await client.get('/api/integration/v1/status');
    expect(result.publication.trade_date).toBe('2026-10-20');
    const init = (fetchImpl as any).mock.calls[0][1];
    expect(init.headers.Authorization).toBe(`Bearer ${'t'.repeat(40)}`);
  });

  it('maps RADAR errors and rejects malformed payloads', async () => {
    const respond = (status: number, body: unknown) => new RadarClient({ apiUrl: 'https://r.test', token: 'x'.repeat(40), appUrl: null }, (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    await expect(respond(401, {}).get('/x')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(respond(404, {}).get('/x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(respond(200, { ok: true, data: {} }).get('/x')).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('stock analysis links to the RADAR stock page', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(envelope), { status: 200 })) as unknown as typeof fetch;
    const registry = new ToolRegistry();
    radarTools(new RadarClient({ apiUrl: 'https://radar.example.test', token: 'x'.repeat(40), appUrl: 'https://radar.example.test' }, fetchImpl)).forEach(tool => registry.register(tool));
    const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
    const result = await executor.invoke('radar.stock.analyze', { market: 'TWSE', symbol: '2330' }, { userId: 'owner', now: () => new Date() });
    expect(result).toMatchObject({ status: 'ok', links: [{ url: 'https://radar.example.test/stock/TWSE/2330' }] });
  });
});

describe('agent', () => {
  function registry() {
    const db = new FakeSupabase({
      ledger_categories: [{ id: '11111111-1111-4111-8111-111111111111', type: 'expense', name: '餐飲', is_archived: false, sort_order: 1 }],
      ledger_profiles: [{ currency: 'TWD' }]
    });
    const reg = new ToolRegistry();
    ledgerTools({ connection: fakeConnection(db), appUrl: null }).forEach(tool => reg.register(tool));
    return { reg, db };
  }

  it('exposes every tool with a Claude-valid name and an object schema', () => {
    const { reg } = registry();
    for (const tool of claudeTools(reg)) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect((tool.input_schema as any).type).toBe('object');
    }
    expect(toClaudeName('ledger.expense.create')).toBe('ledger__expense__create');
  });

  it('a write requested by the model becomes a pending proposal; nothing is written and the model is told so', async () => {
    const { reg, db } = registry();
    const executor = new Executor({ registry: reg, store: new MemoryHubStore(), isConnected: async () => true });
    const calls: any[] = [];
    const fakeClient = {
      beta: {
        messages: {
          create: vi.fn(async (params: any) => {
            calls.push(structuredClone(params.messages));
            if (calls.length === 1) {
              return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'ledger__expense__create', input: { amount: 150, category_id: '11111111-1111-4111-8111-111111111111', occurred_on: '2026-10-21', payment_method: '現金', merchant: '午餐' } }] };
            }
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: '請在確認卡片上確認。' }] };
          })
        }
      }
    };
    const turn = await runAgentTurn({
      client: fakeClient as any, model: 'claude-opus-5-5', registry: reg, executor,
      ctx: { userId: 'owner', now: () => new Date('2026-10-21T04:00:00Z') }, history: [], userText: '今天午餐 150 元，幫我記帳'
    });
    expect(turn.events[0].result.status).toBe('confirmation_required');
    expect(db.rpcCalls).toHaveLength(0);
    const toolResult = calls[1].at(-1).content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content).toContain('confirmation_required');
    expect(toolResult.content).toContain('尚未執行');
    expect(turn.reply).toBe('請在確認卡片上確認。');
    // Fallbacks and adaptive thinking are requested.
    const params = (fakeClient.beta.messages.create as any).mock.calls[0][0];
    expect(params).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, fallbacks: 'default' });
  });

  it('a tool error is passed to the model as an error', async () => {
    const { reg } = registry();
    const executor = new Executor({ registry: reg, store: new MemoryHubStore(), isConnected: async () => false });
    let second: any;
    const fakeClient = { beta: { messages: { create: vi.fn(async (params: any) => {
      if (!second && params.messages.length > 1) { second = params.messages.at(-1); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }; }
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'ledger__analytics__get', input: { month: '2026-10' } }] };
    }) } } };
    await runAgentTurn({ client: fakeClient as any, model: 'm', registry: reg, executor, ctx: { userId: 'owner', now: () => new Date() }, history: [], userText: 'q' });
    expect(second.content[0].is_error).toBe(true);
    expect(second.content[0].content).toContain('NOT_CONNECTED');
  });
});
