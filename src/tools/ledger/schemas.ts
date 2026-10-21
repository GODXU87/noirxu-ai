import { z } from 'zod';
import { isCalendarDate } from '@/lib/dates';

// Values copied from noirxu-ledger app/lib/constants.js @ aa906bb.
export const EXPENSE_PAYMENT_METHODS = ['信用卡', '現金', '轉帳', 'LINE Pay', 'Apple Pay', '悠遊卡'] as const;
export const INCOME_PAYMENT_METHODS = ['轉帳', '現金', 'LINE Pay', '其他'] as const;

const calendarDate = z.string().refine(isCalendarDate, '日期需為 YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份需為 YYYY-MM');
const uuid = z.uuid();

export const ledgerCategory = z.object({
  id: z.string(),
  type: z.enum(['expense', 'income']),
  name: z.string(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional()
});

export const ledgerTransaction = z.object({
  id: z.string(),
  type: z.enum(['expense', 'income']),
  amount: z.number(),
  category_id: z.string(),
  category_name: z.string(),
  occurred_on: z.string(),
  merchant: z.string(),
  payment_method: z.string(),
  note: z.string(),
  created_at: z.string().nullable()
});

export const categoriesListInput = z.object({
  type: z.enum(['expense', 'income']).optional().describe('只列出支出或收入分類')
}).strict();
export const categoriesListOutput = z.object({ categories: z.array(ledgerCategory) });

export const transactionsListInput = z.object({
  from: calendarDate.optional().describe('起始日期（含），YYYY-MM-DD'),
  to: calendarDate.optional().describe('結束日期（含），YYYY-MM-DD'),
  month: month.optional().describe('整個月份，YYYY-MM；與 from/to 擇一'),
  type: z.enum(['expense', 'income']).optional(),
  limit: z.number().int().min(1).max(500).default(100)
}).strict().refine(value => !(value.month && (value.from || value.to)), 'month 與 from/to 只能擇一');
export const transactionsListOutput = z.object({
  currency: z.string(),
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  total_matching: z.number(),
  transactions: z.array(ledgerTransaction)
});

function createInput(methods: readonly [string, ...string[]]) {
  return z.object({
    amount: z.number().positive().describe('使用者明確說出的金額，不可推測'),
    category_id: uuid.describe('從 ledger.categories.list 取得的分類 id'),
    occurred_on: calendarDate.describe('發生日期（台北時間），YYYY-MM-DD'),
    payment_method: z.enum(methods).describe('付款方式'),
    merchant: z.string().trim().max(80).default('').describe('店家或來源'),
    note: z.string().trim().max(200).default(''),
    cash_account_id: uuid.optional().describe('連動的現金帳戶 id（選填）')
  }).strict();
}

export const expenseCreateInput = createInput(EXPENSE_PAYMENT_METHODS);
export const incomeCreateInput = createInput(INCOME_PAYMENT_METHODS);
export const transactionCreateOutput = z.object({
  id: z.string(),
  type: z.enum(['expense', 'income']),
  amount: z.number(),
  occurred_on: z.string(),
  category_id: z.string(),
  payment_method: z.string(),
  merchant: z.string(),
  note: z.string(),
  client_request_id: z.string().nullable()
});

export const monthInput = z.object({ month: month.describe('YYYY-MM；使用者說「這個月」時為台北時間當月') }).strict();

const progressItem = z.object({
  limit: z.number(),
  spent: z.number(),
  remaining: z.number(),
  percentage: z.number(),
  status: z.enum(['unset', 'safe', 'warning', 'over'])
});
export const budgetSummaryOutput = z.object({
  month: z.string(),
  currency: z.string(),
  total: progressItem,
  categories: z.array(progressItem.extend({ categoryId: z.string(), name: z.string() }))
});

export const analyticsOutput = z.object({
  month: z.string(),
  currency: z.string(),
  summary: z.object({
    income: z.number(),
    expense: z.number(),
    netFlow: z.number(),
    transactionCount: z.number(),
    expenseCount: z.number(),
    averageDailyExpense: z.number()
  }),
  expense_by_category: z.array(z.object({ id: z.string().nullable(), name: z.string(), amount: z.number(), percentage: z.number() })),
  comparison: z.object({
    previousMonth: z.string(),
    income: z.object({ current: z.number(), previous: z.number(), change: z.number().nullable() }),
    expense: z.object({ current: z.number(), previous: z.number(), change: z.number().nullable() }),
    netFlow: z.object({ current: z.number(), previous: z.number(), change: z.number().nullable() })
  }),
  largest_expense: ledgerTransaction.nullable()
});
