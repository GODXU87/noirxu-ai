import { z } from 'zod';
import type { AgendaStore } from '@/agenda/store';
import { parseLedgerText, type LedgerCategoryLite } from '@/assistant/ledger-text';
import { buildEveningReport, buildMorningReport, type GmailDigest, type LedgerDigest } from '@/assistant/reports';
import { triageResult, triageText } from '@/assistant/triage';
import { defineTool } from '@/hub/registry';
import type { ConnectionId, InvokeResult, ToolContext, ToolDefinition } from '@/hub/types';
import type { FeatureFlags } from '@/lib/features';
import type { WaterService } from '@/health/service';
import { waterProgress } from '@/health/water';
import { taipeiDate } from '@/lib/dates';

export interface AssistantDeps {
  agenda: AgendaStore;
  /** Runs another registered tool through the executor (same checks and audit log). */
  invoke: (name: string, input: unknown, ctx: ToolContext) => Promise<InvokeResult>;
  isConnected: (userId: string, connection: ConnectionId) => Promise<boolean>;
  features: FeatureFlags;
  /** Present when the water feature is on. */
  water?: WaterService;
}

const anyRecord = z.record(z.string(), z.unknown());

async function ledgerDigest(deps: AssistantDeps, ctx: ToolContext, month: string): Promise<{ status: 'ok' | 'not_connected' | 'error'; digest: LedgerDigest | null }> {
  if (!(await deps.isConnected(ctx.userId, 'ledger'))) return { status: 'not_connected', digest: null };
  const [analytics, budget] = await Promise.all([
    deps.invoke('ledger.analytics.get', { month }, ctx),
    deps.invoke('ledger.budget.summary', { month }, ctx)
  ]);
  if (analytics.status !== 'ok') return { status: 'error', digest: null };
  const a = analytics.data as { currency: string; summary: { expense: number; income: number } };
  const b = budget.status === 'ok' ? budget.data as { categories: Array<{ name: string; percentage: number; status: string }> } : { categories: [] };
  return {
    status: 'ok',
    digest: { currency: a.currency, expense: a.summary.expense, income: a.summary.income, budget_warnings: b.categories.filter(c => c.status === 'warning' || c.status === 'over') }
  };
}

async function waterDigest(deps: AssistantDeps, ctx: ToolContext) {
  if (!deps.water) return null;
  const now = ctx.now();
  const [prefs, day] = await Promise.all([deps.water.prefs(ctx.userId), deps.water.day(ctx.userId, taipeiDate(now))]);
  const p = waterProgress(prefs, day, now);
  return { total_ml: p.total_ml, goal_ml: p.goal_ml, percent: p.percent, expected_ml: p.expected_ml, reminders: prefs.enabled ? `${prefs.start}–${prefs.end} 每 ${prefs.interval_hours} 小時` : null };
}

async function gmailDigest(deps: AssistantDeps, ctx: ToolContext): Promise<GmailDigest> {
  if (!(await deps.isConnected(ctx.userId, 'gmail'))) return { status: 'not_connected' };
  const result = await deps.invoke('gmail.messages.search', { query: 'in:inbox is:unread newer_than:1d -category:promotions -category:social', max_results: 5 }, ctx);
  if (result.status === 'ok') {
    const messages = (result.data as { messages: Array<{ id: string; from: string; subject: string }> }).messages;
    return { status: 'ok', unread: messages.map(m => ({ id: m.id, from: m.from.replace(/<.*>/, '').trim(), subject: m.subject })) };
  }
  if (result.status === 'error' && result.code === 'FORBIDDEN') return { status: 'no_read_grant' };
  return { status: 'error', message: result.status === 'error' ? result.message : undefined };
}

