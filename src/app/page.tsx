import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { loadFeatureFlags as getFeatures } from '@/lib/features';
import { Chat } from './Chat';
import { TopBar } from './TopBar';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, storageMode, problem } = await pageState(userId);
  return (
    <div className="shell chat-page">
      <TopBar current="chat" />
      {problem && <p className="banner danger">{problem}</p>}
      {storageMode === 'memory' && <p className="banner">開發模式：資料只存在伺服器記憶體，重新啟動後會清空。</p>}
      <Chat connected={connected} features={getFeatures()} />
    </div>
  );
}
