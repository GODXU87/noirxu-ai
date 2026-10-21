import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    await requireContext(request, { mutating: false });
    return json({ ok: true, publicKey: await getHub().push.publicKey() });
  } catch (error) {
    return errorResponse(error);
  }
}
