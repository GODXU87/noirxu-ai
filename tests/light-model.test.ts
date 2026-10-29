import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatHub, ctxAt } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');

describe('light model for simple questions', () => {
  afterEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL_LIGHT; });

  it('uses OPENAI_MODEL_LIGHT for simple questions and falls back to the main model if it is rejected', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL_LIGHT = 'gpt-light-test';
    const { hub } = chatHub();
    const models: string[] = [];
    const client: any = { responses: { create: vi.fn(async (params: any) => {
      models.push(params.model);
      if (params.model === 'gpt-light-test') throw new OpenAI.NotFoundError(404, { message: 'The model `gpt-light-test` does not exist' }, 'The model `gpt-light-test` does not exist', new Headers());
      return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，Sir。' }] }], output_text: '好的，Sir。', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } };
    }) } };
    const r = await handleChat(hub, ctxAt('2026-10-29T02:00:00Z'), { style: 'professional', history: [], text: '幫我想個週末去哪走走', clients: { openai: () => client } });
    expect(models).toEqual(['gpt-light-test', 'gpt-test']);
    expect(r.ok && r.reply).toBe('好的，Sir。');
  });
});
