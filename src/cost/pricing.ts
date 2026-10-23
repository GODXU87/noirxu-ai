import type { TurnUsage } from '@/server/agent';

// Model prices in USD per million tokens. Built-in defaults are Anthropic's list prices
// (2026-10); every value can be replaced without a code change through NOIRXU_AI_PRICES,
// e.g. {"gpt-5.5":{"input":1.25,"output":10,"cacheRead":0.125}}. The older
// OPENAI_PRICE_*_PER_M variables still work for the OpenAI model.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache write price; defaults to 1.25x input (Anthropic 5-minute cache). */
  cacheWrite?: number;
}

const DEFAULTS: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 }
};

function fromEnv(): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  try {
    const parsed = JSON.parse(process.env.NOIRXU_AI_PRICES ?? '{}') as Record<string, Partial<ModelPrice>>;
    for (const [model, p] of Object.entries(parsed)) {
      if (Number(p.input) > 0 && Number(p.output) > 0) out[model] = { input: Number(p.input), output: Number(p.output), cacheRead: Number(p.cacheRead) || Number(p.input), cacheWrite: Number(p.cacheWrite) || undefined };
    }
  } catch { /* ignore malformed config; prices stay unknown rather than wrong */ }
  return out;
}

export function priceOf(model: string): ModelPrice | null {
  const configured = fromEnv()[model];
  if (configured) return configured;
  if (DEFAULTS[model]) return DEFAULTS[model];
  const input = Number(process.env.OPENAI_PRICE_INPUT_PER_M);
  const output = Number(process.env.OPENAI_PRICE_OUTPUT_PER_M);
  if (!model.startsWith('claude-') && input > 0 && output > 0) return { input, output, cacheRead: Number(process.env.OPENAI_PRICE_CACHED_PER_M) || input };
  return null;
}

/**
 * Cost of the tokens in `usage`, or null when the model has no known price.
 * Anthropic reports cache reads and writes separately from input_tokens; OpenAI's
 * input_tokens already include the cached part, which is billed at the cached rate.
 */
export function costOf(model: string, usage: TurnUsage): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const openaiStyle = !model.startsWith('claude-');
  const plainInput = openaiStyle ? Math.max(0, usage.input_tokens - usage.cache_read_input_tokens) : usage.input_tokens;
  const write = p.cacheWrite ?? p.input * 1.25;
  return (plainInput * p.input + usage.cache_read_input_tokens * p.cacheRead + usage.cache_creation_input_tokens * write + usage.output_tokens * p.output) / 1_000_000;
}
