import { redirect } from 'next/navigation';
import { connectionStatuses } from '@/server/connections';
import { getHub } from '@/server/hub';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { PageHeader, TopBar } from '../TopBar';
import { Connections } from './Connections';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ gmail?: string }> }) {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { problem } = await pageState(userId);
  const { gmail } = await searchParams;
  if (problem) {
    return <div className="shell"><TopBar current="connections" /><PageHeader eyebrow="設定" title="連線" /><p className="banner danger">{problem}</p></div>;
  }
  const hub = getHub();
  return (
    <div className="shell">
      <TopBar current="connections" />
      <PageHeader eyebrow="設定" title="連線" />
      {hub.storageMode === 'memory' && <p className="banner">開發模式：連線只存在伺服器記憶體，重新啟動後需重新連接。</p>}
      <Connections initial={await connectionStatuses(hub, userId)} gmailResult={gmail ?? null} redirectUri={hub.config.google.redirectUri} />
    </div>
  );
}
