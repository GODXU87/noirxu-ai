import OpenAI from 'openai';
import { z } from 'zod';
import { defineTool } from '@/hub/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatHub, ctxAt } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');

describe('light model for simple questions', () => {
  afterEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL_LIGHT; delete process.env.NOIRXU_AI_PRICES; });

  it('uses OPENAI_MODEL_LIGHT for simple questions and falls back to the main model if it is rejected', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL_LIGHT = 'gpt-light-test';
    const { hub } = chatHub();
    process.env.NOIRXU_AI_PRICES = JSON.stringify({ 'gpt-light-test': { input: 1, output: 1 }, 'gpt-test': { input: 10, output: 20 } });
    const models: string[] = [];
    const client: any = { responses: { create: vi.fn(async (params: any) => {
      models.push(params.model);
      if (params.model === 'gpt-light-test') throw new OpenAI.NotFoundError(404, { message: 'The model `gpt-light-test` does not exist' }, 'The model `gpt-light-test` does not exist', new Headers());
      return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，Sir。' }] }], output_text: '好的，Sir。', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } };
    }) } };
    const r = await handleChat(hub, ctxAt('2026-10-29T02:00:00Z'), { style: 'professional', history: [], text: '幫我想個週末去哪走走', clients: { openai: () => client } });
    expect(models).toEqual(['gpt-light-test', 'gpt-test']);
    expect(r.ok && r.reply).toBe('好的，Sir。');
    expect(r.ok && r.route.model).toBe('gpt-test');
    const usage = await hub.cost.usage(new Date('2026-10-29T02:00:00Z'));
    expect(usage.by_model['gpt-test']).toMatchObject({ calls: 1, input_tokens: 1, output_tokens: 1 });
    expect(usage.cost_usd).toBeCloseTo(0.00003);
    expect(usage.by_model['gpt-light-test']).toBeUndefined();
  });
  it('checks the fallback price before the next paid iteration', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL_LIGHT = 'gpt-light-test';
    process.env.NOIRXU_AI_PRICES = JSON.stringify({ 'gpt-light-test': { input: 1, output: 1 }, 'gpt-test': { input: 10, output: 20 } });
    const { hub } = chatHub();
    await hub.cost.setConfig({ per_task_usd: 0.005 });
    const models: string[] = [];
    const client: any = { responses: { create: async (params: any) => {
      models.push(params.model);
      if (params.model === 'gpt-light-test') throw new OpenAI.NotFoundError(404, { message: 'model not found' }, 'model not found', new Headers());
      return { output: [{ type: 'function_call', name: 'unknown', call_id: 'one', arguments: '{}' }], status: 'completed', usage: { input_tokens: 1000, output_tokens: 0 } };
    } } };
    const result = await handleChat(hub, ctxAt('2026-10-29T02:00:00Z'), { style: 'professional', history: [], text: '幫我想個週末去哪走走', clients: { openai: () => client } });
    expect(models).toEqual(['gpt-light-test', 'gpt-test']);
    expect(result.ok && result.stopReason).toBe('budget');
    expect((await hub.cost.usage(new Date('2026-10-29T02:00:00Z'))).cost_usd).toBeCloseTo(0.01);
  });
  it('does not restart a partially executed light turn and records its consumed usage on error', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL_LIGHT = 'gpt-light-test';
    process.env.NOIRXU_AI_PRICES = JSON.stringify({ 'gpt-light-test': { input: 1, output: 1 } });
    const { hub } = chatHub();
    let sideEffects = 0;
    hub.registry.register(defineTool({ name: 'agenda.test.create', description: 'in-memory regression counter', connection: 'internal', kind: 'write', requiresConfirmation: false,
      input: z.object({}), output: z.unknown(), async run() { sideEffects += 1; return { data: { count: sideEffects } }; } }));
    const models: string[] = [];
    const client: any = { responses: { create: async (params: any) => {
      models.push(params.model);
      if (models.length === 1 || params.model === 'gpt-test') return { output: [{ type: 'function_call', name: 'agenda__test__create', call_id: 'one', arguments: '{}' }], status: 'completed', usage: { input_tokens: 1000, output_tokens: 2 } };
      throw new OpenAI.NotFoundError(404, { message: 'model not found' }, 'model not found', new Headers());
    } } };
    let failure: unknown;
    try { await handleChat(hub, ctxAt('2026-10-29T02:00:00Z'), { style: 'professional', history: [], text: '幫我想個週末去哪走走', clients: { openai: () => client } }); }
    catch (error) { failure = error; }
    expect(sideEffects).toBe(1);
    expect(failure).toBeInstanceOf(OpenAI.NotFoundError);
    expect(models).toEqual(['gpt-light-test', 'gpt-light-test']);
    expect((await hub.cost.usage(new Date('2026-10-29T02:00:00Z'))).by_model['gpt-light-test']).toMatchObject({ calls: 1, input_tokens: 1000, output_tokens: 2 });
  });

});
