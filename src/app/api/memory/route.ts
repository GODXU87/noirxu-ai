import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { MEMORY_CATEGORIES, type MemoryCategory } from '@/memory/store';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

// The 個人記憶 page: list, add, edit and delete what SASUKE remembers. Deleting here is the
// user's own explicit action on their own page, so it needs no extra confirmation step.

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const category = z.enum(Object.keys(MEMORY_CATEGORIES) as [MemoryCategory, ...MemoryCategory[]]);

export async function GET(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: false });
    return json({ ok: true, memories: await getHub().memories.list(ctx.userId), categories: MEMORY_CATEGORIES });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const body = z.object({ content: z.string().trim().min(2).max(300), category: category.optional() }).safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ToolError('INVALID_INPUT', '請輸入要記住的內容（2–300 字）。');
    return json({ ok: true, ...(await getHub().memories.add(ctx.userId, { ...body.data, now: ctx.now() })) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const body = z.object({ id: z.uuid(), revision, content: z.string().trim().min(2).max(300).optional(), category: category.optional() }).refine(body => body.content !== undefined || body.category !== undefined).safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ToolError('INVALID_INPUT', '修改內容不正確。');
    const memory = await getHub().memories.update(ctx.userId, body.data.id, body.data, ctx.now(), body.data.revision);
    if (!memory) throw new ToolError('NOT_FOUND', '找不到這筆記憶。');
    return json({ ok: true, memory });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const body = z.object({ id: z.uuid(), revision }).safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ToolError('INVALID_INPUT', '缺少要刪除的記憶。');
    return json({ ok: true, removed: await getHub().memories.remove(ctx.userId, body.data.id, body.data.revision) });
  } catch (error) {
    return errorResponse(error);
  }
}
