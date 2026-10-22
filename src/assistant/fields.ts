import { z } from 'zod';

/**
 * One extracted value. `evidence` is the exact substring of the input it came from, so a
 * fact can always be traced back to what the user pasted. Guesses carry a `reason` instead.
 */
export const field = z.object({
  label: z.string(),
  value: z.string(),
  evidence: z.string().optional(),
  reason: z.string().optional()
});
export type Field = z.output<typeof field>;

export type Currency = 'TWD' | 'USD' | 'JPY' | 'EUR' | 'CNY';

export interface AmountMatch { amount: number; currency: Currency | null; evidence: string }

const CURRENCY_WORDS: Array<[RegExp, Currency]> = [
  [/^(NT\$|NTD|TWD|新台幣|新臺幣|台幣|臺幣|元|塊|圓)$/i, 'TWD'],
  [/^(US\$|USD|美金|美元)$/i, 'USD'],
  [/^(¥|JPY|日幣|日圓|日元|円)$/i, 'JPY'],
  [/^(€|EUR|歐元)$/i, 'EUR'],
  [/^(RMB|CNY|人民幣)$/i, 'CNY']
];

function currencyOf(word: string | undefined): Currency | null {
  if (!word) return null;
  return CURRENCY_WORDS.find(([re]) => re.test(word.trim()))?.[1] ?? null;
}

const PREFIX = String.raw`(NT\$|NTD|TWD|US\$|USD|JPY|EUR|RMB|CNY|新台幣|新臺幣|台幣|臺幣|美金|美元|日幣|日圓|人民幣|歐元|[¥€$])`;
const SUFFIX = String.raw`(元|塊|圓|NTD|TWD|USD|JPY|EUR|RMB|CNY|美金|美元|日幣|日圓|日元|円|人民幣|歐元)`;
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;

/** Money amounts written with a currency marker. Bare numbers are not treated as money here. */
export function findAmounts(text: string): AmountMatch[] {
  const out: AmountMatch[] = [];
  const seen = new Set<number>();
  const push = (index: number, raw: string, number: string, word: string | undefined, fallback: Currency | null) => {
    if (seen.has(index)) return;
    const amount = Number(number.replaceAll(',', ''));
    if (!Number.isFinite(amount) || amount <= 0) return;
    seen.add(index);
    out.push({ amount, currency: currencyOf(word) ?? fallback, evidence: raw.trim() });
  };
  for (const m of text.matchAll(new RegExp(`${PREFIX}\\s*${NUMBER}`, 'gi'))) {
    // A bare "$" is ambiguous (TWD or USD), so its currency stays unknown.
    push(m.index!, m[0], m[2], m[1] === '$' ? undefined : m[1], null);
  }
  for (const m of text.matchAll(new RegExp(`${NUMBER}\\s*${SUFFIX}`, 'gi'))) {
    const start = m.index!;
    if ([...seen].some(index => Math.abs(index - start) <= 6)) continue;
    push(start, m[0], m[1], m[2], null);
  }
  return out;
}

export function formatAmount(match: Pick<AmountMatch, 'amount' | 'currency'>) {
  return `${match.currency ?? '幣別未知'} ${match.amount.toLocaleString('en-US')}`;
}
