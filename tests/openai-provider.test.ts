import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { historyProviderOf } from '@/server/providers/history';

vi.mock('server-only', () => ({}));
const { runOpenAITurn, openAITools } = await import('@/server/providers/openai');
const { pickProvider } = await import('@/server/config');

const sendSpy = vi.fn();
function setup() {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: 'ledger.analytics.get', description: '本月收支', connection: 'internal', kind: 'read',
    input: z.object({ month: z.string() }).strict(), output: z.unknown(),
    async run() { return { data: { currency: 'TWD', summary: { expense: 6000 } } }; }
  }));
  registry.register(defineTool({
    name: 'gmail.message.send', description: '寄信', connection: 'internal', kind: 'send',
    input: z.object({ to: z.array(z.string()) }).strict(), output: z.unknown(),
    async preview() { return { title: '寄出 Gmail', fields: [] }; },
    async run() { sendSpy(); return { data: {} }; }
  }));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
  return { registry, executor, ctx: { userId: 'owner', now: () => new Date('2026-10-23T02:00:00Z') } };
}

/** A fake OpenAI client that replays scripted Responses API results and records requests. */
function fakeClient(script: any[]) {
  const requests: any[] = [];
  return { requests, client: { responses: { create: vi.fn(async (req: any) => { requests.push(structuredClone(req)); return script.shift(); }) } } as any };
}
const usage = (i: number, o: number, cached = 0) => ({ input_tokens: i, output_tokens: o, total_tokens: i + o, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });

afterEach(() => { vi.unstubAllEnvs(); sendSpy.mockClear(); });

describe('OpenAI provider', () => {
  it('declares registry tools as OpenAI function tools with safe names', () => {
    const tools = openAITools(setup().registry);
    expect(tools.map(t => t.name)).toEqual(['ledger__analytics__get', 'gmail__message__send']);
    expect(tools[0]).toMatchObject({ type: 'function', strict: false, parameters: { type: 'object', properties: { month: { type: 'string' } } } });
    expect(tools[1].description).toContain('需使用者確認');
  });

  it('runs the tool loop statelessly and returns the final text', async () => {
    const { registry, executor, ctx } = setup();
    const { client, requests } = fakeClient([
      { status: 'completed', usage: usage(1000, 50), output_text: '', output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        { type: 'function_call', call_id: 'call_1', name: 'ledger__analytics__get', arguments: '{"month":"2026-10"}' }
      ] },
      { status: 'completed', usage: usage(1200, 80, 900), output_text: '十月目前支出 TWD 6,000。', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '十月目前支出 TWD 6,000。', annotations: [] }] }
      ] }
    ]);
    const turn = await runOpenAITurn({ client, model: 'gpt-5.5', registry, executor, ctx, history: [], userText: '這個月花多少？' });
    expect(turn).toMatchObject({ provider: 'openai', reply: '十月目前支出 TWD 6,000。', stopReason: 'end_turn' });
    expect(turn.usage).toEqual({ calls: 2, input_tokens: 2200, output_tokens: 130, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
    expect(turn.events[0]).toMatchObject({ tool: 'ledger.analytics.get', result: { status: 'ok' } });
    // Request shape: same SASUKE prompt, stateless with encrypted reasoning passed back.
    expect(requests[0]).toMatchObject({ model: 'gpt-5.5', store: false, include: ['reasoning.encrypted_content'] });
    expect(requests[0].instructions).toContain('你是 SASUKE');
    const second = requests[1].input;
    expect(second.find((i: any) => i.type === 'reasoning')).toMatchObject({ encrypted_content: 'enc' });
    expect(second.find((i: any) => i.type === 'function_call_output')).toMatchObject({ call_id: 'call_1' });
    expect(historyProviderOf(turn.messages)).toBe('openai');
  });

  it('a send tool only creates a confirmation, never sends', async () => {
    const { registry, executor, ctx } = setup();
    const { client, requests } = fakeClient([
      { status: 'completed', usage: usage(1, 1), output_text: '', output: [{ type: 'function_call', call_id: 'c', name: 'gmail__message__send', arguments: '{"to":["amy@example.com"]}' }] },
      { status: 'completed', usage: usage(1, 1), output_text: '草稿已備好，請按確認才會寄出。', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '草稿已備好，請按確認才會寄出。', annotations: [] }] }] }
    ]);
    const turn = await runOpenAITurn({ client, model: 'gpt-5.5', registry, executor, ctx, history: [], userText: '寄給 Amy' });
    expect(turn.events[0].result.status).toBe('confirmation_required');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(JSON.parse(requests[1].input.find((i: any) => i.type === 'function_call_output').output).status).toBe('confirmation_required');
  });

  it('rejects malformed tool arguments without running the tool', async () => {
    const { registry, executor, ctx } = setup();
    const { client } = fakeClient([
      { status: 'completed', usage: usage(1, 1), output_text: '', output: [{ type: 'function_call', call_id: 'c', name: 'gmail__message__send', arguments: '{not json' }] },
      { status: 'completed', usage: usage(1, 1), output_text: '參數有誤。', output: [] }
    ]);
    const turn = await runOpenAITurn({ client, model: 'gpt-5.5', registry, executor, ctx, history: [], userText: 'x' });
    expect(turn.events[0].result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('reports a refusal plainly', async () => {
    const { registry, executor, ctx } = setup();
    const { client } = fakeClient([{ status: 'completed', usage: usage(1, 1), output_text: '', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }]);
    expect(await runOpenAITurn({ client, model: 'gpt-5.5', registry, executor, ctx, history: [], userText: 'x' })).toMatchObject({ reply: '這個請求無法處理。', stopReason: 'refusal' });
  });
});

describe('provider selection', () => {
  it('uses NOIRXU_AI_PROVIDER when its key exists, otherwise whichever key is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', 'sk-test'); vi.stubEnv('NOIRXU_AI_PROVIDER', '');
    expect(pickProvider()).toBe('openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    expect(pickProvider()).toBe('anthropic');
    vi.stubEnv('NOIRXU_AI_PROVIDER', 'openai');
    expect(pickProvider()).toBe('openai');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(pickProvider()).toBeNull();
  });

  it('tells which provider wrote a history', () => {
    expect(historyProviderOf([])).toBeNull();
    expect(historyProviderOf([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }])).toBe('anthropic');
    expect(historyProviderOf([{ role: 'user', content: 'hi' }, { type: 'message', role: 'assistant', content: [] }])).toBe('openai');
  });
});
