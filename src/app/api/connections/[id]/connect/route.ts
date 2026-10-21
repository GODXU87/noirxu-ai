import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { assertConnectionId } from '@/server/connections';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

const body = z.object({ email: z.email(), password: z.string().min(1).max(200) });

/** Ledger / Journal: signs in with the user's own account. The password is used once and not stored. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const id = assertConnectionId((await params).id);
    if (id !== 'ledger' && id !== 'journal') throw new ToolError('INVALID_INPUT', '這個連線不使用帳號密碼。');
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ToolError('INVALID_INPUT', '請輸入 Email 與密碼。');
    const result = await getHub()[id].connect(ctx.userId, parsed.data.email, parsed.data.password);
    return json({ ok: true, account: result.email });
  } catch (error) {
    return errorResponse(error);
  }
}
