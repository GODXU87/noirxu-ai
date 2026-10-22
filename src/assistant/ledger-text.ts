// Turns a short note like 「午餐 150 元 刷卡」 into a Ledger draft without an AI model.
// It never writes anything: the result fills the Ledger form, and saving still goes
// through ledger.expense.create / ledger.income.create and the confirmation card.

import { EXPENSE_PAYMENT_METHODS, INCOME_PAYMENT_METHODS } from '@/tools/ledger/schemas';
import { findAmounts, type Currency, type Field } from './fields';

export interface LedgerCategoryLite { id: string; type: 'expense' | 'income'; name: string }

export interface LedgerDraft {
  type: 'expense' | 'income';
  amount: number | null;
  currency: Currency | null;
  occurred_on: string;
  payment_method: string | null;
  category_id: string | null;
  category_name: string | null;
  note: string;
  facts: Field[];
  guesses: Field[];
  missing: string[];
  warnings: string[];
}

const INCOME_WORDS = /(收入|薪水|薪資|獎金|入帳|收到|退款|股利|利息|進帳)/;
const EXPENSE_WORDS = /(支出|花了|花費|買|付了|付款|繳)/;

const PAYMENT_WORDS: Array<[RegExp, string]> = [
  [/(信用卡|刷卡)/, '信用卡'],
  [/(現金)/, '現金'],
  [/(轉帳|匯款)/, '轉帳'],
  [/line\s*pay/i, 'LINE Pay'],
  [/apple\s*pay/i, 'Apple Pay'],
  [/(悠遊卡)/, '悠遊卡']
];

/** keyword → words that usually appear in the matching Ledger category name. */
const CATEGORY_HINTS: Array<{ type: 'expense' | 'income'; keywords: RegExp; names: string[] }> = [
  { type: 'expense', keywords: /(早餐|午餐|晚餐|宵夜|便當|咖啡|飲料|餐廳|吃飯|聚餐|麥當勞|星巴克|手搖)/, names: ['餐飲', '飲食', '餐', '食'] },
  { type: 'expense', keywords: /(捷運|公車|計程車|uber|高鐵|台鐵|火車|加油|停車|油錢|機票)/i, names: ['交通'] },
  { type: 'expense', keywords: /(全聯|家樂福|超市|蝦皮|momo|衣服|日用品|網購|7-11|全家)/i, names: ['購物', '日用'] },
  { type: 'expense', keywords: /(電影|遊戲|ktv|netflix|spotify|演唱會)/i, names: ['娛樂'] },
  { type: 'expense', keywords: /(看診|藥|診所|醫院|牙醫|掛號)/, names: ['醫療', '健康'] },
  { type: 'expense', keywords: /(房租|水費|電費|瓦斯|管理費)/, names: ['居住', '房租', '水電'] },
  { type: 'expense', keywords: /(電話費|手機費|網路費|電信)/, names: ['通訊', '電信', '電話'] },
  { type: 'income', keywords: /(薪水|薪資)/, names: ['薪資', '薪水'] },
  { type: 'income', keywords: /(獎金)/, names: ['獎金'] },
  { type: 'income', keywords: /(股利|利息)/, names: ['投資', '股利', '利息'] }
];

function iso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Spending happens in the past: 「10/20」 means the most recent 10/20, not next year's. */
function pastDate(text: string, today: string): Field | null {
  const [y, m, d] = today.split('-').map(Number);
  let match = /(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})[日號]?/.exec(text);
  if (match) {
    const date = iso(Number(match[1]), Number(match[2]), Number(match[3]));
    return date ? { label: '日期', value: date, evidence: match[0] } : null;
  }
  match = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*[日號]?/.exec(text);
  if (match) {
    let date = iso(y, Number(match[1]), Number(match[2]));
    if (date && date > today) date = iso(y - 1, Number(match[1]), Number(match[2]));
    return date ? { label: '日期', value: date, evidence: match[0] } : null;
  }
  match = /(今天|今日|昨天|昨日|前天)/.exec(text);
  if (match) {
    const back = { 今天: 0, 今日: 0, 昨天: 1, 昨日: 1, 前天: 2 }[match[1]] ?? 0;
    return { label: '日期', value: new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10), evidence: match[1] };
  }
  return null;
}

const COMMAND_WORDS = /(幫我記帳|幫我記|記帳|記一筆|一筆)/g;

