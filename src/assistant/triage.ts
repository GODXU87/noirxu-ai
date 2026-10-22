// Smart text triage: sorts pasted notes, notifications, emails or chat snippets into
// events, to-dos, money items, key information and messages that need a reply.
//
// It is deterministic on purpose. Every "fact" quotes the exact text it came from;
// anything inferred is listed separately as a guess with its reason; nothing is written
// anywhere. Instructions found inside the pasted text are flagged, never followed.

import { z } from 'zod';
import { parseAgendaText } from '@/agenda/parse';
import { field, findAmounts, formatAmount, type Field } from './fields';

export const TRIAGE_KINDS = ['event', 'todo', 'finance', 'info', 'reply'] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];
export const TRIAGE_KIND_LABEL: Record<TriageKind, string> = { event: '行程', todo: '待辦', finance: '財務', info: '重要資訊', reply: '需要回覆' };

export const triageItem = z.object({
  kind: z.enum(TRIAGE_KINDS),
  title: z.string(),
  /** The line of the input this item came from. */
  evidence: z.string(),
  facts: z.array(field),
  guesses: z.array(field),
  missing: z.array(z.string())
});

export const triageAction = z.object({
  type: z.enum(['agenda.create', 'ledger.draft', 'reply.draft']),
  label: z.string(),
  /** Always 'suggested': nothing has been done; the user starts it explicitly. */
  status: z.literal('suggested'),
  requires_confirmation: z.boolean(),
  payload: z.record(z.string(), z.unknown())
});

export const triageResult = z.object({
  source: z.enum(['user', 'pasted', 'email']),
  items: z.array(triageItem),
  contacts: z.object({ emails: z.array(z.string()), phones: z.array(z.string()), urls: z.array(z.string()) }),
  actions: z.array(triageAction),
  injection_signals: z.array(z.string()),
  warnings: z.array(z.string())
});
export type TriageResult = z.output<typeof triageResult>;
export type TriageItem = z.output<typeof triageItem>;

