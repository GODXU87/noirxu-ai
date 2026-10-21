import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dueLabel } from '@/agenda/briefing';
import { parseAgendaText } from '@/agenda/parse';
import { PRIORITY_LABEL, daysUntil, priorityOf, rankItems, reminderSchedule, type AgendaItem } from '@/agenda/rank';
import type { AgendaStore } from '@/agenda/store';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { isCalendarDate, taipeiDate } from '@/lib/dates';

const calendarDate = z.string().refine(isCalendarDate, '日期需為 YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間需為 HH:MM');
const importance = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const itemView = z.object({
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

function view(item: AgendaItem, today: string): z.output<typeof itemView> {
  const priority = priorityOf(item, today);
  return {
    id: item.id, title: item.title, notes: item.notes, due_date: item.due_date, due_time: item.due_time, importance: item.importance,
    status: item.status, priority, priority_label: PRIORITY_LABEL[priority], due_label: dueLabel(item, today), days_left: daysUntil(item.due_date, today)
  };
}

function schedule(item: AgendaItem, now: Date) {
  return reminderSchedule(item, now).map(r => ({ id: randomUUID(), remind_at: r.at.toISOString(), label: r.label }));
}

export function agendaTools(store: AgendaStore): ToolDefinition[] {
  return [
    defineTool({
      name: 'agenda.items.create',
      description: '把使用者說的事情記進 NOIRXU AI 的行程/記事（例如「11/11 要教學演示」）。可直接傳原句 text，系統會解析日期、時間與重要程度；也可傳結構化欄位。會自動排定提醒（前一晚、當天早上、重要事項提前 3 天、有時間的提前 1 小時）。這是 NOIRXU AI 自己的記事，不需確認。',
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
      output: z.object({ item: itemView, reminders: z.array(z.object({ at: z.string(), label: z.string() })) }),
      async run(value, ctx) {
        const now = ctx.now();
        const today = taipeiDate(now);
        const parsed = value.text ? parseAgendaText(value.text, today) : null;
        const item: AgendaItem = {
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
        const reminders = schedule(item, now);
        await store.createItem(item, reminders);
        return { data: { item: view(item, today), reminders: reminders.map(r => ({ at: r.remind_at, label: r.label })) }, recordId: item.id };
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
        return { data: { today, items: rankItems(within, today).map(item => view(item, today)) } };
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
        if ('due_date' in patch || 'due_time' in patch || 'importance' in patch || patch.status === 'open') {
          await store.replaceReminders(ctx.userId, id, updated.status === 'open' ? schedule(updated, ctx.now()) : []);
        }
        return { data: { item: view(updated, taipeiDate(ctx.now())) }, recordId: id };
      }
    })
  ];
}

