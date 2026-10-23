import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { REPLY_STYLES, runAgentTurn } from '@/server/agent';
import { pickProvider } from '@/server/config';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { historyProviderOf } from '@/server/providers/history';
import { runOpenAITurn } from '@/server/providers/openai';
import { MEMORY_CATEGORY_LABEL } from '@/history/privacy';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_BODY_BYTES = 2_000_000;
const body = z.object({
  text: z.string().trim().min(1).max(4000),
  style: z.enum(REPLY_STYLES).default('professional'),
  // Provider-specific model context, sent back unchanged by the client.
  history: z.array(z.unknown()).max(600).default([]),
  /** Which provider produced `history`; context from another provider is not reused. */
  provider: z.enum(['anthropic', 'openai']).optional()
});

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new ToolError('INVALID_INPUT', '對話太長，請開新對話。');
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '訊息格式不正確。');
    const provider = pickProvider();
    if (!provider) throw new ToolError('NOT_CONFIGURED', 'AI 金鑰尚未設定（ANTHROPIC_API_KEY 或 OPENAI_API_KEY）。');
    const hub = getHub();
    const memories = hub.features.memory
      ? (await hub.history.listMemories(ctx.userId).catch(() => [])).map(m => `[${MEMORY_CATEGORY_LABEL[m.category]}] ${m.content}`)
      : [];
    // History written by the other provider has an incompatible format: start a fresh context
    // (the conversation on screen is kept).
    const historyProvider = parsed.data.provider ?? historyProviderOf(parsed.data.history);
    const contextReset = historyProvider !== null && historyProvider !== provider;
    const history = contextReset ? [] : parsed.data.history;
    const common = { registry: hub.registry, executor: hub.executor, ctx, userText: parsed.data.text, style: parsed.data.style, memories };
    const turn = provider === 'openai'
      ? await runOpenAITurn({ ...common, client: new OpenAI(), model: hub.config.openai.model, reasoningEffort: hub.config.openai.reasoningEffort, history })
      : { provider: 'anthropic' as const, ...(await runAgentTurn({ ...common, client: new Anthropic(), model: hub.config.anthropicModel, history: history as Anthropic.Beta.Messages.BetaMessageParam[] })) };
    return json({ ok: true, ...turn, contextReset });
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
      return json({ ok: false, error: { code: 'MODEL_UNAVAILABLE', message: `AI 服務暫時無法回應（${error.status ?? '連線錯誤'}），沒有執行任何操作。` } }, 502);
    }
    return errorResponse(error);
  }
}
