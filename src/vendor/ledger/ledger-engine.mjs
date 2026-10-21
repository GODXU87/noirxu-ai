function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function rounded(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

export function monthKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function filterByMonth(rows = [], key) {
  return rows.filter(row => monthKey(row.occurred_on) === key);
}

function shiftMonthKey(key, delta) {
  const [year, month] = String(key || '').split('-').map(Number);
  if (!year || !month) return '';
  const date = new Date(year, month - 1 + Number(delta || 0), 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function percentChange(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before) return null;
  return rounded(((now - before) / Math.abs(before)) * 100, 1);
}

export function summarizeTransactions(rows = []) {
  let income = 0;
  let expense = 0;
  let expenseCount = 0;
  const expenseDays = new Set();

  for (const row of rows) {
    if (row.type === 'income') income += number(row.amount);
    if (row.type === 'expense') {
      expense += number(row.amount);
      expenseCount += 1;
      if (row.occurred_on) expenseDays.add(row.occurred_on);
    }
  }

  return {
    income: rounded(income, 2),
    expense: rounded(expense, 2),
    netFlow: rounded(income - expense, 2),
    transactionCount: rows.length,
    expenseCount,
    averageDailyExpense: expenseDays.size ? rounded(expense / expenseDays.size, 2) : 0
  };
}

export function categoryBreakdown(rows = [], categories = [], type = 'expense') {
  const names = new Map(categories.map(category => [category.id, category]));
  const totals = new Map();

  for (const row of rows) {
    if (row.type !== type) continue;
    totals.set(row.category_id, (totals.get(row.category_id) || 0) + number(row.amount));
  }

  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return [...totals.entries()]
    .map(([id, amount]) => {
      const category = names.get(id) || { name: '未分類', color: '#69716f', icon: '·' };
      return {
        id,
        name: category.name,
        color: category.color,
        icon: category.icon,
        amount: rounded(amount, 2),
        percentage: total ? rounded((amount / total) * 100, 1) : 0
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

export function dailySeries(rows = [], key) {
  const [year, month] = String(key || '').split('-').map(Number);
  if (!year || !month) return [];
  const days = new Date(year, month, 0).getDate();
  const result = Array.from({ length: days }, (_, index) => ({ day: index + 1, income: 0, expense: 0 }));

  for (const row of filterByMonth(rows, key)) {
    const day = Number(String(row.occurred_on || '').slice(8, 10));
    if (!result[day - 1] || !['income', 'expense'].includes(row.type)) continue;
    result[day - 1][row.type] = rounded(result[day - 1][row.type] + number(row.amount), 2);
  }
  return result;
}

function progressItem(limit, spent, extra = {}) {
  const safeLimit = number(limit);
  const safeSpent = number(spent);
  return {
    ...extra,
    limit: safeLimit,
    spent: rounded(safeSpent, 2),
    remaining: rounded(safeLimit - safeSpent, 2),
    percentage: safeLimit ? rounded((safeSpent / safeLimit) * 100, 1) : 0,
    status: !safeLimit ? 'unset' : safeSpent > safeLimit ? 'over' : safeSpent / safeLimit >= 0.8 ? 'warning' : 'safe'
  };
}

export function budgetProgress(budgets = [], rows = [], key, categories = []) {
  const monthBudgets = budgets.filter(budget => monthKey(budget.month_start) === key);
  const monthRows = filterByMonth(rows, key).filter(row => row.type === 'expense');
  const totalSpent = monthRows.reduce((sum, row) => sum + number(row.amount), 0);
  const totalBudget = monthBudgets.find(budget => !budget.category_id);
  const spentByCategory = new Map();
  for (const row of monthRows) {
    spentByCategory.set(row.category_id, (spentByCategory.get(row.category_id) || 0) + number(row.amount));
  }
  const categoryMap = new Map(categories.map(category => [category.id, category]));

  return {
    total: progressItem(totalBudget?.amount || 0, totalSpent, { id: totalBudget?.id || null }),
    categories: monthBudgets
      .filter(budget => budget.category_id)
      .map(budget => {
        const category = categoryMap.get(budget.category_id) || { name: '未分類', color: '#69716f', icon: '·' };
        return progressItem(budget.amount, spentByCategory.get(budget.category_id) || 0, {
          id: budget.id,
          categoryId: budget.category_id,
          name: category.name,
          color: category.color,
          icon: category.icon
        });
      })
      .sort((a, b) => b.percentage - a.percentage)
  };
}

export function monthlyComparison(rows = [], key) {
  const previousMonth = shiftMonthKey(key, -1);
  const current = summarizeTransactions(filterByMonth(rows, key));
  const previous = summarizeTransactions(filterByMonth(rows, previousMonth));
  return {
    previousMonth,
    income: { current: current.income, previous: previous.income, change: percentChange(current.income, previous.income) },
    expense: { current: current.expense, previous: previous.expense, change: percentChange(current.expense, previous.expense) },
    netFlow: { current: current.netFlow, previous: previous.netFlow, change: percentChange(current.netFlow, previous.netFlow) }
  };
}

export function rollingMonthSeries(rows = [], key, count = 6) {
  const length = Math.max(1, Math.min(24, Number(count) || 6));
  return Array.from({ length }, (_, index) => {
    const month = shiftMonthKey(key, index - (length - 1));
    const summary = summarizeTransactions(filterByMonth(rows, month));
    return {
      month,
      label: `${Number(month.slice(5, 7))}月`,
      income: summary.income,
      expense: summary.expense,
      netFlow: summary.netFlow
    };
  });
}

export function budgetRisk(progress = {}) {
  const risky = (progress.categories || []).filter(item => item.status === 'warning' || item.status === 'over');
  if (!risky.length) return null;
  const rank = { over: 2, warning: 1 };
  return [...risky].sort((a, b) => (rank[b.status] - rank[a.status]) || (Number(b.percentage || 0) - Number(a.percentage || 0)))[0];
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function transactionsToCsv(rows = [], categories = []) {
  const categoryMap = new Map(categories.map(category => [category.id, category.name]));
  const header = ['日期', '類型', '金額', '分類', '店家／來源', '收付款方式', '備註'];
  const body = sortTransactions(rows).map(row => [
    row.occurred_on,
    row.type === 'income' ? '收入' : '支出',
    number(row.amount),
    categoryMap.get(row.category_id) || '未分類',
    row.merchant || '',
    row.payment_method || '',
    row.note || ''
  ]);
  return `\uFEFF${[header, ...body].map(line => line.map(csvCell).join(',')).join('\n')}`;
}

export function sortTransactions(rows = []) {
  return [...rows].sort((a, b) => {
    const dateCompare = String(b.occurred_on || '').localeCompare(String(a.occurred_on || ''));
    if (dateCompare) return dateCompare;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
}

export function paymentBreakdown(rows = []) {
  const totals = new Map();
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    const name = String(row.payment_method || '未設定');
    totals.set(name, (totals.get(name) || 0) + number(row.amount));
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return [...totals.entries()]
    .map(([name, amount]) => ({ name, amount: rounded(amount, 2), percentage: total ? rounded((amount / total) * 100, 1) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

export function weekdayBreakdown(rows = []) {
  const names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const amounts = Array(7).fill(0);
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    const [year, month, day] = String(row.occurred_on || '').split('-').map(Number);
    if (!year || !month || !day) continue;
    const index = new Date(year, month - 1, day).getDay();
    amounts[index] += number(row.amount);
  }
  const total = amounts.reduce((sum, value) => sum + value, 0);
  return amounts.map((amount, dayIndex) => ({
    dayIndex,
    name: names[dayIndex],
    amount: rounded(amount, 2),
    percentage: total ? rounded((amount / total) * 100, 1) : 0
  }));
}

export function noSpendDays(rows = [], key, throughDay) {
  const series = dailySeries(rows, key);
  const end = Math.min(series.length, Math.max(0, Number(throughDay || series.length)));
  return series.slice(0, end).filter(item => item.expense === 0).length;
}

export function largestExpense(rows = []) {
  return rows
    .filter(row => row.type === 'expense')
    .reduce((largest, row) => !largest || number(row.amount) > number(largest.amount) ? row : largest, null);
}
