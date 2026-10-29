import { isReminderRequest } from '@/agenda/when';
import { parseTaskText } from '@/tasks/parse';

// Deterministic intent recognition for the local router. Pure functions, no model calls:
// a message is handled locally only when one rule matches clearly. Anything with an action
// verb, several requests, or no clear match goes to the model (or the existing slash
// commands), so saving tokens never means guessing.

export type LocalIntent =
  | { kind: 'greeting'; which: 'morning' | 'noon' | 'night' | 'hello' | 'thanks' }
  | { kind: 'identity' }
  | { kind: 'datetime'; what: 'date' | 'weekday' | 'time' }
  | { kind: 'calc'; expression: string }
  | { kind: 'water_status' }
  | { kind: 'agenda'; range: 'today' | 'tomorrow' | 'week' | 'overdue' | 'upcoming' }
  | { kind: 'ledger_month'; which: 'this' | 'last' }
  | { kind: 'memory_recall'; subject: string }
  | { kind: 'reminder_create'; text: string }
  | { kind: 'task_create'; text: string }
  | { kind: 'task_list' }
  | { kind: 'task_halt'; halted: boolean }
  | { kind: 'garmin'; which: 'steps' | 'sleep' | 'status' }
  | { kind: 'briefing'; which: 'morning' | 'evening' }
  | { kind: 'memory_save'; content: string }
  | { kind: 'memory_forget'; subject: string };

/** Words that ask for a change, a judgement or a longer piece of work: never answered locally. */
const ACTION = /(記下|記一|幫我記|新增|加入|刪除|刪掉|取消|修改|改成|改到|設定|寄|回覆|回信|擬|寫一|建立|提醒我|分析|比較|研究|為什麼|怎麼辦|建議|規劃|安排一下|排一下|整理|翻譯|總結|摘要|預測|應該)/;
/** Several requests in one message. */
const MULTI = /(然後|並且|順便|另外|還有|以及|同時|再幫|再來)/;
const MAX_LOCAL_CHARS = 40;

