import { describe, expect, it, vi } from 'vitest';
import { chatHub, ctxAt } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { runOpenAITurn } = await import('@/server/providers/openai');

const final = (text: string) => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, status: 'completed', usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } });

describe('OpenAI streaming', () => {
  it('streams reply text to onProgress and returns the same finished reply', async () => {
    const { hub } = chatHub();
    const create = vi.fn();
    const client: any = {
      responses: {
        create,
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            for (const delta of ['Sir，', '今天', '狀態不錯。']) yield { type: 'response.output_text.delta', delta };
          },
          finalResponse: async () => final('Sir，今天狀態不錯。')
        }))
      }
    };
    const progress: any[] = [];
    const turn = await runOpenAITurn({ client, model: 'gpt-test', registry: hub.registry, executor: hub.executor, ctx: ctxAt('2026-10-29T02:00:00Z'), history: [], userText: '我狀態如何', onProgress: e => progress.push(e) });
    expect(progress.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('Sir，今天狀態不錯。');
    expect(turn.reply).toBe('Sir，今天狀態不錯。');
    expect(create).not.toHaveBeenCalled();
  });

  it('uses the single response when nobody is watching', async () => {
    const { hub } = chatHub();
    const client: any = { responses: { create: vi.fn(async () => final('好的，Sir。')), stream: vi.fn() } };
    const turn = await runOpenAITurn({ client, model: 'gpt-test', registry: hub.registry, executor: hub.executor, ctx: ctxAt('2026-10-29T02:00:00Z'), history: [], userText: '你好' });
    expect(turn.reply).toBe('好的，Sir。');
    expect(client.responses.stream).not.toHaveBeenCalled();
  });
});
