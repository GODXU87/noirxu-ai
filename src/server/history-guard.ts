import 'server-only';
import { ToolError } from '@/hub/errors';
import { getHub } from './hub';

/** C2 endpoints answer only when their opt-in flag is on (after the migration is applied). */
export function historyHub(feature: 'server_history' | 'memory') {
  const hub = getHub();
  if (!hub.features[feature]) throw new ToolError('NOT_CONFIGURED', feature === 'memory' ? '長期記憶尚未啟用。' : '伺服器對話紀錄尚未啟用。');
  return hub;
}

export function uuidParam(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ToolError('INVALID_INPUT', 'ID 格式不正確。');
  return value;
}
