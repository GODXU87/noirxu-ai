import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { CostGuardView } from './CostGuardView';

export const dynamic = 'force-dynamic';

export default async function CostPage() {
  if (!(await currentUser())) redirect('/login');
  return (
    <div className="shell">
      <Frame current="connections" />
      <CostGuardView />
    </div>
  );
}
