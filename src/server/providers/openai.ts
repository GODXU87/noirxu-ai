import 'server-only';
import type OpenAI from 'openai';
import { z } from 'zod';
import type { Executor } from '@/hub/executor';
import type { ToolRegistry } from '@/hub/registry';
import type { ToolContext, ToolDefinition } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';
import { systemPrompt, toClaudeName, toolResultText, type ProgressEvent, type ReplyStyle, type ToolEvent, type TurnUsage } from '../agent';

// OpenAI provider for the same SASUKE engine: same system prompt, same tool registry and
// executor (so confirmation cards, duplicate protection and the audit log are unchanged),
// same turn result. Uses the Responses API statelessly (store: false): earlier output items,
// including encrypted reasoning, are sent back as input on the next call.

const MAX_ITERATIONS = 8;

type InputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;

export interface OpenAITurn {
  provider: 'openai';
  messages: unknown[];
  reply: string;
  events: ToolEvent[];
  stopReason: string | null;
  usage: TurnUsage;
}

/** Registry tools as OpenAI function tools. Names use the same safe form as for Claude. */
export function openAITools(registry: ToolRegistry): FunctionTool[] {
  return registry.list().map((tool: ToolDefinition) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return {
      type: 'function',
      name: toClaudeName(tool.name),
      description: `${tool.description}${tool.kind === 'read' || tool.requiresConfirmation === false ? '' : '（需使用者確認）'}`,
      parameters: { type: 'object', ...schema },
      // Our schemas use optional fields and defaults, which strict mode does not allow;
      // inputs are validated by the executor's Zod schemas instead.
      strict: false
    };
  });
}

export async function runOpenAITurn(options: {
  client: OpenAI;
  model: string;
  registry: ToolRegistry;
  executor: Executor;
  ctx: ToolContext;
  history: unknown[];
  userText: string;
  style?: ReplyStyle;
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  onProgress?: (event: ProgressEvent) => void;
}): Promise<OpenAITurn> {
  const { client, model, registry, executor, ctx } = options;
  const tools = openAITools(registry);
  const byName = new Map(registry.list().map(tool => [toClaudeName(tool.name), tool.name]));
  const input: unknown[] = [...options.history, { role: 'user', content: options.userText }];
  const events: ToolEvent[] = [];
  const usage: TurnUsage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const instructions = systemPrompt(registry, taipeiDate(ctx.now()), options.style);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await client.responses.create({
      model,
      instructions,
      input: input as InputItem[],
      tools,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 16000,
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {})
    });
    usage.calls += 1;
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;
    usage.cache_read_input_tokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
    // Output items (messages, reasoning, function calls) go back verbatim on the next call.
    input.push(...response.output);

    const calls = response.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call');
    if (!calls.length) {
      const refusal = response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal'));
      if (refusal) return { provider: 'openai', messages: input, reply: '這個請求無法處理。', events, stopReason: 'refusal', usage };
      const reply = (response.output_text ?? '').trim();
      return { provider: 'openai', messages: input, reply, events, stopReason: response.status === 'incomplete' ? `incomplete:${response.incomplete_details?.reason ?? ''}` : 'end_turn', usage };
    }

    const outputs = await Promise.all(calls.map(async call => {
      const name = byName.get(call.name) ?? call.name;
      options.onProgress?.({ type: 'tool_start', tool: name });
      let args: unknown;
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = null;
      }
      const result = args === null
        ? { status: 'error' as const, tool: name, code: 'INVALID_INPUT' as const, message: '工具參數不是有效的 JSON。' }
        : await executor.invoke(name, args, ctx);
      events.push({ tool: name, input: args, result });
      options.onProgress?.({ type: 'tool_done', tool: name, result });
      return { type: 'function_call_output' as const, call_id: call.call_id, output: toolResultText(result).content };
    }));
    input.push(...outputs);
  }

  return { provider: 'openai', messages: input, reply: '這個請求需要的步驟太多，已停止。請把需求拆小一點再試一次。', events, stopReason: 'max_iterations', usage };
}
