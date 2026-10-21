import { describe, expect, it } from 'vitest';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { journalTools } from '@/tools/journal/tools';
import { FakeSupabase, fakeConnection } from './helpers/fake-supabase';

// Test fixtures only.
const OPEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixtures() {
  return new FakeSupabase({
    journal_positions: [
      { id: 'p-win', user_id: 'user-1', market: 'TW', symbol: '2330', side: 'LONG', currency: 'TWD', trade_type: 'SWING', strategy: '突破', created_at: '2026-10-01T01:00:00Z' },
      { id: 'p-loss', user_id: 'user-1', market: 'US', symbol: 'AAPL', side: 'LONG', currency: 'USD', trade_type: 'SWING', strategy: '回檔', created_at: '2026-10-02T01:00:00Z' },
      { id: OPEN_ID, user_id: 'user-1', market: 'TW', symbol: '2317', side: 'LONG', currency: 'TWD', trade_type: 'SWING', strategy: null, created_at: '2026-10-10T01:00:00Z' }
    ],
    journal_executions: [
      { id: 'e1', user_id: 'user-1', position_id: 'p-win', kind: 'ENTRY', quantity: 1000, price: 1000, fee: 0, tax: 0, executed_at: '2026-10-01', execution_sequence: 1, created_at: '2026-10-01T01:00:00Z' },
      { id: 'e2', user_id: 'user-1', position_id: 'p-win', kind: 'EXIT', quantity: 1000, price: 1050, fee: 0, tax: 0, executed_at: '2026-10-08', execution_sequence: 2, created_at: '2026-10-08T01:00:00Z' },
      { id: 'e3', user_id: 'user-1', position_id: 'p-loss', kind: 'ENTRY', quantity: 10, price: 200, fee: 0, tax: 0, executed_at: '2026-10-02', execution_sequence: 1, created_at: '2026-10-02T01:00:00Z' },
      { id: 'e4', user_id: 'user-1', position_id: 'p-loss', kind: 'EXIT', quantity: 10, price: 190, fee: 0, tax: 0, executed_at: '2026-10-09', execution_sequence: 2, created_at: '2026-10-09T01:00:00Z' },
      { id: 'e5', user_id: 'user-1', position_id: OPEN_ID, kind: 'ENTRY', quantity: 2000, price: 100, fee: 0, tax: 0, executed_at: '2026-10-10', execution_sequence: 1, created_at: '2026-10-10T01:00:00Z' }
    ]
  });
}

function setup(db = fixtures()) {
  db.rpcHandlers.journal_get_my_entitlements = () => ({ data: { position_limit: 100 }, error: null });
  const registry = new ToolRegistry();
  journalTools({ connection: fakeConnection(db), appUrl: 'https://journal.example.test' }).forEach(tool => registry.register(tool));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
  const ctx = { userId: 'owner', now: () => new Date('2026-10-21T04:00:00Z') };
  return { db, executor, ctx };
}

const buy = {
  status: 'OPEN', market: 'TW', symbol: '2454', currency: 'TWD', side: 'LONG', trade_type: 'SWING',
  quantity: 1, quantity_unit: 'LOT', entry_price: 1200, entry_date: '2026-10-21', entry_fee: 1710, entry_tax: 0
};

