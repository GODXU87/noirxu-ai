import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { loadFeatureFlags } from '@/lib/features';
import { Frame } from '../Frame';
import { LifeView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function LifePage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, problem } = await pageState(userId);
  void connected;
  return (
    <div className="shell">
      <Frame current="life" />
      {problem && <p className="banner danger">{problem}</p>}
      <LifeView water={loadFeatureFlags().water} />
    </div>
  );
}
