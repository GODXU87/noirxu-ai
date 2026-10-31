import { vi } from 'vitest';
import { z } from 'zod';
import { MemoryAgendaStore } from '@/agenda/store';
import { TokenVault } from '@/connections/vault';
import { CostGuard } from '@/cost/guard';
import { WaterService } from '@/health/service';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import type { MemoryRecord } from '@/router/memory';
import { agendaTools } from '@/tools/agenda/tools';
import { healthTools } from '@/tools/health/tools';

export const vault = new TokenVault('test-passphrase-0123456789abcdef0123456789');

/** Fully synthetic fixture, designed from scratch; not derived from any person's accounts.
 * Four invented expenses on four distinct days total 6000 (food 3600 + shopping 2400), plus two
 * invented incomes total 15000. Calendar dates only align with scheduler tests.
 */
export const LEDGER_OCTOBER = {
  month: '2026-10', currency: 'TWD',
  summary: { income: 15000, expense: 6000, netFlow: 9000, transactionCount: 6, expenseCount: 4, averageDailyExpense: 1500 },
  expense_by_category: [{ id: 'food', name: '餐飲', amount: 3600, percentage: 60 }, { id: 'shop', name: '購物', amount: 2400, percentage: 40 }],
  comparison: { previousMonth: '2026-09', income: { current: 15000, previous: 12000, change: 25 }, expense: { current: 6000, previous: 7500, change: -20 }, netFlow: { current: 9000, previous: 4500, change: 100 } },
  largest_expense: null
};
/** Hub with real agenda, water, executor and cost guard; Ledger and RADAR are canned read tools. */
export function chatHub(options: { ledgerConnected?: boolean; memories?: MemoryRecord[] | null } = {}) {
  const agenda = new MemoryAgendaStore();
  const water = new WaterService(agenda, vault);
  const registry = new ToolRegistry();
  agendaTools(agenda).forEach(t => registry.register(t));
  healthTools(water).forEach(t => registry.register(t));
  const ledgerAnalytics = vi.fn(async () => ({ data: LEDGER_OCTOBER }));
  registry.register(defineTool({ name: 'ledger.analytics.get', description: '本月收支分析', connection: 'ledger', kind: 'read', input: z.object({ month: z.string() }), output: z.unknown(), run: ledgerAnalytics }));
  registry.register(defineTool({ name: 'ledger.expense.create', description: '新增支出', connection: 'ledger', kind: 'write', input: z.object({ amount: z.number() }).loose(), output: z.unknown(), async preview() { return { title: '新增支出', fields: [] }; }, async run() { return { data: {} }; } }));
  registry.register(defineTool({ name: 'radar.stock.analyze', description: '個股分析（RADAR，附資料日期）', connection: 'radar', kind: 'read', cacheTtlMs: 60_000, input: z.object({ symbol: z.string() }), output: z.unknown(), async run() { return { data: { symbol: '2330', trade_date: '2026-10-22', score: 78 } }; } }));
  const connected = { ledger: options.ledgerConnected ?? true, radar: true, journal: false, gmail: false } as Record<string, boolean>;
  const isConnected = async (_u: string, c: string) => connected[c] ?? false;
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: isConnected as never });
  const cost = new CostGuard(agenda, vault);
  const memories = options.memories === undefined ? null : options.memories;
  const hub: any = {
    agenda, water, registry, executor, cost, vault,
    memory: memories === null ? null : { list: async () => memories },
    isConnected,
    config: { openai: { model: 'gpt-test', reasoningEffort: null }, anthropicModel: 'claude-opus-5-5' },
    features: { water: true }
  };
  return { hub, agenda, water, ledgerAnalytics };
}

/** OpenAI Responses client that records every request instead of calling the API. */
export function fakeOpenAI(reply = '這需要分析：（測試回覆）') {
  const requests: any[] = [];
  const client: any = {
    responses: {
      create: vi.fn(async (params: any) => {
        requests.push(structuredClone(params));
        const inputChars = JSON.stringify([params.instructions, params.tools, params.input]).length;
        return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }], output_text: reply, status: 'completed', usage: { input_tokens: Math.round(inputChars / 2), output_tokens: 120, input_tokens_details: { cached_tokens: 0 } } };
      })
    }
  };
  return { client, requests };
}

export const ctxAt = (iso: string) => ({ userId: 'owner', now: () => new Date(iso) });
