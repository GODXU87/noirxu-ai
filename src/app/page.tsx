import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';
import { getHub } from '@/server/hub';
import { Chat } from './Chat';
import { TopBar } from './TopBar';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  if (!(await currentUser())) redirect('/login');
  const memory = getHub().storageMode === 'memory';
  return (
    <div className="shell">
      <TopBar current="chat" />
      {memory && <p className="banner">開發模式：連線與待確認操作只存在伺服器記憶體，重新啟動後會清空。</p>}
      <Chat />
    </div>
  );
}