function matchCategory(text: string, type: 'expense' | 'income', categories: LedgerCategoryLite[]) {
  const options = categories.filter(c => c.type === type);
  // Longest name first, so 「交通費」 wins over 「交通」.
  const named = [...options].sort((a, b) => b.name.length - a.name.length).find(c => c.name && text.includes(c.name));
  if (named) return { category: named, evidence: named.name, guessed: false };
  for (const hint of CATEGORY_HINTS.filter(h => h.type === type)) {
    const keyword = hint.keywords.exec(text);
    if (!keyword) continue;
    const category = hint.names.map(name => options.find(c => c.name.includes(name))).find(Boolean);
    if (category) return { category, evidence: keyword[0], guessed: true };
  }
  return null;
}

/** `today` is the Taipei date. `categories` may be empty when Ledger is not connected. */
export function parseLedgerText(input: string, today: string, categories: LedgerCategoryLite[] = []): LedgerDraft {
  const text = input.trim();
  const facts: Field[] = [];
  const guesses: Field[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  const incomeWord = INCOME_WORDS.exec(text);
  const expenseWord = EXPENSE_WORDS.exec(text);
  const type: 'expense' | 'income' = incomeWord && !expenseWord ? 'income' : 'expense';
  if (incomeWord && !expenseWord) facts.push({ label: '類型', value: '收入', evidence: incomeWord[0] });
  else if (expenseWord) facts.push({ label: '類型', value: '支出', evidence: expenseWord[0] });
  else guesses.push({ label: '類型', value: '支出', reason: '沒有寫收入或支出，預設為支出' });

  // Amount: prefer one written with a currency; otherwise a lone number the user typed.
  let amount: number | null = null;
  let currency: Currency | null = null;
  let amountEvidence = '';
  const amounts = findAmounts(text);
  if (amounts.length > 1) warnings.push(`有 ${amounts.length} 個金額（${amounts.map(a => a.evidence).join('、')}），請確認要記哪一個。`);
  if (amounts.length) {
    ({ amount, currency } = amounts[0]);
    amountEvidence = amounts[0].evidence;
  } else {
    const withoutDates = text.replace(/\d{4}[/\-.年]\d{1,2}[/\-.月]\d{1,2}[日號]?|\d{1,2}\s*[/月]\s*\d{1,2}\s*[日號]?|\d{1,2}[:：]\d{2}|\d{1,2}\s*[點時日號]/g, ' ');
    const bare = withoutDates.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? [];
    if (bare.length === 1) { amount = Number(bare[0].replaceAll(',', '')); amountEvidence = bare[0]; }
    else if (bare.length > 1) warnings.push(`有多個數字（${bare.join('、')}），看不出哪個是金額。`);
  }
  if (amount && amount > 0) {
    facts.push({ label: '金額', value: String(amount), evidence: amountEvidence });
    if (!currency) guesses.push({ label: '幣別', value: 'TWD', reason: '沒有寫幣別，Ledger 以台幣記帳' });
    else facts.push({ label: '幣別', value: currency, evidence: amountEvidence });
    if (currency && currency !== 'TWD') warnings.push(`金額是 ${currency}，Ledger 以台幣記帳，請自行換算成台幣後再記。`);
  } else {
    amount = null;
    missing.push('金額');
  }

  const occurredFact = pastDate(text, today);
  const occurred = occurredFact?.value ?? today;
  if (occurredFact) facts.push(occurredFact);
  if (!facts.some(f => f.label === '日期')) guesses.push({ label: '日期', value: today, reason: '沒有寫日期，預設今天' });
  if (occurred > today) warnings.push(`日期 ${occurred} 在未來，Ledger 不接受未來日期。`);

  const methods: readonly string[] = type === 'expense' ? EXPENSE_PAYMENT_METHODS : INCOME_PAYMENT_METHODS;
  let paymentMethod: string | null = null;
  for (const [re, method] of PAYMENT_WORDS) {
    const m = re.exec(text);
    if (m && methods.includes(method)) { paymentMethod = method; facts.push({ label: '付款方式', value: method, evidence: m[0] }); break; }
  }
  if (!paymentMethod) missing.push('付款方式');

  const category = matchCategory(text, type, categories);
  if (category) {
    (category.guessed ? guesses : facts).push(category.guessed
      ? { label: '分類', value: category.category.name, reason: `依「${category.evidence}」推測` }
      : { label: '分類', value: category.category.name, evidence: category.evidence });
  } else {
    missing.push('分類');
  }

  let note = text.replace(COMMAND_WORDS, ' ');
  if (amountEvidence) note = note.replace(amountEvidence, ' ');
  for (const f of facts) if (f.evidence && f.label !== '分類') note = note.replace(f.evidence, ' ');
  note = note.replace(/[，,。、]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  return {
    type, amount, currency, occurred_on: occurred, payment_method: paymentMethod,
    category_id: category?.category.id ?? null, category_name: category?.category.name ?? null,
    note, facts, guesses, missing, warnings
  };
}
