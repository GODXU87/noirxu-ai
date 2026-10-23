import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { MailView } from '../sasuke/FunctionPages';

export const dynamic = 'force-dynamic';

export default async function MailPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, problem } = await pageState(userId);
  return (
    <div className="shell">
      <Frame current="mail" />
      {problem && <p className="banner danger">{problem}</p>}
      <MailView connected={connected} />
    </div>
  );
}
