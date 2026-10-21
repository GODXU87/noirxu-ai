import { redirect } from 'next/navigation';
import { CONNECTION_IDS } from '@/hub/types';
import { getHub } from '@/server/hub';
import { currentUser } from '@/server/session';
import { TopBar } from '../TopBar';
import { Overview } from './Overview';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const hub = getHub();
  const connected = Object.fromEntries(await Promise.all(CONNECTION_IDS.map(async id => [id, await hub.isConnected(userId, id)])));
  return (
    <div className="shell">
      <TopBar current="overview" />
      <Overview connected={connected} />
    </div>
  );
}
