import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ToolContext } from '@/hub/types';
import { classify } from '@/router/intents';
import { runLocal, withSir } from '@/router/local';
import { memoryContext, searchMemories } from '@/router/memory';
import { taipeiDate } from '@/lib/dates';
import { fetchUsQuotes } from '@/markets/us';
import { turnEvents } from '@/quality/log';
import { cachedWeather } from '@/weather/open-meteo';
import { chooseTier, selectTools, TIER_LIMITS, trimHistory, type ModelTier } from '@/router/tier';
import { runAgentTurn, type ProgressEvent, type ReplyStyle, type ToolEvent, type TurnUsage } from './agent';
import { pickProvider } from './config';
import type { Hub } from './hub';
import { historyProviderOf } from './providers/history';
import { runOpenAITurn } from './providers/openai';
import { eveningBriefing, lastExternalTick, morningBriefing } from './tick';

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
  /** Route of the previous reply ("L1 garmin_sleep", "L2"), so a correction is pinned on it. */
  previousRoute?: string;
  /** For the benchmark: compare with the router and the token limits switched off. */
  router?: boolean;
  optimize?: boolean;
  clients?: { anthropic?: () => Anthropic; openai?: () => OpenAI };
}

/** Upper bound on what is kept for later turns (the screen keeps everything). */
const KEEP_TURNS = 40;

/** Route label used by the quality log ("L1 garmin_sleep", "L2"). */
export const routeTag = (route: RouteInfo) => [route.level, route.intent].filter(Boolean).join(' ');

export async function handleChat(hub: Hub, ctx: ToolContext, options: ChatOptions): Promise<ChatResult> {
  let result: ChatResult | null = null;
  try {
    result = await chatTurn(hub, ctx, options);
    return result;
  } catch (error) {
    await hub.quality?.record(ctx.userId, [{ kind: 'chat_error', code: 'MODEL_UNAVAILABLE' }], ctx.now()).catch(() => null);
    throw error;
  } finally {
    // Quality self-check: failed tools, and "不對 / 錯了" pinned on the previous reply.
    if (result && hub.quality) {
      const text = options.text.replace(/^\[系統紀錄\][\s\S]*?\n\n/, '');
      const events = result.ok
        ? turnEvents({ text, previousRoute: options.previousRoute, route: routeTag(result.route), events: result.events })
        : [{ kind: 'chat_error' as const, code: result.error.code, source: result.route ? routeTag(result.route) : undefined }];
      await hub.quality.record(ctx.userId, events, ctx.now()).catch(() => null);
    }
  }
}

async function chatTurn(hub: Hub, ctx: ToolContext, options: ChatOptions): Promise<ChatResult> {
  const useRouter = options.router ?? true;
  const optimize = options.optimize ?? true;

  const intent = useRouter ? classify(options.text) : null;
  if (intent) {
    const turn = await runLocal(intent, {
      executor: hub.executor, ctx, memory: hub.memory,
      isConnected: connection => hub.isConnected(ctx.userId, connection as never),
      briefing: async which => (which === 'morning' ? morningBriefing(hub, ctx.userId, ctx.now()) : eveningBriefing(hub, ctx.userId, ctx.now())),
      weather: hub.features?.weather ? day => cachedWeather(day, taipeiDate(ctx.now())) : undefined,
      usQuotes: hub.features?.us_markets ? () => fetchUsQuotes({ apiKey: process.env.ALPHAVANTAGE_API_KEY?.trim() || undefined, store: hub.agenda, vault: hub.vault, now: ctx.now() }) : undefined,
      schedulerAgeMinutes: async () => { const last = await lastExternalTick(hub); return last ? Math.round((ctx.now().getTime() - Date.parse(last.at)) / 60_000) : null; }
    });
    await hub.cost.recordLocal(intent.kind, ctx.now()).catch(() => null);
    // Every reply addresses Sir, including the short and error ones.
    turn.reply = withSir(turn.reply, `${intent.kind}:${options.text}`);
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
  let model = provider === 'openai'
    ? (light ? process.env.OPENAI_MODEL_LIGHT?.trim() || hub.config.openai.model : hub.config.openai.model)
    : (light ? process.env.NOIRXU_AI_MODEL_LIGHT?.trim() || hub.config.anthropicModel : hub.config.anthropicModel);
  // Providers mutate this usage object as responses arrive. Retain it even when a
  // later iteration throws, so paid work is recorded and never restarted on fallback.
  let attemptedUsage: TurnUsage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const beforeCallFor = (selectedModel: string) => {
    const check = hub.cost.perTaskCheck(selectedModel, admitted.config);
    return (usage: TurnUsage) => { attemptedUsage = usage; return check(usage); };
  };
  const turnLimits = optimize
    ? { maxOutputTokens: limits.maxOutputTokens, maxIterations: limits.maxIterations, effort: light ? 'low' as const : 'medium' as const, beforeCall: beforeCallFor(model) }
    : { beforeCall: beforeCallFor(model) };
  const hitsBefore = hub.executor.cacheHits;
  const common = { registry, executor: hub.executor, ctx, userText: options.text, style: options.style, onProgress: options.onProgress, limits: turnLimits, extraSystem: memories || undefined };

  try {
    const openaiTurn = (m: string) => runOpenAITurn({ ...common, limits: { ...turnLimits, beforeCall: beforeCallFor(m) }, client: options.clients?.openai?.() ?? new OpenAI(), model: m, reasoningEffort: light ? null : hub.config.openai.reasoningEffort, history });
    const turn = provider === 'openai'
      // A light model this account cannot use falls back to the main model instead of failing.
      ? await openaiTurn(model).catch(error => {
        if (attemptedUsage.calls === 0 && light && model !== hub.config.openai.model && error instanceof OpenAI.APIError && (error.status === 404 || error.status === 400) && /model/i.test(error.message)) {
          console.warn('[noirxu-ai] light model rejected, using the main model', model, error.status);
          model = hub.config.openai.model;
          return openaiTurn(model);
        }
        throw error;
      })
      : { provider: 'anthropic' as const, ...(await runAgentTurn({ ...common, client: options.clients?.anthropic?.() ?? new Anthropic(), model, history: history as Anthropic.Beta.Messages.BetaMessageParam[] })) };
    await hub.cost.recordTurn({ model, feature: `chat_${tier}`, usage: turn.usage, now: ctx.now() }).catch(() => null);
    await hub.cost.recordCacheHits(hub.executor.cacheHits - hitsBefore, ctx.now()).catch(() => null);
    const kept = trimHistory([...fullHistory.slice(0, dropped), ...turn.messages], KEEP_TURNS).history;
    return { ok: true, provider: turn.provider, messages: kept, reply: turn.reply, events: turn.events, route: { level: tier, source: 'ai', model }, usage: turn.usage, contextReset, stopReason: turn.stopReason };
  } catch (error) {
    await hub.cost.recordTurn({ model, feature: `chat_${tier}`, usage: attemptedUsage, failed: true, now: ctx.now() }).catch(() => null);
    throw error;
  } finally {
    admitted.release();
  }
}