const RULES: Array<[RegExp, (m: RegExpMatchArray) => LocalIntent]> = [
  [/^(早安|早上好|早)$/, () => ({ kind: 'greeting', which: 'morning' })],
  [/^(午安|中午好)$/, () => ({ kind: 'greeting', which: 'noon' })],
  [/^(晚安|晚上好)$/, () => ({ kind: 'greeting', which: 'night' })],
  [/^(你好|您好|嗨|哈囉|hi|hello|hey)$/i, () => ({ kind: 'greeting', which: 'hello' })],
  [/^(謝謝|謝啦|感謝|多謝|thanks?|thank you)(你|您)?$/i, () => ({ kind: 'greeting', which: 'thanks' })],
  [/^(你是誰|你叫什麼(名字)?|你是什麼)$/, () => ({ kind: 'identity' })],
  [/^(今天|今日)?(是)?(幾月)?幾號$|^今天(的)?日期$|^今天是什麼日子$/, () => ({ kind: 'datetime', what: 'date' })],
  [/^(今天)?(是)?(星期|禮拜|週)幾$/, () => ({ kind: 'datetime', what: 'weekday' })],
  [/^現在(是)?幾點(了)?$|^現在時間$/, () => ({ kind: 'datetime', what: 'time' })],
  [/^(我)?(今天|目前|現在|到現在|到目前為止)?(已經|總共)?(喝了?多少水|水喝了?多少|喝水(的)?(進度|狀況|情況)|飲水(進度|狀況)?|喝了多少)$/, () => ({ kind: 'water_status' })],
  [/^(我)?(今天|今日)(有)?(什麼|哪些)?(待辦|待辦事項|行程|安排|事情?|要做的事?|要做什麼|要幹嘛)$/, () => ({ kind: 'agenda', range: 'today' })],
  [/^(我)?(今天|今日)(要做|要幹)(什麼|嘛)$/, () => ({ kind: 'agenda', range: 'today' })],
  [/^(我)?明天(有)?(什麼|哪些)?(待辦|待辦事項|行程|安排|事情?|要做的事?|要做什麼)$/, () => ({ kind: 'agenda', range: 'tomorrow' })],
  [/^(我)?(這週|本週|這禮拜|這星期)(有)?(什麼|哪些)?(待辦|行程|安排|事情?|要做的事?)$/, () => ({ kind: 'agenda', range: 'week' })],
  [/^(有)?(哪些|什麼)?(事)?(已經)?過期(了)?(的事)?$|^過期(的)?(事項|待辦)$/, () => ({ kind: 'agenda', range: 'overdue' })],
  [/^(最近|近期)(有)?(什麼|哪些)(事|待辦|行程)$/, () => ({ kind: 'agenda', range: 'upcoming' })],
  [/^(我)?(這個月|本月|這月)(總共)?(花了?|支出|開銷|花費|用了)(多少|了多少|多少錢)?(錢)?$/, () => ({ kind: 'ledger_month', which: 'this' })],
  [/^(我)?(上個月|上月)(總共)?(花了?|支出|開銷|花費|用了)(多少|了多少|多少錢)?(錢)?$/, () => ({ kind: 'ledger_month', which: 'last' })],
  [/^(我的|我有|目前|現在)?(有)?(哪些|什麼)?(自動|背景|週期|重複)?(任務|排程|自動化|重複提醒)(有哪些|清單|列表|狀態)?$/, () => ({ kind: 'task_list' })],
  [/^(我)?(今天|今日)?(走了|走)?(多少|幾)步(了)?$|^(今天|今日)?(的)?步數(多少|是多少)?$/, () => ({ kind: 'garmin', which: 'steps' })],
  [/^(我)?(昨晚|昨天晚上|昨天)?(睡得?(怎麼樣|怎樣|如何|好嗎|好不好|多久)|睡了多久|睡眠(怎麼樣|怎樣|如何|狀況|品質)?)$/, () => ({ kind: 'garmin', which: 'sleep' })],
  [/^(我)?(目前|現在|今天|最近)?(的)?(身體|身體狀況|身體狀態|恢復|恢復狀況|體能|狀態)(怎麼樣|怎樣|如何|好嗎|狀況)?(呢)?$|^(根據|看|用|從|查|讀)?(我的)?([Gg]armin|GARMIN|佳明|手錶)(的)?(資料|數據)?(呢|啊.{0,4}|阿.{0,4})?$|^(我)?今天(適合|可以|能不能|要不要)(運動|訓練|練|去練|健身|打球|跑步)(嗎)?$/, () => ({ kind: 'garmin', which: 'status' })],
  [/^(給我|看|看一下|我要|今天的?|今日)?(早報|今日早報)$/, () => ({ kind: 'briefing', which: 'morning' })],
  [/^(給我|看|看一下|我要|今天的?|今日)?(晚報|今日晚報)$/, () => ({ kind: 'briefing', which: 'evening' })],
  [/^你(還)?記得我的(.{1,12}?)(嗎|是多少|多少)?$/, m => ({ kind: 'memory_recall', subject: m[2] })],
  [/^我的(體重|身高|生日|年齡|血型)(是)?(多少|幾)?$/, m => ({ kind: 'memory_recall', subject: m[1] })]
];

/** The user's own words: drops the "[系統紀錄]" block the client prepends after confirmations. */
export function userWords(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[系統紀錄]')) return trimmed;
  const split = trimmed.lastIndexOf('\n\n');
  return split >= 0 ? trimmed.slice(split + 2).trim() : '';
}

function normalize(text: string) {
  return text.replace(/[\s　]+/g, '').replace(/[？?！!。．.～~，,、]+$/g, '').replace(/^(請問|請|那|嗯|欸|SASUKE|佐助)[，,]?/i, '');
}

