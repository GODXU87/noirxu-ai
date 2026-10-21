export const ASSET_CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'GBP', 'CNY', 'HKD', 'KRW', 'AUD'];

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function signedAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function dateKey(value) {
  return String(value || '').slice(0, 10);
}

function monthKey(value) {
  return dateKey(value).slice(0, 7);
}

function validMonth(value) {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(value || ''));
}

function compareValuations(a, b) {
  const day = String(a?.valued_on || '').localeCompare(String(b?.valued_on || ''));
  if (day) return day;
  return String(a?.created_at || '').localeCompare(String(b?.created_at || ''));
}

function endOfMonth(key) {
  if (!validMonth(key)) return '';
  const [year, month] = key.split('-').map(Number);
  const day = new Date(year, month, 0).getDate();
  return `${key}-${String(day).padStart(2, '0')}`;
}

function previousMonth(key) {
  if (!validMonth(key)) return '';
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, month - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(key) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, month, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function accountExistsAt(account, cutoffDate) {
  const created = dateKey(account?.created_at);
  if (created && created > cutoffDate) return false;

  const archived = dateKey(account?.archived_at);
  if (archived) return archived > cutoffDate;
  if (account?.is_archived) return false;
  return true;
}

function percentage(delta, previous) {
  if (!(previous > 0)) return null;
  return Math.round((delta / previous) * 10000) / 100;
}

function buildAllocation(rows = [], names = new Map()) {
  const grouped = new Map();
  for (const account of rows) {
    const current = grouped.get(account.category_id) || 0;
    grouped.set(account.category_id, current + signedAmount(account.amount));
  }
  const allocationBase = rows.reduce((sum, account) => sum + Math.max(0, signedAmount(account.amount)), 0);
  return [...grouped.entries()]
    .map(([id, amount]) => ({
      id,
      name: names.get(id) || '未分類',
      amount,
      percentage: allocationBase > 0 ? Math.round((Math.max(0, amount) / allocationBase) * 10000) / 100 : 0
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-Hant'));
}

export function toTwdAmount({ currency_code = 'TWD', native_amount, fx_rate_twd } = {}) {
  const native = Number(native_amount);
  if (!Number.isFinite(native) || native < 0) throw new Error('資產金額必須是 0 以上的數字。');
  const currency = String(currency_code || 'TWD').trim().toUpperCase();
  const rate = currency === 'TWD' ? 1 : Number(fx_rate_twd);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('FX 匯率必須大於 0。');
  return Math.round(native * rate * 100) / 100;
}

export function linkedAccountOptions(accounts = []) {
  return accounts.filter(account => !account?.is_archived && account?.balance_mode === 'linked' && String(account?.currency_code || 'TWD').toUpperCase() === 'TWD');
}

export function transferTwdDelta({ source_twd = 0, destination_twd = 0 } = {}) {
  return Math.round((Number(destination_twd || 0) - Number(source_twd || 0)) * 100) / 100;
}

export function assetCurrencySummary(accountsSnapshot = []) {
  const grouped = new Map();
  for (const account of accountsSnapshot) {
    const currency = String(account?.currency_code || account?.valuation?.currency_code || 'TWD').toUpperCase();
    if (currency === 'TWD') continue;
    const current = grouped.get(currency) || { currency_code: currency, native_amount: 0, amount_twd: 0 };
    current.native_amount += finiteAmount(account?.native_amount ?? account?.valuation?.native_amount);
    current.amount_twd += finiteAmount(account?.amount ?? account?.valuation?.amount_twd);
    grouped.set(currency, current);
  }
  return [...grouped.values()]
    .map(item => ({ ...item, native_amount: Math.round(item.native_amount * 10000) / 10000, amount_twd: Math.round(item.amount_twd * 100) / 100 }))
    .sort((a, b) => b.amount_twd - a.amount_twd || a.currency_code.localeCompare(b.currency_code));
}

export function latestValuationForAccount(valuations = [], accountId, cutoffDate) {
  const cutoff = cutoffDate ? dateKey(cutoffDate) : '';
  const rows = valuations
    .filter(row => row?.account_id === accountId)
    .filter(row => !cutoff || dateKey(row?.valued_on) <= cutoff)
    .sort(compareValuations);
  return rows.length ? rows[rows.length - 1] : null;
}

export function assetSnapshot(accounts = [], valuations = [], categories = [], asOfDate) {
  const cutoff = dateKey(asOfDate);
  if (!cutoff) return { total: 0, accounts: [], allocation: [] };

  const rows = accounts
    .filter(account => accountExistsAt(account, cutoff))
    .map(account => {
      const valuation = latestValuationForAccount(valuations, account.id, cutoff);
      if (!valuation) return null;
      const currency_code = String(account.currency_code || valuation.currency_code || 'TWD').toUpperCase();
      return {
        ...account,
        currency_code,
        balance_mode: account.balance_mode || 'manual',
        amount: signedAmount(valuation.amount_twd),
        native_amount: signedAmount(valuation.native_amount ?? valuation.amount_twd),
        fx_rate_twd: Number(valuation.fx_rate_twd || 1),
        valuation
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.amount - a.amount || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));

  const total = rows.reduce((sum, account) => sum + account.amount, 0);
  const categoryMap = new Map(categories.map(category => [category.id, category.name]));
  const allocation = buildAllocation(rows, categoryMap);

  return { total, accounts: rows, allocation };
}

export function applyLiveFxRatesToSnapshot(snapshot = {}, liveRates = {}) {
  const sourceAccounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const categoryNames = new Map((snapshot.allocation || []).map(item => [item.id, item.name]));
  const accounts = sourceAccounts
    .map(account => {
      const currency = String(account?.currency_code || account?.valuation?.currency_code || 'TWD').toUpperCase();
      if (currency === 'TWD') return { ...account, live_fx: false };
      const liveRate = Number(liveRates?.[currency]);
      const storedRate = Number(account?.fx_rate_twd || account?.valuation?.fx_rate_twd || 0);
      const rate = liveRate > 0 ? liveRate : storedRate;
      const nativeAmount = Number(account?.native_amount ?? account?.valuation?.native_amount);
      if (!Number.isFinite(nativeAmount) || !(rate > 0)) return { ...account, live_fx: false };
      return {
        ...account,
        amount: Math.round(nativeAmount * rate * 100) / 100,
        fx_rate_twd: rate,
        live_fx: liveRate > 0
      };
    })
    .sort((a, b) => b.amount - a.amount || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
  const total = Math.round(accounts.reduce((sum, account) => sum + signedAmount(account.amount), 0) * 100) / 100;
  const allocation = buildAllocation(accounts, categoryNames);
  return { ...snapshot, total, accounts, allocation };
}

export function assetMonthlySeries(accounts = [], valuations = [], throughMonth) {
  if (!validMonth(throughMonth)) return [];

  const accountIds = new Set(accounts.map(account => account.id));
  const firstTrackedMonth = valuations
    .filter(row => accountIds.has(row?.account_id) && validMonth(monthKey(row?.valued_on)))
    .map(row => monthKey(row.valued_on))
    .sort()[0];

  if (!firstTrackedMonth || firstTrackedMonth > throughMonth) return [];

  const series = [];
  for (let key = firstTrackedMonth; key <= throughMonth; key = nextMonth(key)) {
    const snapshot = assetSnapshot(accounts, valuations, [], endOfMonth(key));
    const [, month] = key.split('-').map(Number);
    series.push({ month: key, label: `${month} 月`, total: snapshot.total });
    if (key === throughMonth) break;
  }
  return series;
}

export function assetMonthComparison(accounts = [], valuations = [], currentMonth) {
  if (!validMonth(currentMonth)) return { current: 0, previous: 0, delta: 0, percentage: null };
  const previousKey = previousMonth(currentMonth);
  const current = assetSnapshot(accounts, valuations, [], endOfMonth(currentMonth)).total;
  const previous = assetSnapshot(accounts, valuations, [], endOfMonth(previousKey)).total;
  const delta = current - previous;
  return { current, previous, delta, percentage: percentage(delta, previous) };
}

export function selectAssetSeriesRange(series = [], range = '6m') {
  if (range === 'all') return [...series];
  const size = range === '12m' ? 12 : 6;
  return series.slice(-size);
}
