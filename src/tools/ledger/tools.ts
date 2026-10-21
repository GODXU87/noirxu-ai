import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { SourceLink, ToolDefinition } from '@/hub/types';
import { mapSupabaseError, type SupabaseUserConnection } from '@/connections/supabase-user';
import { monthRange, shiftMonth, taipeiDate } from '@/lib/dates';
import { budgetProgress, categoryBreakdown, largestExpense, monthlyComparison, summarizeTransactions } from '@/vendor/ledger/ledger-engine.mjs';
import {
  analyticsOutput, budgetSummaryOutput, categoriesListInput, categoriesListOutput, expenseCreateInput, incomeCreateInput,
  monthInput, transactionCreateOutput, transactionsListInput, transactionsListOutput
} from './schemas';

export interface LedgerDeps {
  connection: SupabaseUserConnection;
  appUrl: string | null;
}

interface CategoryRow { id: string; type: 'expense' | 'income'; name: string; icon: string | null; color: string | null }
interface TransactionRow {
  id: string; type: 'expense' | 'income'; amount: number | string; category_id: string; occurred_on: string;
  merchant: string | null; payment_method: string | null; note: string | null; created_at: string | null; client_request_id?: string | null;
}

const TX_COLUMNS = 'id,type,amount,category_id,occurred_on,merchant,payment_method,note,created_at';
const PAGE = 1000;

async function loadCategories(client: SupabaseClient): Promise<CategoryRow[]> {
  const { data, error } = await client.from('ledger_categories').select('id,type,name,icon,color')
    .eq('is_archived', false).order('type').order('sort_order');
  if (error) throw mapSupabaseError(error, 'read');
  return (data ?? []) as CategoryRow[];
}

async function loadCurrency(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.from('ledger_profiles').select('currency').maybeSingle();
  if (error) throw mapSupabaseError(error, 'read');
  return String((data as { currency?: string } | null)?.currency || 'TWD');
}

async function loadTransactions(client: SupabaseClient, filter: { from?: string; to?: string; type?: string }): Promise<TransactionRow[]> {
  const rows: TransactionRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let query = client.from('ledger_transactions').select(TX_COLUMNS);
    if (filter.from) query = query.gte('occurred_on', filter.from);
    if (filter.to) query = query.lte('occurred_on', filter.to);
    if (filter.type) query = query.eq('type', filter.type);
    const { data, error } = await query.order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).range(offset, offset + PAGE - 1);
    if (error) throw mapSupabaseError(error, 'read');
    rows.push(...((data ?? []) as TransactionRow[]));
    if (!data || data.length < PAGE) return rows;
  }
}

function present(row: TransactionRow, categories: Map<string, CategoryRow>) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category_id: row.category_id,
    category_name: categories.get(row.category_id)?.name ?? '未分類',
    occurred_on: row.occurred_on,
    merchant: row.merchant ?? '',
    payment_method: row.payment_method ?? '',
    note: row.note ?? '',
    created_at: row.created_at
  };
}

function ledgerLinks(appUrl: string | null, label = '在 NOIRXU Ledger 查看'): SourceLink[] {
  return appUrl ? [{ label, url: appUrl }] : [];
}

function createTool(type: 'expense' | 'income', deps: LedgerDeps): ToolDefinition {
  const input = type === 'expense' ? expenseCreateInput : incomeCreateInput;
  const label = type === 'expense' ? '支出' : '收入';

  async function checkInput(client: SupabaseClient, value: z.output<typeof input>, today: string) {
    if (value.occurred_on > today) throw new ToolError('INVALID_INPUT', 'Ledger 不允許記錄未來日期。');
    const category = (await loadCategories(client)).find(item => item.id === value.category_id);
    if (!category || category.type !== type) throw new ToolError('INVALID_INPUT', `分類不存在或不是${label}分類，請先用 ledger.categories.list 選擇。`);
    return category;
  }

  return defineTool({
    name: `ledger.${type}.create`,
    description: `在 NOIRXU Ledger 新增一筆${label}。金額、日期、分類、付款方式都必須來自使用者；缺少時先詢問，不可推測。需要使用者確認後才會寫入。`,
    connection: 'ledger',
    kind: 'write',
    input,
    output: transactionCreateOutput,
    async preview(value, ctx) {
      const { client } = await deps.connection.client(ctx.userId);
      const category = await checkInput(client, value, taipeiDate(ctx.now()));
      const currency = await loadCurrency(client);
      return {
        title: `新增 Ledger ${label}`,
        fields: [
          { label: '金額', value: `${currency} ${value.amount.toLocaleString('en-US')}` },
          { label: '日期', value: value.occurred_on },
          { label: '分類', value: category.name },
          { label: '付款方式', value: value.payment_method },
          { label: type === 'expense' ? '店家' : '來源', value: value.merchant || '—' },
          { label: '備註', value: value.note || '—' }
        ],
        warnings: value.payment_method === '信用卡' && type === 'expense' ? ['信用卡支出會同時計入 Ledger 的信用卡待繳。'] : undefined
      };
    },
    async run(value, ctx, meta) {
      const { client } = await deps.connection.client(ctx.userId);
      await checkInput(client, value, taipeiDate(ctx.now()));
      // Same RPC and arguments the Ledger web app uses (app/lib/ledger-repository.mjs#saveTransaction).
      const { data, error } = await client.rpc('ledger_save_transaction_v084', {
        p_id: null,
        p_type: type,
        p_amount: value.amount,
        p_category_id: value.category_id,
        p_occurred_on: value.occurred_on,
        p_merchant: value.merchant,
        p_payment_method: value.payment_method,
        p_note: value.note,
        p_cash_account_id: value.cash_account_id ?? null,
        p_client_request_id: meta.idempotencyKey
      });
      if (error) throw mapSupabaseError(error, 'write');
      const row = (Array.isArray(data) ? data[0] : data) as TransactionRow | null;
      if (!row?.id) throw new ToolError('OUTCOME_UNKNOWN', 'Ledger 沒有回傳紀錄 ID，請到 Ledger 確認是否已建立。');
      return {
        data: {
          id: row.id, type: row.type, amount: Number(row.amount), occurred_on: row.occurred_on, category_id: row.category_id,
          payment_method: row.payment_method ?? '', merchant: row.merchant ?? '', note: row.note ?? '', client_request_id: row.client_request_id ?? null
        },
        recordId: row.id,
        links: ledgerLinks(deps.appUrl, `在 Ledger 查看 ${row.occurred_on} 的紀錄`)
      };
    }
  });
}

