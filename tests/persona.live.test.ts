import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { evaluateReply } from '@/persona/evaluate';
import { PERSONA_CASES } from './persona/cases';

vi.mock('server-only', () => ({}));

// Costs real API calls: runs only with ANTHROPIC_API_KEY and NOIRXU_PERSONA_LIVE=1.
// Stops as soon as the accumulated estimate passes NOIRXU_PERSONA_MAX_USD (default 5).
const OPENAI = process.env.NOIRXU_PERSONA_PROVIDER === 'openai';
const live = Boolean((OPENAI ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) && process.env.NOIRXU_PERSONA_LIVE === '1');
const MAX_USD = Number(process.env.NOIRXU_PERSONA_MAX_USD ?? 5);
let spent = 0;

describe.skipIf(!live)('SASUKE persona evaluation: live model', () => {
  for (const c of PERSONA_CASES.filter(c => !c.events.some(e => e.status === 'succeeded'))) {
    it(`${c.domain}/${c.id}`, async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const { runAgentTurn, estimateCostUsd } = await import('@/server/agent');
      const { runOpenAITurn } = await import('@/server/providers/openai');
      if (spent >= MAX_USD) throw new Error(`已達測試費用上限 US$${MAX_USD}，停止後續案例（目前估計 US$${spent.toFixed(2)}）`);
      const registry = new ToolRegistry();
      for (const e of c.events) {
        registry.register(defineTool({
          name: e.tool, description: `測試用：${e.tool}`, connection: 'internal',
          kind: e.status === 'confirmation_required' ? 'write' : 'read',
          input: z.object({}).loose(), output: z.unknown(),
          async preview() { return { title: e.tool, fields: [{ label: '內容', value: JSON.stringify(e.data) }] }; },
          async run() { if (e.status === 'error') throw new ToolError('NOT_CONNECTED', e.message ?? '失敗'); return { data: e.data }; }
        }));
      }
      const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
      const ctx = { userId: 'owner', now: () => new Date('2026-10-23T02:00:00Z') };
      const model = OPENAI ? (process.env.OPENAI_MODEL ?? 'gpt-5.5') : (process.env.NOIRXU_AI_MODEL ?? 'claude-opus-5-5');
      const turn = OPENAI
        ? await runOpenAITurn({ client: new (await import('openai')).default(), model, registry, executor, ctx, history: [], userText: c.user })
        : await runAgentTurn({ client: new Anthropic(), model, registry, executor, ctx, history: [], userText: c.user });
      const cost = estimateCostUsd(model, turn.usage);
      if (cost === null) throw new Error('沒有這個模型的單價，無法控制費用上限：請設定 OPENAI_PRICE_INPUT_PER_M 與 OPENAI_PRICE_OUTPUT_PER_M');
      spent += cost;
      const findings = evaluateReply(c, turn.reply);
      console.log(`[${c.id}] ${turn.reply}\n  findings: ${JSON.stringify(findings)}\n  usage: ${JSON.stringify(turn.usage)} ≈ US$${cost.toFixed(4)} (累計 US$${spent.toFixed(2)})`);
      expect(findings).toEqual([]);
    }, 120_000);
  }
});
