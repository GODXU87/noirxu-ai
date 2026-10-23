import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { MemoryView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function MemoryPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { problem } = await pageState(userId);
  return (
    <div className="shell">
      <Frame current="memory" />
      {problem && <p className="banner danger">{problem}</p>}
      <MemoryView />
    </div>
  );
}
