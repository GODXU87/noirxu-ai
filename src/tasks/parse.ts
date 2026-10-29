import { parseAgendaText } from '@/agenda/parse';
import { cnNumber } from '@/agenda/parse';
import { reminderTitle } from '@/agenda/when';
import type { TaskCondition, TaskKind, TaskSchedule, TaskStep } from './model';

// Natural language → task, by fixed rules (no AI model). Covers recurring reminders,
// recurring briefings and spending watches. Anything else returns null so the model can
// plan it with the tasks.create tool; a recognised but incomplete request returns an error
// that says what is missing, and nothing is created.

export interface ParsedTask { title: string; kind: TaskKind; schedule: TaskSchedule; steps: TaskStep[]; condition?: TaskCondition; /** The time was not said; a default was used (shown to the user). */ default_time?: string }
export type TaskParse = { ok: true; task: ParsedTask } | { ok: false; error: string } | null;

const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const RECUR = /(每天|每日|每晚|每早|每天早上|每天晚上|工作日|平日|週末|周末|每週|每周|每星期|每禮拜|每個禮拜|每個星期|每個?月|每隔|每\s*[\d一二兩三四五六七八九十]+\s*(個)?\s*(小時|鐘頭|分鐘))/;

const EXPLICIT_HOUR = /[0-9一二兩三四五六七八九十]{1,3}\s*[點点時]|\d{1,2}[:：]\d{2}|中午/;

function clockTime(text: string, today: string): string | null {
  // A bare 早上 / 晚上 is not a time: never guess an hour for a recurring task.
  if (!EXPLICIT_HOUR.test(text)) return null;
  // parseAgendaText understands 早上8點 / 晚上9點半 / 21:30.
  return parseAgendaText(text.replace(/每天|每日|每晚|每早/g, m => (m === '每晚' ? '晚上' : m === '每早' ? '早上' : '')), today).due_time;
}

function scheduleOf(text: string, today: string): TaskSchedule | { error: string } | null {
  const interval = text.match(/每隔?\s*([\d一二兩三四五六七八九十]+)\s*個?\s*(小時|鐘頭|分鐘)/);
  if (interval) {
    const n = cnNumber(interval[1].replace(/^兩/, '二'));
    const minutes = interval[2] === '分鐘' ? n : n * 60;
    if (!Number.isFinite(minutes) || minutes < 30) return { error: '週期最短是 30 分鐘，避免頻繁打擾或對來源系統過量查詢。' };
    return { type: 'interval', minutes };
  }
  const time = clockTime(text, today);
  const monthly = text.match(/每個?月\s*([\d一二兩三四五六七八九十]+)\s*[號日]/);
  if (monthly) return time ? { type: 'monthly', day: cnNumber(monthly[1].replace(/^兩/, '二')), time } : { error: '每月的提醒需要時間，例如「每月 5 號早上 9 點」。' };
  let weekdays: number[] | null = null;
  if (/(工作日|平日)/.test(text)) weekdays = [1, 2, 3, 4, 5];
  else if (/(週末|周末)/.test(text)) weekdays = [0, 6];
  else {
    const weekly = text.match(/每(?:個)?(?:週|周|星期|禮拜)([一二三四五六日天、和及,，\s]+)/);
    if (weekly) weekdays = [...new Set([...weekly[1]].map(c => WEEKDAYS[c]).filter((d): d is number => d !== undefined))];
  }
  if (weekdays?.length) return time ? { type: 'weekly', weekdays: weekdays.sort(), time } : { error: '每週的提醒需要時間，例如「每週一早上 9 點」。' };
  if (/(每天|每日|每晚|每早)/.test(text)) return time ? { type: 'daily', time } : { error: '每天的提醒需要時間，例如「每天早上 8 點」。' };
  return null;
}

export function parseTaskText(raw: string, today: string): TaskParse {
  const text = raw.trim();

  const watch = text.match(/(?:如果|若|當)\s*(?:這個月|本月|這月)?\s*(?:的)?\s*([一-龥A-Za-z]{0,8}?)\s*(?:支出|花費|開銷|花)\s*(?:超過|大於|高於|超出)\s*([\d,]+)\s*(?:元|塊)?/);
  if (watch && /(提醒|通知|告訴|跟我說)/.test(text)) {
    const amount = Number(watch[2].replace(/,/g, ''));
    const category = watch[1] && !/^(總|全部|所有|總共)$/.test(watch[1]) ? watch[1] : undefined;
    return {
      ok: true,
      task: {
        title: `${category ?? '本月'}支出超過 ${amount.toLocaleString('en-US')}`,
        kind: 'conditional',
        schedule: { type: 'interval', minutes: 360 },
        condition: { type: 'ledger_month_expense_over', amount, ...(category ? { category } : {}) },
        steps: [{ type: 'notify', title: `${category ?? '本月'}支出已超過 ${amount.toLocaleString('en-US')}`, body: '' }]
      }
    };
  }

  if (!RECUR.test(text)) return null;
  let schedule = scheduleOf(text, today);
  if (!schedule) return null;
  // A daily briefing ("每天晚上幫我整理明天的工作") without an hour gets a default time that the reply states.
  const briefing = /(早報|整理今天|今天的(工作|事|行程))/.test(text) ? 'morning' as const : /(晚報|整理明天|明天的(工作|事|行程))/.test(text) ? 'evening' as const : null;
  let defaultTime: string | undefined;
  if ('error' in schedule && briefing && /(每天|每日|每晚|每早)/.test(text) && !/(每週|每周|每月|工作日|平日|週末|周末)/.test(text)) {
    defaultTime = briefing === 'morning' ? '08:00' : '21:00';
    schedule = { type: 'daily', time: defaultTime };
  }
  // "幫我想個週末去哪走走" mentions a recurring word but asks for no reminder: not a task at all.
  if ('error' in schedule && !briefing && !/(提醒|叫我|通知|記得|告訴我|跟我說)/.test(text)) return null;
  if ('error' in schedule) return { ok: false, error: `${schedule.error}這次沒有建立任何任務。` };
  const describe = text.replace(RECUR, ' ').replace(/^\s*(的)?[一二三四五六日天、和及,，]+(?=[早上午中下晚傍\d一二兩三四五六七八九十])/, ' ');
  const onlyImportant = /重要的?(事|事情)?(再|才)(通知|提醒|告訴)|有重要/.test(text);
  if (briefing) {
    const title = briefing === 'morning' ? (/早報/.test(text) ? '早報' : '早上整理今天的工作') : (/晚報/.test(text) ? '晚報' : '晚上整理明天的工作');
    return { ok: true, task: { title, kind: 'recurring', schedule, steps: [{ type: 'briefing', which: briefing, only_if_important: onlyImportant }], ...(defaultTime ? { default_time: defaultTime } : {}) } };
  }
  if (!/(提醒|叫我|通知我|記得)/.test(text)) return null;
  const phrase = describe.match(/(早上|上午|中午|下午|晚上|傍晚)?\s*([0-9一二兩三四五六七八九十]{1,3}\s*[點点時](半|[0-9一二三四五六七八九十]{1,3}分?)?|\d{1,2}[:：]\d{2})/)?.[0] ?? '';
  const title = reminderTitle(describe, phrase).replace(/^(早上|上午|中午|下午|晚上|傍晚)/, '').trim() || '提醒';
  return { ok: true, task: { title, kind: 'recurring', schedule, steps: [{ type: 'notify', title, body: '' }] } };
}
