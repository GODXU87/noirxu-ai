import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { REPLY_STYLES, runAgentTurn } from '@/server/agent';
import { MEMORY_CATEGORY_LABEL } from '@/history/privacy';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_BODY_BYTES = 2_000_000;
const body = z.object({
  text: z.string().trim().min(1).max(4000),
  style: z.enum(REPLY_STYLES).default('professional'),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() }).loose()).max(400).default([])
});

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new ToolError('INVALID_INPUT', '對話太長，請開新對話。');
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '訊息格式不正確。');
    if (!process.env.ANTHROPIC_API_KEY) throw new ToolError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY 尚未設定。');
    const hub = getHub();
    const memories = hub.features.memory
      ? (await hub.history.listMemories(ctx.userId).catch(() => [])).map(m => `[${MEMORY_CATEGORY_LABEL[m.category]}] ${m.content}`)
      : [];
    const turn = await runAgentTurn({
      client: new Anthropic(),
      model: hub.config.anthropicModel,
      registry: hub.registry,
      executor: hub.executor,
      ctx,
      history: parsed.data.history as Anthropic.Beta.Messages.BetaMessageParam[],
      userText: parsed.data.text,
      style: parsed.data.style,
      memories
    });
    return json({ ok: true, ...turn });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return json({ ok: false, error: { code: 'MODEL_UNAVAILABLE', message: `AI 服務暫時無法回應（${error.status ?? '連線錯誤'}），沒有執行任何操作。` } }, 502);
    }
    return errorResponse(error);
  }
}
