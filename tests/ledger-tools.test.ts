import { describe, expect, it } from 'vitest';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { ledgerTools } from '@/tools/ledger/tools';
import { FakeSupabase, fakeConnection } from './helpers/fake-supabase';

// Test fixtures only.
const FOOD = '11111111-1111-4111-8111-111111111111';
const TRANSPORT = '22222222-2222-4222-8222-222222222222';
const SALARY = '33333333-3333-4333-8333-333333333333';

function fixtures() {
  return new FakeSupabase({
    ledger_categories: [
      { id: FOOD, type: 'expense', name: '餐飲', icon: '', color: '', is_archived: false, sort_order: 1 },
      { id: TRANSPORT, type: 'expense', name: '交通', icon: '', color: '', is_archived: false, sort_order: 2 },
      { id: SALARY, type: 'income', name: '薪資', icon: '', color: '', is_archived: false, sort_order: 1 }
    ],
    ledger_profiles: [{ currency: 'TWD' }],
    ledger_budgets: [
      { id: 'b-total', category_id: null, amount: 1000, month_start: '2026-10-01' },
      { id: 'b-food', category_id: FOOD, amount: 400, month_start: '2026-10-01' }
    ],
    ledger_transactions: [
      { id: 't1', type: 'expense', amount: 350, category_id: FOOD, occurred_on: '2026-10-03', merchant: 'A', payment_method: '現金', note: '', created_at: '2026-10-03T01:00:00Z' },
      { id: 't2', type: 'expense', amount: 120, category_id: TRANSPORT, occurred_on: '2026-10-05', merchant: 'B', payment_method: '悠遊卡', note: '', created_at: '2026-10-05T01:00:00Z' },
      { id: 't3', type: 'income', amount: 50000, category_id: SALARY, occurred_on: '2026-10-05', merchant: '', payment_method: '轉帳', note: '', created_at: '2026-10-05T02:00:00Z' },
      { id: 't0', type: 'expense', amount: 200, category_id: FOOD, occurred_on: '2026-09-20', merchant: 'C', payment_method: '現金', note: '', created_at: '2026-09-20T01:00:00Z' }
    ]
  });
}

function setup(db = fixtures()) {
  const registry = new ToolRegistry();
  ledgerTools({ connection: fakeConnection(db), appUrl: 'https://ledger.noirxu.com' }).forEach(tool => registry.register(tool));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
  // 2026-10-21 12:00 Taipei
  const ctx = { userId: 'owner', now: () => new Date('2026-10-21T04:00:00Z') };
  return { db, executor, ctx };
}

describe('ledger.expense.create', () => {
  it('goes through the confirmation flow and calls the same RPC as the Ledger site with the proposal idempotency key', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.ledger_save_transaction_v084 = args => ({
      data: { id: 'new-tx', type: args.p_type, amount: args.p_amount, category_id: args.p_category_id, occurred_on: args.p_occurred_on, merchant: args.p_merchant, payment_method: args.p_payment_method, note: args.p_note, client_request_id: args.p_client_request_id },
      error: null
    });
    const proposal = await executor.invoke('ledger.expense.create', { amount: 150, category_id: FOOD, occurred_on: '2026-10-21', payment_method: '現金', merchant: '午餐' }, ctx);
    expect(proposal.status).toBe('confirmation_required');
    expect(db.rpcCalls).toHaveLength(0);
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    expect(proposal.preview.fields).toContainEqual({ label: '分類', value: '餐飲' });
    expect(proposal.preview.fields).toContainEqual({ label: '金額', value: 'TWD 150' });

    const result = await executor.confirm(proposal.proposalId, ctx);
    expect(result).toMatchObject({ status: 'succeeded', recordId: 'new-tx' });
    expect(db.rpcCalls).toHaveLength(1);
    const call = db.rpcCalls[0];
    expect(call.name).toBe('ledger_save_transaction_v084');
    expect(call.args).toMatchObject({ p_id: null, p_type: 'expense', p_amount: 150, p_category_id: FOOD, p_occurred_on: '2026-10-21', p_payment_method: '現金', p_cash_account_id: null });
    expect(call.args.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses future dates (Asia/Taipei), like the Ledger UI', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.expense.create', { amount: 1, category_id: FOOD, occurred_on: '2026-10-22', payment_method: '現金' }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('refuses an income category for an expense', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.expense.create', { amount: 1, category_id: SALARY, occurred_on: '2026-10-21', payment_method: '現金' }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('refuses payment methods Ledger does not offer', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.expense.create', { amount: 1, category_id: FOOD, occurred_on: '2026-10-21', payment_method: '比特幣' }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('requires an amount (no guessing)', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.expense.create', { category_id: FOOD, occurred_on: '2026-10-21', payment_method: '現金' }, ctx);
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('reports a Ledger rejection as a failure', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.ledger_save_transaction_v084 = () => ({ data: null, error: { code: '23503', message: 'INVALID_TRANSACTION_CATEGORY' } });
    const proposal = await executor.invoke('ledger.expense.create', { amount: 1, category_id: FOOD, occurred_on: '2026-10-21', payment_method: '現金' }, ctx);
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    expect(await executor.confirm(proposal.proposalId, ctx)).toMatchObject({ status: 'failed', code: 'UPSTREAM_REJECTED', message: 'INVALID_TRANSACTION_CATEGORY' });
  });

  it('a network failure during the write becomes outcome_unknown, not success or a silent retry', async () => {
    const { db, executor, ctx } = setup();
    db.rpcHandlers.ledger_save_transaction_v084 = () => ({ data: null, error: { message: 'TypeError: fetch failed' } });
    const proposal = await executor.invoke('ledger.expense.create', { amount: 1, category_id: FOOD, occurred_on: '2026-10-21', payment_method: '現金' }, ctx);
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    expect(await executor.confirm(proposal.proposalId, ctx)).toMatchObject({ status: 'outcome_unknown' });
  });
});

describe('ledger read tools', () => {
  it('analytics matches the Ledger engine (month totals, category ranking, vs last month)', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.analytics.get', { month: '2026-10' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    const data = result.data as any;
    expect(data.summary).toMatchObject({ income: 50000, expense: 470, netFlow: 49530 });
    expect(data.expense_by_category.map((row: any) => [row.name, row.amount])).toEqual([['餐飲', 350], ['交通', 120]]);
    expect(data.comparison.expense).toMatchObject({ current: 470, previous: 200, change: 135 });
    expect(data.largest_expense).toMatchObject({ id: 't1', category_name: '餐飲' });
  });

  it('budget summary uses the Ledger thresholds', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.budget.summary', { month: '2026-10' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    const data = result.data as any;
    expect(data.total).toMatchObject({ limit: 1000, spent: 470, status: 'safe' });
    expect(data.categories[0]).toMatchObject({ name: '餐飲', spent: 350, percentage: 87.5, status: 'warning' });
  });

  it('lists transactions for a month with category names', async () => {
    const { executor, ctx } = setup();
    const result = await executor.invoke('ledger.transactions.list', { month: '2026-10', type: 'expense' }, ctx);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect((result.data as any).transactions.map((row: any) => row.id)).toEqual(['t2', 't1']);
    expect(result.links[0].url).toBe('https://ledger.noirxu.com');
  });

  it('read failures are reported as errors', async () => {
    const db = fixtures();
    db.tableErrors.ledger_transactions = { code: '42501', message: 'permission denied' };
    const { executor, ctx } = setup(db);
    expect(await executor.invoke('ledger.transactions.list', { month: '2026-10' }, ctx)).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
  });
});
