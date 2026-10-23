import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { loadConfig } from '@/server/config';
import { Frame } from '../Frame';
import { ResearchView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function ResearchPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, problem } = await pageState(userId);
  return (
    <div className="shell">
      <Frame current="research" />
      {problem && <p className="banner danger">{problem}</p>}
      <ResearchView connected={connected} radarUrl={loadConfig().radar.appUrl} />
    </div>
  );
}
