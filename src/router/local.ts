import type { WeatherToday } from '@/weather/open-meteo';
import type { UsQuote } from '@/markets/us';
import { TYPE_LABEL } from '@/briefing/weekly';
import type { Executor } from '@/hub/executor';
import type { ToolContext } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';
import type { ToolEvent } from '@/server/agent';
import { calculate, type LocalIntent } from './intents';
import { conflicting, searchMemories, type MemorySource } from './memory';

// Answers that need no language model: rules (L0) or a direct read of real data (L1).
// Replies are short, factual and in SASUKE's voice; no wit is spent here, because a joke is
// never worth a model call and canned jokes go stale.

export interface LocalTurn {
  level: 'L0' | 'L1';
  source: 'local' | 'memory' | 'tool';
  intent: LocalIntent['kind'];
  reply: string;
  events: ToolEvent[];
}

interface Deps { executor: Executor; ctx: ToolContext; memory: MemorySource | null; isConnected: (connection: string) => Promise<boolean>; schedulerAgeMinutes?: () => Promise<number | null>; briefing?: (which: 'morning' | 'evening') => Promise<{ title: string; full: string[]; card: unknown }>; weather?: (day: 0 | 1) => Promise<WeatherToday | null>; usQuotes?: () => Promise<{ quotes: UsQuote[]; errors: string[] } | null> }

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** Which side "Sir" goes on, varied by the seed so it never reads as a fixed opener. */
function sirFor(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 === 0;
}

/** Every reply addresses Sir once: in front or at the end of the first sentence. */
function withSir(text: string, seed: string) {
  if (/Sir/.test(text)) return text;
  return sirFor(seed) ? `Sir，${text}` : text.replace(/。/, '，Sir。');
}

function taipeiParts(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now).map(p => [p.type, p.value]));
  const date = taipeiDate(now);
  return { month: Number(parts.month), day: Number(parts.day), hour: parts.hour, minute: parts.minute, weekday: WEEKDAY[new Date(`${date}T12:00:00+08:00`).getUTCDay()] };
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface AgendaRow { title: string; due_date: string | null; due_time: string | null; due_label: string; days_left: number | null; priority: string }

function listLine(rows: AgendaRow[], max = 4) {
  const shown = rows.slice(0, max).map(r => `${r.due_time ? `${r.due_time} ` : ''}${r.title}`);
  return `${shown.join('、')}${rows.length > max ? ` 等 ${rows.length} 件` : ''}`;
}

