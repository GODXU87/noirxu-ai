import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { historyHub } from '@/server/history-guard';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

const item = z.object({ kind: z.string().max(20) }).loose();
const body = z.union([
  z.object({ title: z.string().trim().max(120).optional() }).strict(),
  z.object({
    import: z.object({
      key: z.string().trim().min(1).max(120),
      source: z.enum(['legacy_import', 'local_import']),
      title: z.string().max(120),
      items: z.array(item).max(2000),
      history: z.array(z.unknown()).max(2000).default([]),
      notes: z.array(z.string()).max(200).default([])
    }).strict()
  }).strict()
]);

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    const q = new URL(request.url).searchParams.get('q')?.slice(0, 100) ?? undefined;
    return json({ ok: true, conversations: await historyHub('server_history').history.list(ctx.userId, q) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '格式不正確。');
    const { history } = historyHub('server_history');
    if ('import' in parsed.data) {
      const i = parsed.data.import;
      const result = await history.importConversation(ctx.userId, { importKey: i.key, source: i.source, title: i.title, items: i.items as never, context: { history: i.history, notes: i.notes } });
      return json({ ok: true, ...result });
    }
    return json({ ok: true, conversation: await history.create(ctx.userId, parsed.data.title) });
  } catch (error) {
    return errorResponse(error);
  }
}