export function ledgerTools(deps: LedgerDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'ledger.categories.list',
      description: '列出使用者在 NOIRXU Ledger 的分類（含 id）。新增收支前用來取得正確的 category_id。',
      connection: 'ledger',
      kind: 'read',
      input: categoriesListInput,
      output: categoriesListOutput,
      async run(value, ctx) {
        const { client } = await deps.connection.client(ctx.userId);
        const categories = (await loadCategories(client)).filter(item => !value.type || item.type === value.type);
        if (!categories.length) throw new ToolError('NOT_FOUND', 'Ledger 帳戶還沒有分類，請先開啟一次 NOIRXU Ledger 完成初始化。');
        return { data: { categories }, links: ledgerLinks(deps.appUrl) };
      }
    }),
    defineTool({
      name: 'ledger.transactions.list',
      description: '查詢 NOIRXU Ledger 的收支紀錄，可依日期範圍、月份、收支類型篩選。',
      connection: 'ledger',
      kind: 'read',
      input: transactionsListInput,
      output: transactionsListOutput,
      async run(value, ctx) {
        const { client } = await deps.connection.client(ctx.userId);
        const range = value.month ? monthRange(value.month) : { from: value.from, to: value.to };
        const [categories, rows, currency] = await Promise.all([
          loadCategories(client), loadTransactions(client, { ...range, type: value.type }), loadCurrency(client)
        ]);
        const byId = new Map(categories.map(item => [item.id, item]));
        return {
          data: {
            currency,
            range: { from: range.from ?? null, to: range.to ?? null },
            total_matching: rows.length,
            transactions: rows.slice(0, value.limit).map(row => present(row, byId))
          },
          links: ledgerLinks(deps.appUrl)
        };
      }
    }),
    createTool('expense', deps),
    createTool('income', deps),
    defineTool({
      name: 'ledger.budget.summary',
      description: '取得 NOIRXU Ledger 某月份的預算使用狀況（總預算與各分類），計算方式與 Ledger 網站相同。',
      connection: 'ledger',
      kind: 'read',
      input: monthInput,
      output: budgetSummaryOutput,
      async run(value, ctx) {
        const { client } = await deps.connection.client(ctx.userId);
        const { data: budgets, error } = await client.from('ledger_budgets').select('id,category_id,amount,month_start');
        if (error) throw mapSupabaseError(error, 'read');
        const [categories, rows, currency] = await Promise.all([
          loadCategories(client), loadTransactions(client, { ...monthRange(value.month), type: 'expense' }), loadCurrency(client)
        ]);
        const progress = budgetProgress(budgets ?? [], rows, value.month, categories);
        return {
          data: {
            month: value.month,
            currency,
            total: { limit: progress.total.limit, spent: progress.total.spent, remaining: progress.total.remaining, percentage: progress.total.percentage, status: progress.total.status as 'unset' | 'safe' | 'warning' | 'over' },
            categories: progress.categories.map((item: Record<string, unknown>) => ({
              categoryId: String(item.categoryId), name: String(item.name), limit: Number(item.limit), spent: Number(item.spent),
              remaining: Number(item.remaining), percentage: Number(item.percentage), status: item.status as 'unset' | 'safe' | 'warning' | 'over'
            }))
          },
          links: ledgerLinks(deps.appUrl)
        };
      }
    }),
    defineTool({
      name: 'ledger.analytics.get',
      description: '取得 NOIRXU Ledger 某月份的收支分析：總收入/支出、各分類支出排行、與上月比較、最大筆支出。',
      connection: 'ledger',
      kind: 'read',
      input: monthInput,
      output: analyticsOutput,
      async run(value, ctx) {
        const { client } = await deps.connection.client(ctx.userId);
        const previous = shiftMonth(value.month, -1);
        const [categories, rows, currency] = await Promise.all([
          loadCategories(client),
          loadTransactions(client, { from: monthRange(previous).from, to: monthRange(value.month).to }),
          loadCurrency(client)
        ]);
        const current = rows.filter(row => row.occurred_on.startsWith(value.month));
        const byId = new Map(categories.map(item => [item.id, item]));
        const largest = largestExpense(current) as TransactionRow | null;
        return {
          data: {
            month: value.month,
            currency,
            summary: summarizeTransactions(current),
            expense_by_category: categoryBreakdown(current, categories, 'expense').map((item: Record<string, unknown>) => ({
              id: (item.id as string | null) ?? null, name: String(item.name), amount: Number(item.amount), percentage: Number(item.percentage)
            })),
            comparison: monthlyComparison(rows, value.month),
            largest_expense: largest ? present(largest, byId) : null
          },
          links: ledgerLinks(deps.appUrl)
        };
      }
    })
  ];
}
