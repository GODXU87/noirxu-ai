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
const live = Boolean(process.env.ANTHROPIC_API_KEY && process.env.NOIRXU_PERSONA_LIVE === '1');

describe.skipIf(!live)('SASUKE persona evaluation: live model', () => {
  for (const c of PERSONA_CASES.filter(c => !c.events.some(e => e.status === 'succeeded'))) {
    it(`${c.domain}/${c.id}`, async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const { runAgentTurn } = await import('@/server/agent');
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
      const turn = await runAgentTurn({
        client: new Anthropic(), model: process.env.NOIRXU_AI_MODEL ?? 'claude-opus-5-5',
        registry, executor, ctx: { userId: 'owner', now: () => new Date('2026-10-23T02:00:00Z') }, history: [], userText: c.user
      });
      const findings = evaluateReply(c, turn.reply);
      console.log(`[${c.id}] ${turn.reply}\n  findings: ${JSON.stringify(findings)}`);
      expect(findings).toEqual([]);
    }, 120_000);
  }
});