export async function runLocal(intent: LocalIntent, deps: Deps): Promise<LocalTurn> {
  const { executor, ctx } = deps;
  const now = ctx.now();
  const seed = `${intent.kind}:${now.toISOString().slice(0, 16)}`;
  const local = (reply: string): LocalTurn => ({ level: 'L0', source: 'local', intent: intent.kind, reply: withSir(reply, seed), events: [] });

  switch (intent.kind) {
    case 'greeting': {
      if (intent.which === 'thanks') return local(withSir('不客氣。', seed));
      if (intent.which === 'hello') return local(withSir('在。需要我處理什麼？', seed));
      const today = taipeiDate(now);
      const target = intent.which === 'night' ? addDays(today, 1) : today;
      const result = await executor.invoke('agenda.items.list', { days: 2 }, ctx);
      const rows = result.status === 'ok' ? (result.data as { items: AgendaRow[] }).items.filter(r => r.due_date === target) : [];
      const opener = intent.which === 'morning' ? '早安' : intent.which === 'noon' ? '午安' : '晚安';
      const plan = rows.length ? `${intent.which === 'night' ? '明天' : '今天'}有 ${rows.length} 件事：${listLine(rows, 3)}。` : `${intent.which === 'night' ? '明天' : '今天'}沒有排定的事。`;
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: `${opener}，Sir。${plan}`, events: [] };
    }
    case 'identity':
      return local('我是 SASUKE（佐助），你的私人數位管家。記帳、交易紀錄、RADAR 研究、Gmail、提醒和喝水都可以交給我；寫入帳本或寄信之前，一定先讓你確認。');
    case 'datetime': {
      const t = taipeiParts(now);
      if (intent.what === 'time') return local(`現在是台北時間 ${t.hour}:${t.minute}。`);
      if (intent.what === 'weekday') return local(`今天是星期${t.weekday}（${t.month}/${t.day}）。`);
      return local(`今天是 ${t.month} 月 ${t.day} 日，星期${t.weekday}。`);
    }
    case 'calc': {
      const value = calculate(intent.expression);
      return local(value === null ? '這個算式我沒辦法安全地計算，請確認一下格式。' : `${intent.expression} = ${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
    }
    case 'water_status': {
      const result = await executor.invoke('health.water.status', {}, ctx);
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: '喝水紀錄目前讀不到，請稍後再試。', events: [{ tool: 'health.water.status', input: {}, result }] };
      const d = result.data as { total_ml: number; goal_ml: number; expected_ml: number; behind_ml: number; remaining_ml: number };
      const state = d.remaining_ml === 0 ? '今天的目標已經達成。' : d.behind_ml > 0 ? `照進度現在應到 ${fmt(d.expected_ml)} ml，落後 ${fmt(d.behind_ml)} ml；下一杯正常喝就好，不用一次補完。` : `進度正常，還差 ${fmt(d.remaining_ml)} ml。`;
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(`今天喝了 ${fmt(d.total_ml)} / ${fmt(d.goal_ml)} ml。${state}`, seed), events: [{ tool: 'health.water.status', input: {}, result }] };
    }
    case 'agenda': {
      const today = taipeiDate(now);
      const days = intent.range === 'week' ? 7 : intent.range === 'upcoming' ? 14 : 2;
      const input = { days };
      const result = await executor.invoke('agenda.items.list', input, ctx);
      const event = { tool: 'agenda.items.list', input, result };
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: '待辦清單目前讀不到，請稍後再試。', events: [event] };
      const items = (result.data as { items: AgendaRow[] }).items;
      const overdue = items.filter(r => r.days_left !== null && r.days_left < 0);
      const pick = intent.range === 'today' ? items.filter(r => r.due_date === today)
        : intent.range === 'tomorrow' ? items.filter(r => r.due_date === addDays(today, 1))
        : intent.range === 'overdue' ? overdue
        : items.filter(r => r.days_left !== null && r.days_left >= 0);
      const label = { today: '今天', tomorrow: '明天', week: '這週', overdue: '已過期的', upcoming: '近期' }[intent.range];
      let reply = pick.length ? `${label}${intent.range === 'overdue' ? '事有' : '有'} ${pick.length} 件：${listLine(pick)}。` : intent.range === 'overdue' ? '沒有過期的事。' : `${label}沒有排定的事。`;
      if (intent.range !== 'overdue' && overdue.length) reply += `另外有 ${overdue.length} 件已過期：${listLine(overdue, 2)}。`;
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(reply, seed), events: [event] };
    }
    case 'ledger_month': {
      if (!(await deps.isConnected('ledger'))) return { level: 'L1', source: 'tool', intent: intent.kind, reply: 'Ledger 還沒連接，讀不到收支。到「設定與連線」登入 Ledger 後，這個問題我就能直接回答。', events: [] };
      const today = taipeiDate(now);
      const month = intent.which === 'this' ? today.slice(0, 7) : addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
      const input = { month };
      const result = await executor.invoke('ledger.analytics.get', input, ctx);
      const event = { tool: 'ledger.analytics.get', input, result };
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: `Ledger 目前讀不到資料（${result.status === 'error' ? result.message : '未知原因'}），我不會用估計值代替。`, events: [event] };
      const a = result.data as { currency: string; summary: { expense: number; income: number; expenseCount: number }; expense_by_category: Array<{ name: string; amount: number; percentage: number }> };
      const top = a.expense_by_category[0];
      const name = `${Number(month.slice(5))} 月${intent.which === 'this' ? '目前' : ''}`;
      const reply = a.summary.expenseCount === 0
        ? `${name}還沒有支出紀錄。`
        : `${name}支出 ${a.currency} ${fmt(a.summary.expense)}，共 ${a.summary.expenseCount} 筆${top ? `；最多是${top.name} ${fmt(top.amount)}（${Math.round(top.percentage)}%）` : ''}。`;
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(reply, seed), events: [event] };
    }
    case 'reminder_create': {
      const input = { text: intent.text };
      const result = await executor.invoke('agenda.items.create', input, ctx);
      const event = { tool: 'agenda.items.create', input, result };
      // A failed parse or a recurring request is reported as such; nothing is pretended.
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: result.status === 'error' ? result.message : '提醒沒有建立。', events: [] };
      const data = result.data as { item: { title: string }; scheduled: boolean; reminders: Array<{ at: string; local: string }> };
      const first = data.reminders[0];
      if (!data.scheduled || !first) return { level: 'L1', source: 'tool', intent: intent.kind, reply: '這個時間已經過了，提醒沒有排上。請給我一個未來的時間。', events: [event] };
      const at = new Date(first.at);
      const minutesAway = Math.round((at.getTime() - now.getTime()) / 60_000);
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
      const when = minutesAway < 60 ? `${minutesAway} 分鐘後（${hhmm}）` : minutesAway < 24 * 60 && taipeiDate(at) === taipeiDate(now) ? `今天 ${hhmm}` : first.local;
      let reply = `${sirFor(seed) ? 'Sir，' : ''}已設定 ${when}提醒你${data.item.title === '提醒' ? '' : data.item.title}。`;
      if (minutesAway <= 60) {
        const age = await deps.schedulerAgeMinutes?.().catch(() => null);
        // The scheduler runs every minute when the external cron is set up; say so only when it really is.
        reply += age !== null && age !== undefined && age <= 3 ? 'App 關閉也會送出，最多晚約 1 分鐘。' : `App 開著時會準時提醒；App 關閉時要靠背景排程${age === null || age === undefined ? '' : `（最近一次執行在 ${age} 分鐘前）`}，可能會晚到。`;
      }
      return { level: 'L1', source: 'tool', intent: intent.kind, reply, events: [event] };
    }
    case 'task_create': {
      const input = { text: intent.text };
      const result = await executor.invoke('tasks.create', input, ctx);
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: result.status === 'error' ? (result.code === 'UNKNOWN_TOOL' ? '自動任務功能目前沒有開啟，這次沒有建立任何任務。' : result.message) : '任務沒有建立。', events: [] };
      const { task, default_time } = result.data as { default_time?: string; task: { title: string; kind: string; schedule_label: string; next_local: string | null; steps: Array<{ only_if_important?: boolean }> } };
      const what = task.kind === 'conditional' ? `每 6 小時檢查一次 Ledger，${task.title}時通知你（同一個月只通知一次）` : `${task.schedule_label}：${task.title}`;
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: `${sirFor(seed) ? 'Sir，' : ''}已建立自動任務——${what}。${default_time ? `你沒指定時間，先用 ${default_time}，要改說一聲就好。` : ''}${task.steps.some(s => s.only_if_important) ? '只有緊急或重要的事才會通知你。' : ''}下次執行 ${task.next_local}。背景排程執行，不需要開著 App；隨時可以暫停或取消。`, events: [{ tool: 'tasks.create', input, result }] };
    }
    case 'task_list': {
      const input = { include_finished: false };
      const result = await executor.invoke('tasks.list', input, ctx);
      const event = { tool: 'tasks.list', input, result };
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: result.status === 'error' && result.code === 'UNKNOWN_TOOL' ? '自動任務功能目前沒有開啟。' : '任務清單目前讀不到，請稍後再試。', events: [] };
      const tasks = (result.data as { tasks: Array<{ title: string; status_label: string; schedule_label: string; next_local: string | null }> }).tasks;
      const reply = tasks.length
        ? `目前有 ${tasks.length} 個自動任務：${tasks.slice(0, 4).map(t => `${t.title}（${t.schedule_label}，${t.status_label}）`).join('、')}${tasks.length > 4 ? ' 等' : ''}。`
        : '目前沒有自動任務。可以說「每天早上 8 點提醒我喝水」來建立一個。';
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(reply, seed), events: [event] };
    }
    case 'task_halt': {
      const input = { halted: intent.halted };
      const result = await executor.invoke('tasks.halt', input, ctx);
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: result.status === 'error' && result.code === 'UNKNOWN_TOOL' ? '自動任務功能目前沒有開啟。' : '沒有成功切換，背景任務維持原狀。', events: [] };
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: intent.halted ? '已停止所有背景自動任務。任務與紀錄都還在，說「恢復所有任務」就會從下一個排程繼續。' : '背景自動任務已恢復，會從下一個排程繼續；停止期間錯過太久的週期不會補跑。', events: [{ tool: 'tasks.halt', input, result }] };
    }
    case 'garmin': {
      const notOk = (result: Awaited<ReturnType<Executor['invoke']>>) => (result.status === 'error' && result.code === 'UNKNOWN_TOOL' ? 'Garmin 功能目前沒有開啟。' : result.status === 'error' ? result.message : 'Garmin 資料目前讀不到。');
      if (intent.which === 'steps') {
        const result = await executor.invoke('garmin.health.daily', {}, ctx);
        if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: notOk(result), events: [] };
        const d = result.data as { steps: number | null; step_goal: number | null; distance_m: number | null };
        const event = { tool: 'garmin.health.daily', input: {}, result };
        if (d.steps === null) return { level: 'L1', source: 'tool', intent: intent.kind, reply: 'Garmin 還沒有今天的步數，手錶可能還沒同步。', events: [event] };
        const left = d.step_goal && d.steps < d.step_goal ? `，離目標還差 ${fmt(d.step_goal - d.steps)} 步` : d.step_goal ? '，今天的目標已經達成' : '';
        return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(`今天走了 ${fmt(d.steps)} 步${d.distance_m ? `（約 ${(d.distance_m / 1000).toFixed(1)} 公里）` : ''}${left}。`, seed), events: [event] };
      }
      if (intent.which === 'compare') {
        const result = await executor.invoke('garmin.training.compare', {}, ctx);
        if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: notOk(result), events: [] };
        const d = result.data as { by_type: Array<{ type: string; this_week: { count: number; minutes: number; km: number }; last_week: { count: number; minutes: number }; change_pct: { minutes: number | null } }> };
        const event = { tool: 'garmin.training.compare', input: {}, result };
        if (!d.by_type.length) return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir('最近兩週 Garmin 沒有運動紀錄。', seed), events: [event] };
        const now7 = d.by_type.reduce((a, t) => a + t.this_week.minutes, 0);
        const last7 = d.by_type.reduce((a, t) => a + t.last_week.minutes, 0);
        const total = last7 > 0 ? `總量 ${fmt(last7)} → ${fmt(now7)} 分鐘（${now7 >= last7 ? '+' : ''}${Math.round(((now7 - last7) / last7) * 100)}%）` : `這週共 ${fmt(now7)} 分鐘`;
        const rows = [...d.by_type].sort((a, b) => b.this_week.minutes - a.this_week.minutes).map(t => `${TYPE_LABEL[t.type] ?? t.type}：${t.this_week.count} 次 ${fmt(t.this_week.minutes)} 分${t.this_week.km ? `、${t.this_week.km} km` : ''}（上週 ${fmt(t.last_week.minutes)} 分${t.change_pct.minutes === null ? '' : `，${t.change_pct.minutes >= 0 ? '+' : ''}${t.change_pct.minutes}%`}）`);
        const hint = last7 > 0 && (now7 - last7) / last7 >= 0.3 ? '\n量一下子加了三成以上，留意恢復，睡眠要跟上。' : '';
        return { level: 'L1', source: 'tool', intent: intent.kind, reply: `Sir，最近 7 天和前 7 天比較，${total}。\n${rows.join('\n')}${hint}`, events: [event] };
      }
      if (intent.which === 'sleep_trend') {
        const result = await executor.invoke('garmin.sleep.trend', { nights: 7 }, ctx);
        if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: notOk(result), events: [] };
        const d = result.data as { nights: Array<{ date: string; duration_s: number }>; average_s: number | null; previous_average_s: number | null; shortest: { date: string; duration_s: number } | null; longest: { date: string; duration_s: number } | null; short_nights: number };
        const event = { tool: 'garmin.sleep.trend', input: { nights: 7 }, result };
        if (!d.average_s) return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir('最近 7 晚 Garmin 沒有睡眠資料，手錶可能還沒同步。', seed), events: [event] };
        const hm = (sec: number) => `${Math.floor(sec / 3600)} 小時 ${Math.round((sec % 3600) / 60)} 分`;
        const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
        const diff = d.previous_average_s ? Math.round((d.average_s - d.previous_average_s) / 60) : null;
        const vs = diff === null ? '' : Math.abs(diff) < 10 ? '，和前一週差不多' : diff > 0 ? `，比前一週多 ${diff} 分鐘` : `，比前一週少 ${-diff} 分鐘`;
        const range = d.shortest && d.longest ? `最短 ${md(d.shortest.date)} ${hm(d.shortest.duration_s)}，最長 ${md(d.longest.date)} ${hm(d.longest.duration_s)}。` : '';
        const advice = d.short_nights >= 3 ? `有 ${d.short_nights} 晚不到 6.5 小時，這幾天早點上床，訓練強度先別往上加。` : d.short_nights ? `有 ${d.short_nights} 晚不到 6.5 小時，其他都還可以。` : '每晚都有 6.5 小時以上，維持就好。';
        return { level: 'L1', source: 'tool', intent: intent.kind, reply: `Sir，最近 ${d.nights.length} 晚平均睡 ${hm(d.average_s)}${vs}。${range}\n${advice}`, events: [event] };
      }
      // Sleep and body status: the full analysis (baselines, readiness, today's plan, hydration).
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(now));
      const when = intent.which === 'sleep' || hour < 15 ? 'morning' : 'evening';
      const input = { when };
      const result = await executor.invoke('garmin.health.insight', input, ctx);
      if (result.status !== 'ok') return { level: 'L1', source: 'tool', intent: intent.kind, reply: notOk(result), events: [] };
      const d = result.data as { narrative: string[]; gaps: string[] };
      const gaps = d.gaps.length ? `\n（還沒有：${d.gaps.join('、')}）` : '';
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: `${d.narrative.join('\n')}${gaps}`, events: [{ tool: 'garmin.health.insight', input, result }] };
    }
    case 'weather': {
      const label = intent.day === 1 ? '明天' : '今天';
      if (!deps.weather) return local('天氣功能目前沒有開啟。');
      const w = await deps.weather(intent.day).catch(() => null);
      if (!w) return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir('天氣服務暫時連不上，稍後再問我一次。', seed), events: [] };
      const temp = w.temp_min !== null && w.temp_max !== null ? ` ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C` : '';
      const rain = w.rain_chance !== null ? `，降雨機率 ${Math.round(w.rain_chance)}%` : '';
      const advice = w.advice.length ? `${w.advice.join('，')}。` : (w.rain_chance ?? 0) < 30 ? '不用帶傘。' : '';
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(`${label}${w.place}${w.summary}${temp}${rain}。${advice}`, seed), events: [] };
    }
    case 'markets_us': {
      if (!deps.usQuotes) return local('美股行情目前沒有開啟。');
      const r = await deps.usQuotes().catch(() => null);
      if (!r || !r.quotes.length) return { level: 'L1', source: 'tool', intent: intent.kind, reply: withSir(`美股行情暫時讀不到${r?.errors[0] ? `（${r.errors[0]}）` : ''}，稍後再試。`, seed), events: [] };
      const day = r.quotes.map(q => q.date).sort().at(-1)!;
      const lines = r.quotes.map(q => `${q.label} ${q.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}${q.change_pct === null ? '' : `（${q.change_pct > 0 ? '+' : ''}${q.change_pct.toFixed(2)}%）`}`);
      const missing = r.errors.length ? `\n另有 ${r.errors.length} 檔暫時讀不到。` : '';
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: `Sir，美股 ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} 收盤：\n${lines.join('\n')}${missing}\n（僅供參考，不是投資建議。）`, events: [] };
    }
    case 'capabilities':
      return local('我可以直接幫你：記帳（確認後才寫入 Ledger）、查本月支出、記待辦和提醒（例如「明天 9 點提醒我開會」）、建立每天的自動任務、看 Garmin 的睡眠與身體狀況、天氣、美股收盤、RADAR 研究、早報晚報和週報、記住你交代的事。輸入 / 可以看全部快捷指令。');
    case 'briefing': {
      if (!deps.briefing) return local('早晚報目前無法產生，請稍後再試。');
      const b = await deps.briefing(intent.which);
      const result = { status: 'ok' as const, tool: 'assistant.briefing.card', data: b.card, links: [] };
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: intent.which === 'morning' ? '早報整理好了，Sir。' : '晚報整理好了，Sir。', events: [{ tool: 'assistant.briefing.card', input: {}, result }] };
    }
    case 'memory_save': {
      const input = { content: intent.content };
      const result = await executor.invoke('memory.save', input, ctx);
      if (result.status !== 'ok') return { level: 'L1', source: 'memory', intent: intent.kind, reply: result.status === 'error' ? result.message : '這次沒有記下來。', events: [] };
      const updated = (result.data as { updated: boolean }).updated;
      return { level: 'L1', source: 'memory', intent: intent.kind, reply: `${updated ? '這件事我本來就記著，已經更新了' : '記住了'}，Sir：${intent.content.replace(/[。.]+$/, '')}。之後需要時我會用上；想看或修改，在「個人記憶」。`, events: [{ tool: 'memory.save', input, result }] };
    }
    case 'memory_forget': {
      const found = await executor.invoke('memory.search', { query: intent.subject }, ctx);
      const hits = found.status === 'ok' ? (found.data as { memories: Array<{ id: string; content: string }> }).memories : [];
      if (!hits.length) return { level: 'L1', source: 'memory', intent: intent.kind, reply: `我沒有記著和「${intent.subject}」有關的事。`, events: [] };
      const input = { id: hits[0].id };
      const result = await executor.invoke('memory.forget', input, ctx);
      return { level: 'L1', source: 'memory', intent: intent.kind, reply: `找到這筆：「${hits[0].content}」。確認後就刪除${hits.length > 1 ? `；另外還有 ${hits.length - 1} 筆相關的，可以到「個人記憶」查看` : ''}。`, events: [{ tool: 'memory.forget', input, result }] };
    }
    case 'memory_recall': {
      const subject = intent.subject.replace(/^(的)/, '');
      if (!deps.memory) return { level: 'L1', source: 'memory', intent: intent.kind, reply: `長期記憶目前還沒啟用，所以我沒有保存你的${subject}。告訴我的話，這段對話裡我會記得。`, events: [] };
      const hits = searchMemories(await deps.memory.list(ctx.userId), subject, 3, now);
      if (!hits.length) return { level: 'L1', source: 'memory', intent: intent.kind, reply: `我沒有保存你的${subject}。`, events: [] };
      const best = hits[0];
      let reply = `記得：${best.record.content}（${best.record.updated_at.slice(0, 10)} 記錄）。`;
      if (best.stale) reply += '這筆有一段時間了，可能已經變了。';
      if (conflicting(hits)) reply += '不過我還有另一筆不一致的紀錄，建議到「個人記憶」確認哪一筆正確。';
      return { level: 'L1', source: 'memory', intent: intent.kind, reply, events: [] };
    }
  }
}
