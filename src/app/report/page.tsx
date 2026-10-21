import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { TopBar } from '../TopBar';
import { Report } from './Report';

export const dynamic = 'force-dynamic';

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, problem } = await pageState(userId);
  const { month } = await searchParams;
  return (
    <div className="shell">
      <TopBar current="report" />
      {problem && <p className="banner danger">{problem}</p>}
      <Report connected={connected} requestedMonth={/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '') ? month! : null} />
    </div>
  );
}
