// Proactive finance checks (V0.4 Phase 2, feature 'finance_alerts', off by default).
// Everything here is deterministic arithmetic on real Ledger numbers — no model involved.
// Rules:
// - a budget alert needs a limit the user set in Ledger; nothing is assumed when it is unset;
// - amounts in different currencies (or different accounts) are never added together;
// - an anomaly needs a statistical baseline (median / MAD) and a minimum number of samples;
// - every alert has a deterministic key, so the delivery service sends it at most once.

export interface FinanceThresholds { warn: number; over: number }
export const DEFAULT_THRESHOLDS: FinanceThresholds = { warn: 0.8, over: 1 };

/** Validates user-adjusted thresholds; returns an error message instead of silently fixing them. */
export function parseThresholds(input: { warn?: number; over?: number }): FinanceThresholds | { error: string } {
  const warn = input.warn ?? DEFAULT_THRESHOLDS.warn;
  const over = input.over ?? DEFAULT_THRESHOLDS.over;
  if (!Number.isFinite(warn) || !Number.isFinite(over)) return { error: '門檻必須是數字。' };
  if (warn < 0.5 || warn >= over) return { error: '提醒門檻需介於 50% 與超支門檻之間。' };
  if (over > 1.5) return { error: '超支門檻最高 150%。' };
  return { warn, over };
}

export interface BudgetLine { key: string; name: string; currency: string; limit: number; spent: number }

/** Budget lines from ledger.budget.summary. Lines without a limit the user set are left out. */
export function fromLedgerBudget(data: { currency: string; total: { limit: number; spent: number; status: string }; categories: Array<{ categoryId: string; name: string; limit: number; spent: number; status: string }> }): BudgetLine[] {
  const lines: BudgetLine[] = [];
  if (data.total.status !== 'unset' && data.total.limit > 0) lines.push({ key: 'total', name: '總預算', currency: data.currency, limit: data.total.limit, spent: data.total.spent });
  for (const c of data.categories) if (c.status !== 'unset' && c.limit > 0) lines.push({ key: `cat:${c.categoryId}`, name: c.name, currency: data.currency, limit: c.limit, spent: c.spent });
  return lines;
}

export interface BudgetAlert { key: string; line: BudgetLine; level: 'warn' | 'over'; ratio: number; title: string; body: string }

const money = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * At most one alert per line: the highest level reached. The key includes month and level,
 * so "80%" and "100%" are each sent once per month, and a lower level is never sent after
 * the higher one (it is not produced once the line is over).
 */
export function budgetAlerts(lines: BudgetLine[], month: string, thresholds: FinanceThresholds = DEFAULT_THRESHOLDS): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  for (const line of lines) {
    if (!(line.limit > 0)) continue;
    const ratio = line.spent / line.limit;
    const level = ratio >= thresholds.over ? 'over' : ratio >= thresholds.warn ? 'warn' : null;
    if (!level) continue;
    const pct = Math.round(ratio * 100);
    alerts.push({
      key: `finance:budget:${month}:${line.currency}:${line.key}:${level}`, line, level, ratio,
      title: level === 'over' ? `${line.name}已超出預算` : `${line.name}已用 ${pct}%`,
      body: `${line.currency} ${money(line.spent)} / ${money(line.limit)}（${pct}%）${level === 'over' ? `，超出 ${money(line.spent - line.limit)}` : `，剩 ${money(line.limit - line.spent)}`}`
    });
  }
  return alerts;
}

function daysInMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Spending pace for the current month: straight-line projection to month end. Needs at
 * least `minDays` elapsed days, because a projection from day 1 is noise.
 */
export function spendingPace(line: BudgetLine, today: string, minDays = 5) {
  const month = today.slice(0, 7);
  const total = daysInMonth(month);
  const elapsed = Number(today.slice(8, 10));
  if (elapsed < minDays) return null;
  const projected = (line.spent / elapsed) * total;
  const expected = line.limit * (elapsed / total);
  return { elapsed_days: elapsed, days_in_month: total, expected_spent: expected, projected, projected_ratio: line.limit > 0 ? projected / line.limit : null, ahead_of_pace: line.spent > expected };
}

export const MIN_BASELINE = 6;
export const ANOMALY_SCORE = 3.5;

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Robust outlier check (modified z-score, Iglewicz & Hoaglin): 0.6745·(x − median) / MAD.
 * Returns 'insufficient' with fewer than `minSamples` history values, and 'flat' when the
 * history has no spread (MAD = 0) — in both cases nothing is flagged.
 */
export function spendingAnomaly(history: number[], current: number, options: { minSamples?: number; threshold?: number } = {}) {
  const minSamples = options.minSamples ?? MIN_BASELINE;
  const threshold = options.threshold ?? ANOMALY_SCORE;
  const clean = history.filter(v => Number.isFinite(v));
  if (clean.length < minSamples) return { status: 'insufficient' as const, samples: clean.length, needed: minSamples };
  const med = median(clean);
  const mad = median(clean.map(v => Math.abs(v - med)));
  if (mad === 0) return { status: 'flat' as const, samples: clean.length, median: med };
  const score = (0.6745 * (current - med)) / mad;
  return { status: score > threshold ? 'anomaly' as const : 'normal' as const, samples: clean.length, median: med, mad, score: Math.round(score * 100) / 100 };
}

/** Totals per currency; amounts in different currencies are never added together. */
export function totalsByCurrency(rows: Array<{ currency: string; amount: number }>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.currency] = Math.round(((totals[r.currency] ?? 0) + r.amount) * 100) / 100;
  return totals;
}
