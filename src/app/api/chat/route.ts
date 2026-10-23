import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { REPLY_STYLES, runAgentTurn, type ProgressEvent } from '@/server/agent';
import { pickProvider } from '@/server/config';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';
import { historyProviderOf } from '@/server/providers/history';
import { runOpenAITurn } from '@/server/providers/openai';

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
    // History written by the other provider has an incompatible format: start a fresh context
    // (the conversation on screen is kept).
    const historyProvider = parsed.data.provider ?? historyProviderOf(parsed.data.history);
    const contextReset = historyProvider !== null && historyProvider !== provider;
    const history = contextReset ? [] : parsed.data.history;
    const common = { registry: hub.registry, executor: hub.executor, ctx, userText: parsed.data.text, style: parsed.data.style };
    const run = (onProgress?: (event: ProgressEvent) => void) => provider === 'openai'
      ? runOpenAITurn({ ...common, onProgress, client: new OpenAI(), model: hub.config.openai.model, reasoningEffort: hub.config.openai.reasoningEffort, history })
      : runAgentTurn({ ...common, onProgress, client: new Anthropic(), model: hub.config.anthropicModel, history: history as Anthropic.Beta.Messages.BetaMessageParam[] }).then(turn => ({ provider: 'anthropic' as const, ...turn }));

    // NDJSON stream: tool progress as it happens, then the finished turn. Clients that do
    // not ask for it get the single JSON response as before.
    if ((request.headers.get('accept') ?? '').includes('application/x-ndjson')) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const write = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          try {
            const turn = await run(event => write(event));
            write({ type: 'done', ok: true, ...turn, contextReset });
          } catch (error) {
            write({ type: 'done', ...(await errorBody(error)) });
          } finally {
            controller.close();
          }
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    }
    return json({ ok: true, ...(await run()), contextReset });
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) return json(await errorBody(error), 502);
    return errorResponse(error);
  }
}

/** The same error body the JSON response uses, for the end of a stream. */
async function errorBody(error: unknown) {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: `AI 服務暫時無法回應（${error.status ?? '連線錯誤'}）。帳本、交易與寄信都需要你確認才會寫入；這次若已建立提醒或喝水紀錄，請到對應頁面確認。` } };
  }
  return (await errorResponse(error).json()) as { ok: false; error: { code: string; message: string } };
}
