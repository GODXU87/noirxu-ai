import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ToolContext } from '@/hub/types';
import { classify } from '@/router/intents';
import { runLocal } from '@/router/local';
import { memoryContext, searchMemories } from '@/router/memory';
import { chooseTier, selectTools, TIER_LIMITS, trimHistory, type ModelTier } from '@/router/tier';
import { runAgentTurn, type ProgressEvent, type ReplyStyle, type ToolEvent, type TurnUsage } from './agent';
import { pickProvider } from './config';
import type { Hub } from './hub';
import { historyProviderOf } from './providers/history';
import { runOpenAITurn } from './providers/openai';
import { eveningBriefing, lastTick, morningBriefing } from './tick';

// One entry point for every chat message:
//   1. local router (L0 rules / L1 data reads) — zero model calls, works without API keys;
//   2. budget guard — paid calls stop at the limits, local answers keep working;
//   3. the model, sized to the task: tier (L2 / L3), relevant tools only, recent history only,
//      capped output and iterations, a few relevant memories instead of all of them.

export interface RouteInfo {
  level: 'L0' | 'L1' | ModelTier;
  source: 'local' | 'memory' | 'tool' | 'ai';
  intent?: string;
  model?: string;
}

export type ChatResult =
  | { ok: true; provider: 'local' | 'anthropic' | 'openai'; messages: unknown[]; reply: string; events: ToolEvent[]; route: RouteInfo; usage?: TurnUsage; contextReset: boolean; stopReason?: string | null }
  | { ok: false; error: { code: string; message: string }; route?: RouteInfo };

export interface ChatOptions {
  text: string;
  style: ReplyStyle;
  history: unknown[];
  provider?: 'anthropic' | 'openai';
  onProgress?: (event: ProgressEvent) => void;
  /** For the benchmark: compare with the router and the token limits switched off. */
  router?: boolean;
  optimize?: boolean;
  clients?: { anthropic?: () => Anthropic; openai?: () => OpenAI };
}

/** Upper bound on what is kept for later turns (the screen keeps everything). */
const KEEP_TURNS = 40;

export async function handleChat(hub: Hub, ctx: ToolContext, options: ChatOptions): Promise<ChatResult> {
  const useRouter = options.router ?? true;
  const optimize = options.optimize ?? true;

  const intent = useRouter ? classify(options.text) : null;
  if (intent) {
    const turn = await runLocal(intent, {
      executor: hub.executor, ctx, memory: hub.memory,
      isConnected: connection => hub.isConnected(ctx.userId, connection as never),
      briefing: async which => (which === 'morning' ? morningBriefing(hub, ctx.userId, ctx.now()) : eveningBriefing(hub, ctx.userId, ctx.now())),
      schedulerAgeMinutes: async () => { const last = await lastTick(hub); return last ? Math.round((ctx.now().getTime() - Date.parse(last.at)) / 60_000) : null; }
    });
    await hub.cost.recordLocal(intent.kind, ctx.now()).catch(() => null);
    const messages = [...options.history, { role: 'user', content: options.text }, { role: 'assistant', content: turn.reply }];
    return { ok: true, provider: 'local', messages, reply: turn.reply, events: turn.events, route: { level: turn.level, source: turn.source, intent: intent.kind }, contextReset: false };
  }

  const provider = pickProvider();
  if (!provider) return { ok: false, error: { code: 'NOT_CONFIGURED', message: '這個問題需要 AI 分析，但 AI 金鑰尚未設定。喝水、待辦、記帳金額等查詢仍可直接回答。' } };

  const config = await hub.cost.config();
  const tier: ModelTier = optimize ? chooseTier(options.text, config.mode) : 'L3';
  const admitted = await hub.cost.admit(ctx.now());
  if (!admitted.ok) return { ok: false, error: { code: 'BUDGET_EXCEEDED', message: admitted.reason }, route: { level: tier, source: 'ai' } };

  const historyProvider = options.provider ?? historyProviderOf(options.history);
  const contextReset = historyProvider !== null && historyProvider !== provider;
  const fullHistory = contextReset ? [] : options.history;
  const limits = TIER_LIMITS[tier];
  const { history, dropped } = optimize ? trimHistory(fullHistory, limits.historyTurns) : { history: fullHistory, dropped: 0 };
  const registry = optimize ? selectTools(hub.registry, options.text, tier) : hub.registry;
  const memories = hub.memory ? memoryContext(searchMemories(await hub.memory.list(ctx.userId), options.text, 3, ctx.now())) : '';

  const light = tier === 'L2' && optimize;
  const model = provider === 'openai'
    ? (light ? process.env.OPENAI_MODEL_LIGHT?.trim() || hub.config.openai.model : hub.config.openai.model)
    : (light ? process.env.NOIRXU_AI_MODEL_LIGHT?.trim() || hub.config.anthropicModel : hub.config.anthropicModel);
  const turnLimits = optimize
    ? { maxOutputTokens: limits.maxOutputTokens, maxIterations: limits.maxIterations, effort: light ? 'low' as const : 'medium' as const, beforeCall: hub.cost.perTaskCheck(model, admitted.config) }
    : { beforeCall: hub.cost.perTaskCheck(model, admitted.config) };
  const hitsBefore = hub.executor.cacheHits;
  const common = { registry, executor: hub.executor, ctx, userText: options.text, style: options.style, onProgress: options.onProgress, limits: turnLimits, extraSystem: memories || undefined };

  try {
    const turn = provider === 'openai'
      ? await runOpenAITurn({ ...common, client: options.clients?.openai?.() ?? new OpenAI(), model, reasoningEffort: light ? null : hub.config.openai.reasoningEffort, history })
      : { provider: 'anthropic' as const, ...(await runAgentTurn({ ...common, client: options.clients?.anthropic?.() ?? new Anthropic(), model, history: history as Anthropic.Beta.Messages.BetaMessageParam[] })) };
    await hub.cost.recordTurn({ model, feature: `chat_${tier}`, usage: turn.usage, now: ctx.now() }).catch(() => null);
    await hub.cost.recordCacheHits(hub.executor.cacheHits - hitsBefore, ctx.now()).catch(() => null);
    const kept = trimHistory([...fullHistory.slice(0, dropped), ...turn.messages], KEEP_TURNS).history;
    return { ok: true, provider: turn.provider, messages: kept, reply: turn.reply, events: turn.events, route: { level: tier, source: 'ai', model }, usage: turn.usage, contextReset, stopReason: turn.stopReason };
  } catch (error) {
    await hub.cost.recordTurn({ model, feature: `chat_${tier}`, usage: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, failed: true, now: ctx.now() }).catch(() => null);
    throw error;
  } finally {
    admitted.release();
  }
}