describe('journal.trade.create', () => {
  it('creates an open position through the same RPC as the Journal site, only after confirmation', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.journal_create_open_position_with_playbook_v1 = () => ({ data: 'new-position', error: null });
    const proposal = await executor.invoke('journal.trade.create', buy, ctx);
    expect(proposal.status).toBe('confirmation_required');
    expect(db.rpcCalls.map(call => call.name)).not.toContain('journal_create_open_position_with_playbook_v1');
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    expect(proposal.preview.warnings).toContain('這只是交易紀錄，不會下單。');

    expect(await executor.confirm(proposal.proposalId, ctx)).toMatchObject({ status: 'succeeded', recordId: 'new-position' });
    const call = db.rpcCalls.find(c => c.name === 'journal_create_open_position_with_playbook_v1')!;
    // 1 張 = 1000 股, same conversion as trading-engine.js actualQuantity.
    expect(call.args).toMatchObject({ p_market: 'TW', p_symbol: '2454', p_quantity: 1000, p_quantity_display: 1, p_quantity_unit: 'LOT', p_price: 1200, p_executed_at: '2026-10-21', p_fee: 1710, p_tax: 0 });
    expect(call.args.p_executed_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('asks the user to decide when the same symbol is already open', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('journal.trade.create', { ...buy, symbol: '2317' }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'NEEDS_USER_DECISION' });
  });

  it('adds to an existing position when the user chose it', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.journal_add_entry_with_targets_v1 = () => ({ data: null, error: null });
    const proposal = await executor.invoke('journal.trade.create', { ...buy, symbol: '2317', add_to_position_id: OPEN_ID }, ctx);
    if (proposal.status !== 'confirmation_required') throw new Error(JSON.stringify(proposal));
    expect(await executor.confirm(proposal.proposalId, ctx)).toMatchObject({ status: 'succeeded', data: { action: 'added_to_position', position_id: OPEN_ID } });
  });

  it('enforces Journal input rules (odd lots < 1000, unit per market, day trades, dates)', async () => {
    const { executor, ctx } = setup();
    expect(await executor.invoke('journal.trade.create', { ...buy, quantity: 1500, quantity_unit: 'ODD_LOT' }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await executor.invoke('journal.trade.create', { ...buy, market: 'US', currency: 'USD', quantity_unit: 'LOT' }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await executor.invoke('journal.trade.create', { ...buy, trade_type: 'DAY', entry_date: '2026-10-20' }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await executor.invoke('journal.trade.create', { ...buy, entry_date: '2026-10-22' }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('requires fees and taxes to be supplied (Journal does not calculate them)', async () => {
    const { executor, ctx } = setup();
    const { entry_fee: _fee, ...withoutFee } = buy;
    expect(await executor.invoke('journal.trade.create', withoutFee, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('respects the plan position limit', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.journal_get_my_entitlements = () => ({ data: { position_limit: 3 }, error: null });
    expect(await executor.invoke('journal.trade.create', buy, ctx)).toMatchObject({ status: 'error', code: 'UPSTREAM_REJECTED' });
  });

  it('on an unknown outcome, lists possibly-created records instead of re-sending', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.journal_create_open_position_with_playbook_v1 = () => ({ data: null, error: { message: 'fetch failed' } });
    const proposal = await executor.invoke('journal.trade.create', buy, ctx);
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    const result = await executor.confirm(proposal.proposalId, ctx);
    expect(result.status).toBe('outcome_unknown');
    expect(db.rpcCalls.filter(call => call.name === 'journal_create_open_position_with_playbook_v1')).toHaveLength(1);
  });
});

describe('journal read tools', () => {
  it('performance keeps currencies separate', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('journal.performance.summary', { from: '2026-10-01', to: '2026-10-31' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    const data = result.data as any;
    const byCurrency = Object.fromEntries(data.by_currency.map((row: any) => [row.currency, row]));
    expect(byCurrency.TWD).toMatchObject({ closed_trades: 1, wins: 1, net_pnl: 50000 });
    expect(byCurrency.USD).toMatchObject({ closed_trades: 1, losses: 1, net_pnl: -100 });
    expect(data.open_positions).toBe(1);
  });

  it('statistics group by strategy', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('journal.statistics.get', { group_by: 'strategy' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect((result.data as any).groups.map((g: any) => g.key).sort()).toEqual(['回檔', '突破']);
  });

  it('lists open trades only', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('journal.trades.list', { status: 'open' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect((result.data as any).trades.map((t: any) => t.symbol)).toEqual(['2317']);
  });
});
