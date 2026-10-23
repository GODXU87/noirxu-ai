import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { REPLY_STYLES } from '@/server/agent';
import { handleChat } from '@/server/chat-turn';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

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
    const hub = getHub();
    const options = { text: parsed.data.text, style: parsed.data.style, history: parsed.data.history, provider: parsed.data.provider };

    // NDJSON stream: tool progress as it happens, then the finished turn. Clients that do
    // not ask for it get the single JSON response as before.
    if ((request.headers.get('accept') ?? '').includes('application/x-ndjson')) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const write = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          try {
            write({ type: 'done', ...(await handleChat(hub, ctx, { ...options, onProgress: event => write(event) })) });
          } catch (error) {
            write({ type: 'done', ...(await errorBody(error)) });
          } finally {
            controller.close();
          }
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    }
    const result = await handleChat(hub, ctx, options);
    return json(result, result.ok ? 200 : result.error.code === 'BUDGET_EXCEEDED' ? 429 : 400);
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
