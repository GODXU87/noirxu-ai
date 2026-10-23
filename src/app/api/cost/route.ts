import { z } from 'zod';
import { estimatedSavings } from '@/cost/guard';
import { priceOf } from '@/cost/pricing';
import { ToolError } from '@/hub/errors';
import { taipeiDate } from '@/lib/dates';
import { pickProvider } from '@/server/config';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/** AI cost guard: this month's measured usage, limits and mode. */
export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const hub = getHub();
    const [config, usage] = await Promise.all([hub.cost.config(), hub.cost.usage(ctx.now())]);
    const provider = pickProvider();
    const models = provider === 'openai' ? [hub.config.openai.model, process.env.OPENAI_MODEL_LIGHT?.trim()].filter(Boolean) as string[]
      : provider === 'anthropic' ? [hub.config.anthropicModel, process.env.NOIRXU_AI_MODEL_LIGHT?.trim()].filter(Boolean) as string[] : [];
    return json({
      ok: true,
      config,
      usage,
      today_usd: usage.days[taipeiDate(ctx.now())] ?? 0,
      savings: estimatedSavings(usage),
      models: [...new Set(models)].map(model => ({ model, priced: priceOf(model) !== null }))
    });
  } catch (error) {
    return errorResponse(error);
  }
}

const patch = z.object({
  mode: z.enum(['economy', 'balanced', 'quality']).optional(),
  per_task_usd: z.number().min(0.01).max(20).optional(),
  daily_usd: z.number().min(0).max(500).optional(),
  monthly_usd: z.number().min(0).max(5000).optional(),
  max_calls_per_task: z.number().int().min(1).max(20).optional(),
  max_concurrent: z.number().int().min(1).max(10).optional()
}).strict();

export async function POST(request: Request) {
  try {
    await requireContext(request, { mutating: true });
    const parsed = patch.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '設定值不正確。');
    return json({ ok: true, config: await getHub().cost.setConfig(parsed.data) });
  } catch (error) {
    return errorResponse(error);
  }
}
