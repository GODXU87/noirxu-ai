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

interface Deps { executor: Executor; ctx: ToolContext; memory: MemorySource | null; isConnected: (connection: string) => Promise<boolean> }

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** Sir at most once, and only in some replies, so it never becomes a fixed opener. */
function sirFor(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 3 === 0;
}

function withSir(text: string, seed: string) {
  return sirFor(seed) ? text.replace(/。$/, '，Sir。') : text;
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
  const local = (reply: string): LocalTurn => ({ level: 'L0', source: 'local', intent: intent.kind, reply, events: [] });

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
      return { level: 'L1', source: 'tool', intent: intent.kind, reply: `${opener}${sirFor(seed) ? '，Sir' : ''}。${plan}`, events: [] };
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
