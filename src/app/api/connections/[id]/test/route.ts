import { assertConnectionId, testConnection } from '@/server/connections';
import { getHub } from '@/server/hub';
import { errorResponse, json, requireContext } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(request, { mutating: true });
    return json(await testConnection(getHub(), assertConnectionId((await params).id), ctx));
  } catch (error) {
    return errorResponse(error);
  }
}