export function assistantTools(deps: AssistantDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (deps.features.triage) {
    tools.push(defineTool({
      name: 'assistant.text.triage',
      description: '把使用者貼上的零碎文字、通知、信件或對話，整理成行程、待辦、財務、重要資訊與需要回覆的訊息。每個事實都附上原文出處，推測與缺少的資訊分開列出，並標記疑似惡意指令。只做解析，不會寫入任何地方。',
      connection: 'internal',
      kind: 'read',
      input: z.object({
        text: z.string().trim().min(1).max(8000).describe('要整理的原文，原樣傳入'),
        source: z.enum(['user', 'pasted', 'email']).default('pasted').describe('user = 使用者自己的話；pasted/email = 第三方內容')
      }).strict(),
      output: triageResult,
      async run(value, ctx) {
        return { data: triageText(value.text, taipeiDate(ctx.now()), value.source) };
      }
    }));
  }

  if (deps.features.commands) {
    tools.push(defineTool({
      name: 'assistant.ledger.draft',
      description: '把一句記帳描述（例如「午餐 150 元 刷卡」）整理成 Ledger 記帳草稿：金額、日期、分類、付款方式，並列出推測與缺少的欄位。不會寫入；使用者確認欄位後才用 ledger.expense.create / ledger.income.create 建立待確認操作。',
      connection: 'internal',
      kind: 'read',
      input: z.object({ text: z.string().trim().min(1).max(300) }).strict(),
      output: anyRecord,
      async run(value, ctx) {
        let categories: LedgerCategoryLite[] = [];
        let ledger: 'ok' | 'not_connected' | 'error' = 'not_connected';
        if (await deps.isConnected(ctx.userId, 'ledger')) {
          const result = await deps.invoke('ledger.categories.list', {}, ctx);
          if (result.status === 'ok') { categories = (result.data as { categories: LedgerCategoryLite[] }).categories; ledger = 'ok'; }
          else ledger = 'error';
        }
        return { data: { draft: parseLedgerText(value.text, taipeiDate(ctx.now()), categories), categories, ledger } };
      }
    }));
  }

  if (deps.features.briefings) {
    tools.push(defineTool({
      name: 'assistant.briefing.morning',
      description: '早報：今天的行程、最重要的三件事、逾期事項、近三天事項，加上已連接系統的本月收支、預算警示、未平倉筆數與今天的未讀信。只讀取，未連接的來源會註明未納入。',
      connection: 'internal',
      kind: 'read',
      input: z.object({}).strict(),
      output: anyRecord,
      async run(_value, ctx) {
        const today = taipeiDate(ctx.now());
        const [items, ledger, gmail, water, journal] = await Promise.all([
          deps.agenda.listItems(ctx.userId, { status: 'open' }),
          ledgerDigest(deps, ctx, today.slice(0, 7)),
          gmailDigest(deps, ctx),
          waterDigest(deps, ctx),
          (async () => {
            if (!(await deps.isConnected(ctx.userId, 'journal'))) return { status: 'not_connected' as const, open: null };
            const trades = await deps.invoke('journal.trades.list', { status: 'open', limit: 1 }, ctx);
            return trades.status === 'ok' ? { status: 'ok' as const, open: (trades.data as { total_matching: number }).total_matching } : { status: 'error' as const, open: null };
          })()
        ]);
        return {
          data: { ...buildMorningReport({ today, items, ledger: ledger.digest, ledgerStatus: ledger.status, openPositions: journal.open, journalStatus: journal.status, gmail }), water } as unknown as Record<string, unknown>
        };
      }
    }));
    tools.push(defineTool({
      name: 'assistant.briefing.evening',
      description: '晚報：今天完成的事、今天到期但還沒完成的事、逾期事項、明天的事，以及明天建議先做的三件事。只讀取 NOIRXU AI 記事。',
      connection: 'internal',
      kind: 'read',
      input: z.object({}).strict(),
      output: anyRecord,
      async run(_value, ctx) {
        const today = taipeiDate(ctx.now());
        const [items, water] = await Promise.all([deps.agenda.listItems(ctx.userId, { status: 'all' }), waterDigest(deps, ctx)]);
        return { data: { ...buildEveningReport({ today, items }), water } as unknown as Record<string, unknown> };
      }
    }));
  }

  if (deps.features.reply_drafts) {
    const draft = z.object({
      style: z.enum(['positive', 'decline', 'formal', 'short']).describe('positive 正向接受 / decline 婉拒或改期 / formal 正式商務 / short 簡短'),
      subject: z.string().trim().max(200).optional(),
      body: z.string().trim().min(1).max(5000)
    }).strict();
    tools.push(defineTool({
      name: 'assistant.reply.drafts',
      description: '把你擬好的回覆草稿交給畫面顯示成草稿卡片（1～4 個版本，簡單通知給 1 個就好）。只顯示，不會寄出。要寄 Gmail 時，使用者在卡片上按「準備寄出」，仍會走 gmail.message.send 的確認流程。收件人只能填原信或使用者明確提供的信箱。',
      connection: 'internal',
      kind: 'read',
      input: z.object({
        context: z.string().trim().max(300).describe('一句話說明這是在回覆什麼'),
        to: z.array(z.email()).max(20).default([]).describe('原信寄件人或使用者明確提供的信箱；不知道就留空'),
        reply_to_message_id: z.string().regex(/^[A-Za-z0-9]+$/).optional(),
        drafts: z.array(draft).min(1).max(4)
      }).strict(),
      output: anyRecord,
      async run(value) {
        return { data: { ...value, sent: false, send_requires_confirmation: true } };
      }
    }));
  }

  return tools;
}
