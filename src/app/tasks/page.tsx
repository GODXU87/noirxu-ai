import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { TasksView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ goal?: string; task?: string; acceptance?: string }> }) {
  const params = await searchParams;
  const requestedGoal = params.goal;
  const selected = (id?: string) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  const goalId = typeof requestedGoal === 'string' && /^[0-9a-f-]{36}$/i.test(requestedGoal) ? requestedGoal : undefined;
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { problem } = await pageState(userId);
  return (
    <div className="shell">
      <Frame current="tasks" />
      {problem && <p className="banner danger">{problem}</p>}
      <TasksView goalId={goalId} taskId={selected(params.task)} acceptanceId={selected(params.acceptance)} />
    </div>
  );
}
