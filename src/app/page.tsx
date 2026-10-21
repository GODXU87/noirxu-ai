import { redirect } from 'next/navigation';
import { CONNECTION_IDS } from '@/hub/types';
import { getHub } from '@/server/hub';
import { currentUser } from '@/server/session';
import { Chat } from './Chat';
import { TopBar } from './TopBar';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const hub = getHub();
  const connected = Object.fromEntries(await Promise.all(CONNECTION_IDS.map(async id => [id, await hub.isConnected(userId, id)])));
  return (
    <div className="shell chat-shell">
      <TopBar current="chat" />
      {hub.storageMode === 'memory' && <p className="banner">開發模式：連線與待確認操作只存在伺服器記憶體，重新啟動後會清空。</p>}
      <Chat connected={connected} />
    </div>
  );
}
