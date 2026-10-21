import 'server-only';
import { CONNECTION_IDS } from '@/hub/types';
import { getHub, HubConfigError } from './hub';

/** Connection flags for page headers; a broken database shows a message instead of crashing the page. */
export async function pageState(userId: string): Promise<{ connected: Record<string, boolean>; storageMode: 'database' | 'memory' | null; problem: string | null }> {
  try {
    const hub = getHub();
    const connected = Object.fromEntries(await Promise.all(CONNECTION_IDS.map(async id => [id, await hub.isConnected(userId, id)])));
    return { connected, storageMode: hub.storageMode, problem: null };
  } catch (error) {
    const problem = error instanceof HubConfigError
      ? error.message
      : (error as { code?: string }).code === '28P01'
        ? 'NOIRXU AI 的資料庫登入失敗：NOIRXU_AI_DATABASE_URL 的帳號或密碼不正確。'
        : 'NOIRXU AI 的資料庫暫時無法連線。';
    console.error('[noirxu-ai:page]', problem);
    return { connected: {}, storageMode: null, problem };
  }
}
