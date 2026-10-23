import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';
import { conditionSchema, describeSchedule, scheduleSchema, stepSchema, type Task } from '@/tasks/model';
import { parseTaskText } from '@/tasks/parse';
import type { TaskService } from '@/tasks/service';

// Tasks are NOIRXU AI's own records, so creating or changing one needs no confirmation. What
// a task does is still checked on every run: tool steps go through the executor, so a step
// that writes to Ledger/Journal or sends mail creates a proposal and waits for the user.

export const STATUS_LABEL: Record<Task['status'], string> = {
  queued: '排程中', running: '執行中', waiting_approval: '等你確認', completed: '已完成', failed: '失敗', cancelled: '已取消', outcome_unknown: '結果不明', paused: '已暫停'
};
const KIND_LABEL: Record<Task['kind'], string> = { reminder: '單次提醒', background: '背景任務', recurring: '週期自動化', conditional: '條件監看' };

const local = (iso: string | null) => (iso ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : null);

export function taskView(task: Task) {
  const last = task.runs[0];
  return {
    id: task.id, title: task.title, kind: task.kind, kind_label: KIND_LABEL[task.kind], status: task.status, status_label: STATUS_LABEL[task.status],
    schedule: task.schedule, schedule_label: describeSchedule(task.schedule), next_at: task.next_at, next_local: local(task.next_at),
    condition: task.condition ?? null, steps: task.steps,
    last_run: last ? { status: last.status, at: last.finished_at ?? last.started_at, local: local(last.finished_at ?? last.started_at), error: last.error ?? null, steps: last.steps } : null,
    runs_kept: task.runs.length, last_error: task.last_error ?? null
  };
}

const anyRecord = z.record(z.string(), z.unknown());

/** Tools a task step may not call: tasks managing tasks, and anything that only makes sense in a live chat. */
const FORBIDDEN_STEP = /^(tasks\.|assistant\.reply\.)/;

export function taskTools(deps: { tasks: TaskService; hasTool: (name: string) => boolean }): ToolDefinition[] {
  return [
    defineTool({
      name: 'tasks.create',
      description: '建立 SASUKE 自動任務（伺服器背景執行，不需要開著 App）：週期提醒（每天/每週/每月/每隔 N 小時）、定時早報或晚報、條件監看（例如本月支出超過某金額就通知）、或多步驟背景工作。可以只傳 text（使用者原話，用固定規則解析），或傳結構化的 schedule/steps。單次提醒請用 agenda.items.create。步驟若用到寫入或寄信的工具，每次執行仍會建立待確認操作，等使用者確認，不會自動寫入。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        text: z.string().trim().min(2).max(200).optional().describe('使用者原話，例如「每天早上8點提醒我喝水」「每週一早上 9 點給我早報」'),
        title: z.string().trim().min(1).max(60).optional(),
        kind: z.enum(['reminder', 'background', 'recurring', 'conditional']).optional(),
        schedule: scheduleSchema.optional().describe('時間為台灣時間 HH:MM；weekdays 0=週日；interval 最少 30 分鐘'),
        steps: z.array(stepSchema).min(1).max(5).optional(),
        condition: conditionSchema.optional()
      }).strict(),
      output: anyRecord,
      async run(value, ctx) {
        const now = ctx.now();
        let spec: { title: string; kind: Task['kind']; schedule: z.infer<typeof scheduleSchema>; steps: z.infer<typeof stepSchema>[]; condition?: z.infer<typeof conditionSchema> };
        if (value.schedule && value.steps) {
          spec = { title: value.title ?? value.text ?? '自動任務', kind: value.kind ?? (value.condition ? 'conditional' : value.schedule.type === 'once' ? 'background' : 'recurring'), schedule: value.schedule, steps: value.steps, condition: value.condition };
        } else if (value.text) {
          const parsed = parseTaskText(value.text, taipeiDate(now));
          if (!parsed) throw new ToolError('INVALID_INPUT', '這句話我沒辦法確定排程（頻率或時間）。請說得更明確，例如「每天早上 8 點提醒我喝水」。這次沒有建立任何任務。');
          if (!parsed.ok) throw new ToolError('INVALID_INPUT', parsed.error);
          spec = { ...parsed.task, title: value.title ?? parsed.task.title };
        } else throw new ToolError('INVALID_INPUT', '需要 text，或同時提供 schedule 與 steps。');
        for (const step of spec.steps) {
          if (step.type !== 'tool') continue;
          if (FORBIDDEN_STEP.test(step.tool) || !deps.hasTool(step.tool)) throw new ToolError('INVALID_INPUT', `任務步驟不能使用 ${step.tool}。這次沒有建立任何任務。`);
        }
        if (spec.condition && spec.condition.type === 'ledger_month_expense_over' && !deps.hasTool('ledger.analytics.get')) throw new ToolError('INVALID_INPUT', '條件監看需要 Ledger。');
        let task: Task;
        try {
          task = await deps.tasks.create({ userId: ctx.userId, ...spec, sourceText: value.text, now });
        } catch (error) {
          throw new ToolError('INVALID_INPUT', error instanceof Error ? `${error.message}，這次沒有建立任何任務。` : '任務沒有建立。');
        }
        return { data: { task: taskView(task), created: true } };
      }
    }),
    defineTool({
      name: 'tasks.list',
      description: '列出 SASUKE 自動任務：名稱、類型、排程、狀態、下次執行時間與最近一次結果。',
      connection: 'internal',
      kind: 'read',
      input: z.object({ include_finished: z.boolean().default(false) }).strict(),
      output: anyRecord,
      async run(value, ctx) {
        const tasks = await deps.tasks.list(ctx.userId, { includeFinished: value.include_finished });
        return { data: { tasks: tasks.map(taskView), total: tasks.length } };
      }
    }),
    defineTool({
      name: 'tasks.update',
      description: '暫停、恢復、取消自動任務，或修改排程。id 必須來自 tasks.list。取消後不會再執行或通知。',
      connection: 'internal',
      kind: 'write',
      requiresConfirmation: false,
      input: z.object({
        id: z.uuid(),
        action: z.enum(['pause', 'resume', 'cancel', 'reschedule']),
        schedule: scheduleSchema.optional()
      }).strict(),
      output: anyRecord,
      async run(value, ctx) {
        if (value.action === 'reschedule' && !value.schedule) throw new ToolError('INVALID_INPUT', '修改排程需要新的 schedule。');
        try {
          const task = await deps.tasks.control(ctx.userId, value.id, value.action === 'reschedule' ? { schedule: value.schedule! } : value.action, ctx.now());
          return { data: { task: taskView(task) } };
        } catch (error) {
          throw new ToolError('INVALID_INPUT', error instanceof Error ? error.message : '任務沒有更改。');
        }
      }
    }),
    defineTool({
      name: 'tasks.history.get',
      description: '一個自動任務最近的執行紀錄（最多 20 次）：每次的時間、結果、每個步驟的狀態與錯誤原因。',
      connection: 'internal',
      kind: 'read',
      input: z.object({ id: z.uuid() }).strict(),
      output: anyRecord,
      async run(value, ctx) {
        const task = await deps.tasks.get(value.id);
        if (!task || task.user_id !== ctx.userId) throw new ToolError('NOT_FOUND', '找不到這個任務。');
        return { data: { task: taskView(task), runs: task.runs.map(r => ({ ...r, local: local(r.finished_at ?? r.started_at) })) } };
      }
    })
  ];
}
