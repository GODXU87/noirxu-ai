import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dueLabel } from '@/agenda/briefing';
import { parseAgendaText } from '@/agenda/parse';
import { DEFAULT_REMINDER_PREFS, PRIORITY_LABEL, daysUntil, priorityOf, rankItems, reminderSchedule, taipeiInstant, type AgendaItem, type ReminderPrefs } from '@/agenda/rank';
import { isRecurring, isReminderRequest, parseReminderTime, reminderTitle, taipeiLabel } from '@/agenda/when';
import type { AgendaStore } from '@/agenda/store';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { isCalendarDate, taipeiDate } from '@/lib/dates';

const calendarDate = z.string().refine(isCalendarDate, '日期需為 YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間需為 HH:MM');
const importance = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const itemView = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  due_date: z.string().nullable(),
  due_time: z.string().nullable(),
  importance,
  status: z.enum(['open', 'done', 'cancelled']),
  priority: z.enum(['urgent', 'high', 'normal', 'low']),
  priority_label: z.string(),
  due_label: z.string(),
  days_left: z.number().nullable()
});

export function agendaView(item: AgendaItem, today: string): z.output<typeof itemView> {
  const priority = priorityOf(item, today);
  return {
    id: item.id, title: item.title, notes: item.notes, due_date: item.due_date, due_time: item.due_time, importance: item.importance,
    status: item.status, priority, priority_label: PRIORITY_LABEL[priority], due_label: dueLabel(item, today), days_left: daysUntil(item.due_date, today)
  };
}

export const REMINDER_PREFS_KEY = 'reminder:prefs';

export async function reminderPrefs(store: AgendaStore): Promise<ReminderPrefs> {
  try { return { ...DEFAULT_REMINDER_PREFS, ...JSON.parse((await store.getSetting(REMINDER_PREFS_KEY)) ?? '{}') }; } catch { return DEFAULT_REMINDER_PREFS; }
}

/**
 * Reminders for an item. An explicit reminder (source 'reminder') fires once, exactly at the
 * time the user asked; other items get the advance notices from the user's preferences.
 */
async function schedule(store: AgendaStore, item: AgendaItem, now: Date, exactAt?: Date) {
  if (item.source === 'reminder') {
    const at = exactAt ?? (item.due_date && item.due_time ? taipeiInstant(item.due_date, item.due_time) : null);
    return at && at.getTime() > now.getTime() ? [{ id: randomUUID(), remind_at: at.toISOString(), label: '提醒' }] : [];
  }
  return reminderSchedule(item, now, await reminderPrefs(store)).map(r => ({ id: randomUUID(), remind_at: r.at.toISOString(), label: r.label }));
}

