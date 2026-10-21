import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const { id } = await params;
    return json({ ok: true, result: await getHub().executor.confirm(id, ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}
