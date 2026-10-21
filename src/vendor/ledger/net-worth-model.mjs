function roundTwd(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 100) / 100;
}

function categoryNameMap(categories = []) {
  return new Map(categories.map(category => [category?.id, String(category?.name || '')]));
}

function dateKey(value) {
  return String(value || '').slice(0, 10);
}

function monthEnd(month) {
  const [year, monthNumber] = String(month || '').split('-').map(Number);
  if (!year || !monthNumber) return '';
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

export function eligibleCashAccounts(accounts = [], categories = []) {
  const names = categoryNameMap(categories);
  return accounts.filter(account => (
    !account?.is_archived &&
    String(account?.currency_code || 'TWD').toUpperCase() === 'TWD' &&
    names.get(account?.category_id) === '現金／銀行'
  ));
}

export function resolveDefaultCashAccount({ accounts = [], categories = [], preferredId = null } = {}) {
  const eligible = eligibleCashAccounts(accounts, categories);
  if (preferredId) {
    const preferred = eligible.find(account => account.id === preferredId);
    if (preferred) return preferred;
  }
  return eligible.length === 1 ? eligible[0] : null;
}

export function transactionFinancialPath({ type, payment_method } = {}) {
  if (type === 'expense' && String(payment_method || '').trim() === '信用卡') return 'credit_card';
  if (type === 'expense' || type === 'income') return 'cash';
  return 'none';
}

export function liabilityBalance(movements = [], cutoffDate = '') {
  const cutoff = dateKey(cutoffDate);
  return roundTwd(movements.reduce((sum, movement) => {
    if (cutoff && dateKey(movement?.occurred_on) > cutoff) return sum;
    return sum + Number(movement?.amount_twd || 0);
  }, 0));
}

export function netWorthSnapshot({ grossAssets = 0, liabilities = 0 } = {}) {
  const gross = roundTwd(grossAssets);
  const liability = roundTwd(liabilities);
  return {
    gross_assets: gross,
    liabilities: liability,
    net_worth: roundTwd(gross - liability)
  };
}

export function netWorthMonthlySeries({ assetSeries = [], liabilityMovements = [] } = {}) {
  return assetSeries.map(item => {
    const liabilities = liabilityBalance(liabilityMovements, monthEnd(item.month));
    const grossAssets = roundTwd(item.total);
    return {
      ...item,
      gross_assets: grossAssets,
      liabilities,
      total: roundTwd(grossAssets - liabilities)
    };
  });
}
