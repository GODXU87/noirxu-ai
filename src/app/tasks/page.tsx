import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { TasksView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { problem } = await pageState(userId);
  return (
    <div className="shell">
      <Frame current="tasks" />
      {problem && <p className="banner danger">{problem}</p>}
      <TasksView />
    </div>
  );
}
