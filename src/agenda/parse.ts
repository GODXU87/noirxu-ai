// Turns short Chinese notes like 「11/11 要教學演示」 or 「明天下午3點 牙醫 很重要」 into
// structured agenda items without an AI model. Dates resolve in Asia/Taipei.

export interface ParsedAgenda {
  title: string;
  due_date: string | null;
  due_time: string | null;
  importance: 1 | 2 | 3;
}

const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function addDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function cnNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (CN_NUM[text[1]] ?? 0);
  if (text.endsWith('十')) return (CN_NUM[text[0]] ?? 0) * 10;
  if (text.includes('十')) return (CN_NUM[text[0]] ?? 0) * 10 + (CN_NUM[text[2]] ?? 0);
  return CN_NUM[text] ?? NaN;
}

/** `today` is the Taipei date (YYYY-MM-DD). */
export function parseAgendaText(input: string, today: string): ParsedAgenda {
  let text = ` ${input.trim()} `;
  let dueDate: string | null = null;
  let dueTime: string | null = null;
  let importance: 1 | 2 | 3 = 2;
  const take = (re: RegExp) => { text = text.replace(re, ' '); };

  // Importance words.
  if (/(非常重要|很重要|超重要|緊急|重要|務必|一定要)/.test(text)) importance = 3;
  else if (/(不急|有空再|順便|低優先)/.test(text)) importance = 1;
  take(/(非常重要|很重要|超重要|緊急|重要|務必|不急|有空再|順便|低優先)/g);

  const year = Number(today.slice(0, 4));
  let match: RegExpExecArray | null;

  if ((match = /(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})[日號号]?/.exec(text))) {
    dueDate = iso(Number(match[1]), Number(match[2]), Number(match[3]));
    take(new RegExp(match[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  } else if ((match = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*[日號号]?/.exec(text))) {
    const m = Number(match[1]);
    const d = Number(match[2]);
    // A month/day already passed this year means next year.
    let candidate = iso(year, m, d);
    if (candidate && candidate < today) candidate = iso(year + 1, m, d);
    dueDate = candidate;
    take(new RegExp(match[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  } else if ((match = /(今天|今日|明天|明日|後天|大後天)/.exec(text))) {
    dueDate = addDays(today, { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 後天: 2, 大後天: 3 }[match[1]] ?? 0);
    take(new RegExp(match[1]));
  } else if ((match = /(下下|下)?(?:週|周|星期|禮拜)([一二三四五六日天])/.exec(text))) {
    // ISO weekdays (Mon=1 … Sun=7). 「週三」 = this week's or the coming Wednesday;
    // 「下週三」 = Wednesday of next calendar week; 「下下週三」 = the week after.
    const isoTarget = WEEKDAYS[match[2]] || 7;
    const isoToday = weekday(today) || 7;
    if (!match[1]) {
      dueDate = addDays(today, (isoTarget - isoToday + 7) % 7);
    } else {
      const nextMonday = addDays(today, 8 - isoToday);
      dueDate = addDays(nextMonday, isoTarget - 1 + (match[1] === '下下' ? 7 : 0));
    }
    take(new RegExp(match[0]));
  } else if ((match = /(\d{1,2})\s*[日號号]/.exec(text))) {
    const d = Number(match[1]);
    const [, m] = today.split('-').map(Number);
    let candidate = iso(year, m, d);
    if (candidate && candidate < today) candidate = m === 12 ? iso(year + 1, 1, d) : iso(year, m + 1, d);
    dueDate = candidate;
    take(new RegExp(match[0]));
  }

  if ((match = /(\d{1,2})[:：](\d{2})/.exec(text))) {
    const h = Number(match[1]);
    const mi = Number(match[2]);
    if (h < 24 && mi < 60) dueTime = `${pad(h)}:${pad(mi)}`;
    take(new RegExp(match[0]));
  } else if ((match = /(早上|上午|中午|下午|晚上|傍晚)?\s*([0-9一二兩三四五六七八九十]{1,3})\s*[點点時](半|([0-9一二三四五六七八九十]{1,3})分?)?/.exec(text))) {
    let h = cnNumber(match[2]);
    const minutes = match[3] === '半' ? 30 : match[4] ? cnNumber(match[4]) : 0;
    if ((match[1] === '下午' || match[1] === '晚上' || match[1] === '傍晚') && h < 12) h += 12;
    if (match[1] === '中午' && h < 11) h += 12;
    if (Number.isFinite(h) && h < 24 && minutes < 60) dueTime = `${pad(h)}:${pad(minutes)}`;
    take(new RegExp(match[0]));
  } else if ((match = /(早上|上午|中午|下午|晚上)/.exec(text))) {
    dueTime = { 早上: '09:00', 上午: '09:00', 中午: '12:00', 下午: '14:00', 晚上: '19:00' }[match[1]] ?? null;
    take(new RegExp(match[1]));
  }

  const title = text
    .replace(/^(\s|要|記得|提醒我|幫我記|幫我記住|記一下|有|的|：|:|，|,)+/g, ' ')
    .replace(/[，,、。]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title || input.trim(), due_date: dueDate, due_time: dueTime, importance };
}
