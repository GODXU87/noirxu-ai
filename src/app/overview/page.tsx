import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { uiMode } from '@/server/ui-mode';
import { Frame } from '../Frame';
import { Overview } from './Overview';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const [{ connected, problem }, mode] = await Promise.all([pageState(userId), uiMode()]);
  return (
    <div className="shell">
      <Frame current="overview" />
      {problem && <p className="banner danger">{problem}</p>}
      <Overview connected={connected} finance={mode === 'sasuke'} />
    </div>
  );
}