const CALC = /^[\d\s+\-*/×÷x().%]+$/;
/** A time the reminder parser can work with (relative or clock time). */
const REMINDER_TIME = /((\d+|[零一二兩三四五六七八九十]+)\s*個?\s*半?\s*(分鐘?|小時|鐘頭|天)\s*(後|之後|以後)|半\s*個?\s*(小時|鐘頭)\s*(後|之後)|一刻鐘|[0-9一二兩三四五六七八九十]{1,3}\s*[點点時]|\d{1,2}[:：]\d{2}|今晚|明早|明晚)/;

/** Returns the local intent, or null when the message should go to the model. */
export function classify(raw: string): LocalIntent | null {
  const text = normalize(userWords(raw));
  if (!text || text.length > MAX_LOCAL_CHARS || text.startsWith('/') || text.startsWith('／')) return null;
  // "兩分鐘後提醒我看電腦", "明天9點提醒我開會": created locally from the user's own words.
  const words = userWords(raw).trim();
  if (/^(緊急)?(停止|暫停|停掉|關掉)(所有|全部)(的)?(自動|背景)?(任務|自動化|排程)$/.test(text)) return { kind: 'task_halt', halted: true };
  if (/^(恢復|重新啟動|重啟)(所有|全部)(的)?(自動|背景)?(任務|自動化|排程)$/.test(text)) return { kind: 'task_halt', halted: false };
  // "記住我對花生過敏" / "忘記我的舊地址": the user's own words, kept or removed (removal is confirmed).
  const remember = words.match(/^(?:請|麻煩)?(?:你|幫我)?(?:要)?記住[，,：:\s]*(.{2,200})$/);
  if (remember && !MULTI.test(words)) return { kind: 'memory_save', content: remember[1].replace(/^[，,：:\s]+/, '') };
  const forget = words.match(/^(?:請|麻煩)?(?:你|幫我)?(?:忘記|忘掉|刪除記憶|別再記得)[，,：:\s]*(.{1,60})$/);
  if (forget) return { kind: 'memory_forget', subject: forget[1] };
  // "每天早上8點提醒我喝水", "每週一早上9點給我早報", "如果這個月餐飲超過5000提醒我": a task, by rules.
  // The parser's date only matters for relative dates, which recurring rules never use.
  if (words.length <= 80 && !MULTI.test(words) && parseTaskText(words, '2026-01-01') !== null) return { kind: 'task_create', text: words };
  if (isReminderRequest(words) && REMINDER_TIME.test(words) && !MULTI.test(words) && words.length <= 80) return { kind: 'reminder_create', text: words };
  const calc = text.replace(/(等於多少|等於|是多少|=)$/, '');
  if (CALC.test(calc) && /\d\s*[+\-*/×÷x%]\s*[\d(]/.test(calc)) return { kind: 'calc', expression: calc };
  if (ACTION.test(text) || MULTI.test(text)) return null;
  const matches = RULES.map(([re, make]) => { const m = text.match(re); return m ? make(m) : null; }).filter((x): x is LocalIntent => x !== null);
  // More than one different reading is ambiguous: let the model (or the user) decide.
  const kinds = new Set(matches.map(m => m.kind));
  return kinds.size === 1 ? matches[0] : null;
}

/** Safe arithmetic: + - * / % and parentheses only, no eval. Null on anything else. */
export function calculate(expression: string): number | null {
  const tokens = expression.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '').match(/\d+(?:\.\d+)?|[-+*/%()]/g);
  if (!tokens || tokens.join('') !== expression.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === '(') { const v = sum(); if (next() !== ')') throw new Error('paren'); return v; }
    if (t === '-') return -primary();
    if (t === undefined || !/^\d/.test(t)) throw new Error('token');
    return Number(t);
  };
  const product = (): number => {
    let v = primary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next(); const r = primary();
      if ((op === '/' || op === '%') && r === 0) throw new Error('div0');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  try {
    const value = sum();
    return i === tokens.length && Number.isFinite(value) ? Math.round(value * 1e10) / 1e10 : null;
  } catch {
    return null;
  }
}