function taipeiHHMM(at: Date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

export function agendaTools(store: AgendaStore): ToolDefinition[] {
  return [
    defineTool({
      name: 'agenda.items.create',
      description: '把使用者說的事情記進 NOIRXU AI 的行程/記事，或建立提醒。使用者要求「提醒我」（例如「兩分鐘後提醒我看電腦」「明天9點提醒我開會」）時，直接把原句傳 text：系統會用伺服器時間精確算出提醒時間並只在那個時間提醒一次；算不出時間會回傳錯誤，這時請問使用者時間，不可改建無日期記事。一般記事（例如「11/11 要教學演示」）會依使用者設定加上提前通知。同一件事有多個時段時，建立一筆並在 notes 註明時段，不要拆成很多筆。重複提醒（每天、每週）與條件監看請改用 tasks.create。這是 NOIRXU AI 自己的記事，不需確認。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        text: z.string().trim().min(1).max(300).optional().describe('使用者原句，例如「11/11 要教學演示 很重要」'),
        title: z.string().trim().min(1).max(200).optional(),
        due_date: calendarDate.nullable().optional(),
        due_time: time.nullable().optional(),
        importance: importance.optional().describe('1 低 / 2 中 / 3 高'),
        notes: z.string().trim().max(1000).default('')
      }).strict().refine(v => v.text || v.title, '需要 text 或 title'),
      output: z.object({
        item: itemView,
        kind: z.enum(['reminder', 'event', 'note']),
        scheduled: z.boolean(),
        reminders: z.array(z.object({ id: z.string(), at: z.string(), local: z.string(), label: z.string(), status: z.literal('scheduled') }))
      }),
      async run(value, ctx) {
        const now = ctx.now();
        const today = taipeiDate(now);
        let explicit: { at: Date; title: string } | null = null;
        if (value.text && isReminderRequest(value.text)) {
          if (isRecurring(value.text)) throw new ToolError('INVALID_INPUT', '這是重複提醒，要用自動任務（tasks.create）建立，例如「每天早上 8 點提醒我喝水」。這次沒有建立單次提醒。');
          const when = parseReminderTime(value.text, now);
          // An explicit "remind me" without a time is never stored as an undated note.
          if (!when) throw new ToolError('INVALID_INPUT', '要提醒你，但這句話裡沒有我能確定的時間。請告訴我幾點或多久之後，例如「兩分鐘後」「明天 9 點」。這次沒有建立任何提醒。');
          explicit = { at: when.at, title: value.title ?? reminderTitle(value.text, when.phrase) };
        }
        const parsed = value.text && !explicit ? parseAgendaText(value.text, today) : null;
        const item: AgendaItem = explicit ? {
          id: randomUUID(), user_id: ctx.userId, title: explicit.title, notes: value.notes,
          due_date: taipeiDate(explicit.at), due_time: taipeiHHMM(explicit.at), importance: value.importance ?? 2,
          status: 'open', source: 'reminder', created_at: now.toISOString(), updated_at: now.toISOString()
        } : {
          id: randomUUID(),
          user_id: ctx.userId,
          title: value.title ?? parsed!.title,
          notes: value.notes,
          due_date: value.due_date !== undefined ? value.due_date : parsed?.due_date ?? null,
          due_time: value.due_time !== undefined ? value.due_time : parsed?.due_time ?? null,
          importance: value.importance ?? parsed?.importance ?? 2,
          status: 'open',
          source: value.text ? 'text' : 'structured',
          created_at: now.toISOString(),
          updated_at: now.toISOString()
        };
        if (item.due_date && item.due_date < today) throw new ToolError('INVALID_INPUT', `日期 ${item.due_date} 已經過去，請確認日期。`);
        const reminders = await schedule(store, item, now, explicit?.at);
        await store.createItem(item, reminders);
        return {
          data: {
            item: agendaView(item, today),
            kind: explicit ? 'reminder' as const : item.due_date ? 'event' as const : 'note' as const,
            scheduled: reminders.length > 0,
            reminders: reminders.map(r => ({ id: r.id, at: r.remind_at, local: taipeiLabel(new Date(r.remind_at)), label: r.label, status: 'scheduled' as const }))
          },
          recordId: item.id
        };
      }
    }),
    defineTool({
      name: 'agenda.items.list',
      description: '列出使用者記下的事情，已依重要程度與剩餘天數排序（緊急 > 重要 > 一般 > 不急）。使用者問「最近有什麼事」時使用。',
      connection: 'internal',
      kind: 'read',
      input: z.object({
        days: z.number().int().min(1).max(365).default(30).describe('列出今天起幾天內到期的事項；另外一律包含已過期與未定日期的事項'),
        include_done: z.boolean().default(false)
      }).strict(),
      output: z.object({ today: z.string(), items: z.array(itemView) }),
      async run(value, ctx) {
        const today = taipeiDate(ctx.now());
        const items = await store.listItems(ctx.userId, { status: value.include_done ? 'all' : 'open' });
        const within = items.filter(item => { const d = daysUntil(item.due_date, today); return d === null || d <= value.days; });
        return { data: { today, items: rankItems(within, today).map(item => agendaView(item, today)) } };
      }
    }),
    defineTool({
      name: 'agenda.items.update',
      description: '更新一件記事：標記完成/取消、改日期時間、改重要程度或內容。改日期時間會重新排定提醒。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        id: z.uuid(),
        status: z.enum(['open', 'done', 'cancelled']).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        notes: z.string().trim().max(1000).optional(),
        due_date: calendarDate.nullable().optional(),
        due_time: time.nullable().optional(),
        importance: importance.optional()
      }).strict(),
      output: z.object({ item: itemView }),
      async run(value, ctx) {
        const { id, ...patch } = value;
        const updated = await store.updateItem(ctx.userId, id, patch);
        if (!updated) throw new ToolError('NOT_FOUND', '找不到這件記事。');
        // Done or cancelled items lose their pending reminders, so nothing fires afterwards.
        if (patch.status === 'done' || patch.status === 'cancelled') await store.replaceReminders(ctx.userId, id, []);
        else if ('due_date' in patch || 'due_time' in patch || 'importance' in patch || patch.status === 'open') {
          await store.replaceReminders(ctx.userId, id, updated.status === 'open' ? await schedule(store, updated, ctx.now()) : []);
        }
        return { data: { item: agendaView(updated, taipeiDate(ctx.now())) }, recordId: id };
      }
    })
  ];
}

