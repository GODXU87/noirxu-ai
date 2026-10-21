import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { TopBar } from '../TopBar';
import { Overview } from './Overview';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, storageMode, problem } = await pageState(userId);
  return (
    <div className="shell">
      <TopBar current="overview" />
      {problem && <p className="banner danger">{problem}</p>}
      <Overview connected={connected} />
    </div>
  );
}
