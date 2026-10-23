import { cnNumber, parseAgendaText } from './parse';

// Reminder time from Chinese text, without any AI model. Relative times ("兩分鐘後",
// "1小時20分鐘後", "半小時後") are added to the server's current time; absolute times
// ("明天9點", "今晚8點", "10/26 15:00") resolve in Asia/Taipei. Everything is computed in
// UTC instants, so month and year ends need no special cases.

export interface ReminderTime {
  at: Date;
  kind: 'relative' | 'absolute';
  /** The words that gave the time, removed from the title. */
  phrase: string;
}

const NUM = '(\\d+|[零一二兩三四五六七八九十百]+)';
const AFTER = '(?:後|之後|以後)';
const RELATIVE: Array<[RegExp, (m: RegExpMatchArray) => number | null]> = [
  [new RegExp(`${NUM}\\s*個?\\s*(半)?\\s*(?:小時|鐘頭)\\s*(?:又)?\\s*${NUM}\\s*分(?:鐘)?\\s*${AFTER}`), m => hours(m[1], m[2]) + minutes(m[3])],
  [new RegExp(`${NUM}\\s*個?\\s*(半)?\\s*(?:小時|鐘頭)\\s*${AFTER}`), m => hours(m[1], m[2])],
  [new RegExp(`半\\s*個?\\s*(?:小時|鐘頭)\\s*${AFTER}`), () => 30],
  [new RegExp(`一刻鐘\\s*${AFTER}`), () => 15],
  [new RegExp(`${NUM}\\s*分(?:鐘)?\\s*${AFTER}`), m => minutes(m[1])],
  [new RegExp(`${NUM}\\s*天\\s*${AFTER}`), m => minutes(m[1]) * 24 * 60]
];

function num(text: string) {
  const n = cnNumber(text.replace(/^兩/, '二'));
  return Number.isFinite(n) ? n : NaN;
}
function hours(value: string, half?: string) { return num(value) * 60 + (half ? 30 : 0); }
function minutes(value: string) { return num(value); }

/** Explicit requests to be reminded (as opposed to just noting something down). */
export function isReminderRequest(text: string) {
  return /(提醒(我|一下)?|叫我|通知我|記得叫|鬧鐘)/.test(text);
}

/** Repeating reminders ("每天", "每週一") — not supported yet; never silently dropped. */
export function isRecurring(text: string) {
  return /(每天|每日|每晚|每早|每週|每周|每星期|每禮拜|每個?月|每年|每隔|每\s*\d+\s*(分鐘|小時|天))/.test(text);
}

function taipeiParts(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

function instant(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00+08:00`);
}

function nextDay(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The reminder time in `text`, or null when there is none (the caller must ask, not guess). */
export function parseReminderTime(text: string, now: Date): ReminderTime | null {
  for (const [re, toMinutes] of RELATIVE) {
    const m = text.match(re);
    if (!m) continue;
    const mins = toMinutes(m);
    if (mins === null || !Number.isFinite(mins) || mins <= 0 || mins > 366 * 24 * 60) return null;
    return { at: new Date(now.getTime() + mins * 60_000), kind: 'relative', phrase: m[0] };
  }

  // Absolute: reuse the agenda parser after spelling out 今晚 / 明早 / 明晚.
  const spelled = text.replace(/今晚/g, '今天晚上').replace(/明早/g, '明天早上').replace(/明晚/g, '明天晚上').replace(/今早/g, '今天早上');
  const { date: today, minutes: nowMinutes } = taipeiParts(now);
  const parsed = parseAgendaText(spelled, today);
  if (!parsed.due_time) return null;
  const phrase = (spelled.match(/(今天|今日|明天|明日|後天|大後天|\d{1,2}\s*[/月]\s*\d{1,2}\s*[日號号]?|(下下|下)?(週|周|星期|禮拜)[一二三四五六日天])?\s*(早上|上午|中午|下午|晚上|傍晚)?\s*([0-9一二兩三四五六七八九十]{1,3}\s*[點点時](半|[0-9一二三四五六七八九十]{1,3}分?)?|\d{1,2}[:：]\d{2})/) ?? [''])[0];
  let [h, mi] = parsed.due_time.split(':').map(Number);
  let date = parsed.due_date ?? today;
  if (!parsed.due_date) {
    const marked = /(早上|上午|中午|下午|晚上|傍晚)/.test(spelled);
    // "9點" said at 20:02 means 21:00; a time already passed today otherwise means tomorrow.
    if (h * 60 + mi <= nowMinutes) {
      if (!marked && h < 12 && (h + 12) * 60 + mi > nowMinutes) h += 12;
      else date = nextDay(today);
    }
  }
  const at = instant(date, `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  if (at.getTime() <= now.getTime()) return null;
  return { at, kind: 'absolute', phrase };
}

/** Title without the time and the "remind me" words: 「兩分鐘後提醒我看電腦」 → 「看電腦」. */
export function reminderTitle(text: string, phrase: string) {
  const title = text.replace(phrase, ' ')
    .replace(/今晚|明早|明晚|今早/g, ' ')
    .replace(/(請|麻煩)?(在)?(提醒(我|一下)?|叫我|通知我|記得叫我)(要|去)?/g, ' ')
    .replace(/^[\s，,、：:的要去]+|[\s，,、。！!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title || '提醒';
}

export function taipeiLabel(at: Date) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}
