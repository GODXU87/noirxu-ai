import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

/**
 * Runs one tool directly (used by the dashboard and quick-entry forms, no AI involved).
 * Same executor as chat: input validation, connection checks, and write tools still only
 * create a proposal that must be confirmed separately.
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    const { name } = await params;
    const input = await request.json().catch(() => ({}));
    return json({ ok: true, result: await getHub().executor.invoke(decodeURIComponent(name), input ?? {}, ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}
