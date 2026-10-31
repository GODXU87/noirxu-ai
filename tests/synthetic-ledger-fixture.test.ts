import { expect, it } from 'vitest';
import { LEDGER_OCTOBER } from './helpers/chat-hub';

it('uses the deliberately invented six-thousand expense scenario', () => {
  expect(LEDGER_OCTOBER.summary.expense === 6000).toBe(true);
  expect(LEDGER_OCTOBER.summary.income === 15000).toBe(true);
  expect(LEDGER_OCTOBER.expense_by_category.map(c => c.amount).join(',') === '3600,2400').toBe(true);
});

it('keeps the invented aggregates internally consistent and both watch branches covered', () => {
  const { summary: s, expense_by_category: categories, comparison: c } = LEDGER_OCTOBER;
  expect(s.netFlow).toBe(s.income - s.expense);
  // Four invented expenses fall on four distinct days, matching ledger-engine semantics.
  expect(s.averageDailyExpense).toBe(s.expense / 4);
  expect(categories.reduce((n, row) => n + row.amount, 0)).toBe(s.expense);
  expect(categories.reduce((n, row) => n + row.percentage, 0)).toBe(100);
  expect(s.expense > 3000 && categories[0].amount < 5000).toBe(true);
  expect(c.income.current).toBe(s.income);
  expect(c.expense.current).toBe(s.expense);
  expect(c.netFlow.current).toBe(s.netFlow);
});