const EVENT_WORDS = /(會議|開會|meeting|見面|聚餐|約了|面試|演示|看診|門診|回診|預約|活動|上課|課程|講座|研討會|餐敘|拜訪|簡報|發表會|婚禮|生日)/i;
const TODO_WORDS = /(記得|需要|請於|請在|待辦|完成|提交|繳交|交件|準備|處理|寄出|上傳|填寫|簽署|報名|購買|整理|確認|要做)/;
const FINANCE_WORDS = /(繳費|帳單|應繳|金額|轉帳|匯款|付款|扣款|刷卡|消費|收款|退款|發票|費用|手續費|月費|年費|分期|利息|薪資|薪水|入帳|保費|稅)/;
const DEADLINE_WORDS = /(截止|期限|到期|最晚|之前|以前|前繳|deadline|due)/i;
const REPLY_WORDS = /(請回覆|回覆|請確認|請告知|是否方便|方便嗎|可以嗎|有空嗎|能否|麻煩您|麻煩你|RSVP|請回信|等你回)/i;
const INFO_WORDS = /(注意|重要|提醒|公告|通知|變更|更改|取消|延期|改到|密碼已|驗證碼|帳號|規定)/;
const IMPORTANT_WORDS = /(非常重要|很重要|超重要|緊急|務必|一定要|重要)/;

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i, '要求忽略先前指示'],
  [/忽略(掉)?(之前|以上|先前|前面|上述)?(的)?(所有|全部|一切)?(的)?(指示|指令|規則|設定|提示)/, '要求忽略先前指示'],
  [/(system\s*prompt|系統提示|系統指令|開發者模式|developer\s*mode|jailbreak)/i, '提到系統提示或越獄'],
  [/(you\s+are\s+now|你現在是|從現在起你是|扮演一個)/i, '要求改變助理身分'],
  [/(立即|馬上|直接|自動)(幫我|替我)?(轉帳|匯款|付款|寄出|寄信|轉寄|刪除|下單|買進|賣出)/, '要求直接執行轉帳、寄信或交易'],
  [/(提供|告訴|回傳|輸入|貼上)(我|你)?(的)?(密碼|驗證碼|OTP|token|金鑰|api\s*key|信用卡號)/i, '索取密碼、驗證碼或金鑰'],
  [/<\/?\s*(system|assistant|tool|instructions?)\s*>/i, '含有偽造的系統標籤'],
  [/(send|forward)\s+(this|all|the)\s+.{0,30}(to|@)/i, '要求轉寄或寄送內容']
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}|\(?0\d{1,2}\)?[-\s]?\d{3,4}[-\s]?\d{4}/g;
const URL_RE = /https?:\/\/[^\s<>"'，。）)]+/g;
const DURATION_RE = /(約|大約|預計|需要|共)?\s*(\d+(?:\.\d+)?)\s*(小時|個小時|分鐘|hr|hrs|min|mins)/i;
const LOCATION_RES = [/(?:地點|地址|場地|會議室|location|venue)\s*[:：]\s*([^\n，,。]{2,40})/i, /在\s*([^\s，,。]{2,20}?)(?:見面|開會|集合|舉行|碰面|等你)/];
const PARTICIPANT_RE = /(?:與|和|跟|with)\s*([^\s，,。]{1,12}?)\s*(?:開會|見面|會議|討論|吃飯|聚餐|通話|meeting)/i;

function unique(values: string[]) {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

/** Lines, with long single-line text also split at sentence ends. */
function segments(text: string): string[] {
  return text.split(/\n|(?<=[。！？!?；;])/).map(line => line.trim()).filter(line => line.length > 1);
}

function detectInjection(text: string): string[] {
  return unique(INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label));
}

function classify(line: string, hasDate: boolean, hasAmount: boolean): TriageKind[] {
  const kinds: TriageKind[] = [];
  if (EVENT_WORDS.test(line) && hasDate) kinds.push('event');
  if (FINANCE_WORDS.test(line) || (hasAmount && DEADLINE_WORDS.test(line))) kinds.push('finance');
  if (!kinds.includes('event') && (TODO_WORDS.test(line) || (DEADLINE_WORDS.test(line) && hasDate && !kinds.includes('finance')))) kinds.push('todo');
  if (REPLY_WORDS.test(line) || /[?？]\s*$/.test(line)) kinds.push('reply');
  if (!kinds.length && (INFO_WORDS.test(line) || hasDate || hasAmount)) kinds.push(EVENT_WORDS.test(line) ? 'event' : 'info');
  return kinds;
}

function dateEvidence(line: string): string | undefined {
  return /\d{4}[/\-.年]\d{1,2}[/\-.月]\d{1,2}[日號]?|\d{1,2}\s*[/月]\s*\d{1,2}\s*[日號]?|(今天|今日|明天|明日|後天|大後天)|(下下|下)?(週|周|星期|禮拜)[一二三四五六日天]|\d{1,2}\s*[日號]/.exec(line)?.[0];
}

function timeEvidence(line: string): string | undefined {
  return /\d{1,2}[:：]\d{2}|(早上|上午|中午|下午|晚上|傍晚)?\s*[0-9一二兩三四五六七八九十]{1,3}\s*[點点時](半|[0-9一二三四五六七八九十]{1,3}分?)?/.exec(line)?.[0]?.trim();
}

function shortTitle(line: string) {
  const clean = line.replace(URL_RE, '').replace(EMAIL_RE, '').replace(/\s+/g, ' ').trim();
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}

/**
 * `today` is the Taipei date. `source` says whose words these are: anything other than
 * 'user' is third-party content, for which only suggestions are produced.
 */
export function triageText(input: string, today: string, source: TriageResult['source'] = 'pasted'): TriageResult {
  const text = input.slice(0, 8000);
  const items: TriageItem[] = [];
  const warnings: string[] = [];

  for (const line of segments(text)) {
    const amounts = findAmounts(line);
    const dEv = dateEvidence(line);
    const tEv = timeEvidence(line);
    const kinds = classify(line, Boolean(dEv), amounts.length > 0);
    if (!kinds.length) continue;
    const parsed = parseAgendaText(line, today);

    for (const kind of kinds) {
      const facts: Field[] = [];
      const guesses: Field[] = [];
      const missing: string[] = [];

      if (dEv && parsed.due_date) facts.push({ label: kind === 'finance' || kind === 'todo' ? '期限' : '日期', value: parsed.due_date, evidence: dEv });
      if (tEv && parsed.due_time) facts.push({ label: '時間', value: parsed.due_time, evidence: tEv });

      if (kind === 'event') {
        const location = LOCATION_RES.map(re => re.exec(line)).find(Boolean);
        if (location) facts.push({ label: '地點', value: location[1].trim(), evidence: location[0] });
        const who = PARTICIPANT_RE.exec(line);
        if (who) guesses.push({ label: '參與者', value: who[1], reason: `依「${who[0]}」判斷` });
        if (!parsed.due_date) missing.push('日期');
        if (!parsed.due_time) missing.push('時間');
        if (!location) missing.push('地點');
      }
      if (kind === 'todo') {
        const duration = DURATION_RE.exec(line);
        if (duration) facts.push({ label: '預估耗時', value: `${duration[2]} ${/分|min/i.test(duration[3]) ? '分鐘' : '小時'}`, evidence: duration[0].trim() });
        if (!parsed.due_date) missing.push('期限');
      }
      if (kind === 'finance') {
        for (const amount of amounts) facts.push({ label: '金額', value: formatAmount(amount), evidence: amount.evidence });
        for (const amount of amounts.filter(a => !a.currency)) guesses.push({ label: '幣別', value: 'TWD', reason: `「${amount.evidence}」沒有寫幣別` });
        if (!amounts.length) missing.push('金額');
        if (DEADLINE_WORDS.test(line) && !parsed.due_date) missing.push('繳費期限');
      }
      if (kind === 'reply') {
        if (!REPLY_WORDS.test(line)) guesses.push({ label: '需要回覆', value: '是', reason: '句子是問句' });
      }

      const important = IMPORTANT_WORDS.exec(line);
      if (important) facts.push({ label: '優先級', value: '高', evidence: important[0] });
      else if (parsed.due_date && (kind === 'todo' || kind === 'finance')) {
        const days = (Date.parse(parsed.due_date) - Date.parse(today)) / 86_400_000;
        if (days <= 2) guesses.push({ label: '優先級', value: '高', reason: `期限在 ${days <= 0 ? '今天' : `${days} 天後`}` });
      }

      if (parsed.due_date && parsed.due_date < today) warnings.push(`「${shortTitle(line)}」的日期 ${parsed.due_date} 已經過去。`);
      items.push({ kind, title: shortTitle(line), evidence: line, facts, guesses, missing: unique(missing) });
    }
  }

  const injection = detectInjection(text);
  if (injection.length) warnings.unshift(`內容含有疑似指令（${injection.join('、')}），已當作一般文字處理，不會執行。`);
  for (const amount of findAmounts(text)) {
    if (amount.currency && amount.currency !== 'TWD') warnings.push(`有外幣金額 ${amount.evidence}，記入 Ledger 前需換算成台幣。`);
  }

  // Suggestions only. Each is started by the user and goes through the normal flow.
  const actions: TriageResult['actions'] = [];
  for (const item of items) {
    // No one-click suggestion is built from a line that tries to give orders.
    if (detectInjection(item.evidence).length) continue;
    const date = item.facts.find(f => f.label === '日期' || f.label === '期限')?.value ?? null;
    const time = item.facts.find(f => f.label === '時間')?.value ?? null;
    if ((item.kind === 'event' || item.kind === 'todo' || item.kind === 'finance') && date && date >= today) {
      actions.push({
        type: 'agenda.create', label: `加入記事：${item.title}`, status: 'suggested', requires_confirmation: false,
        payload: { title: item.title, due_date: date, due_time: time, importance: item.facts.some(f => f.label === '優先級') ? 3 : 2, notes: item.evidence.slice(0, 1000) }
      });
    }
    if (item.kind === 'finance' && item.facts.some(f => f.label === '金額')) {
      actions.push({ type: 'ledger.draft', label: `整理成記帳草稿：${item.title}`, status: 'suggested', requires_confirmation: true, payload: { text: item.evidence } });
    }
  }
  if (items.some(item => item.kind === 'reply')) {
    actions.push({ type: 'reply.draft', label: '擬回覆草稿', status: 'suggested', requires_confirmation: true, payload: {} });
  }
  // The same line can yield several identical suggestions (e.g. a todo that is also finance).
  const seen = new Set<string>();
  const deduped = actions.filter(action => { const key = `${action.type}:${JSON.stringify(action.payload)}`; if (seen.has(key)) return false; seen.add(key); return true; });

  return triageResult.parse({
    source,
    items,
    contacts: { emails: unique(text.match(EMAIL_RE) ?? []), phones: unique(text.match(PHONE_RE) ?? []), urls: unique(text.match(URL_RE) ?? []) },
    actions: deduped,
    injection_signals: injection,
    warnings: unique(warnings)
  });
}
