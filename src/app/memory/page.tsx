import { redirect } from 'next/navigation';
import { loadFeatureFlags } from '@/lib/features';
import { currentUser } from '@/server/session';
import { Frame } from '../Frame';
import { PageHeader } from '../TopBar';
import { Memories } from './Memories';

export const dynamic = 'force-dynamic';

export default async function MemoryPage() {
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const enabled = loadFeatureFlags().memory;
  return (
    <div className="shell">
      <Frame current="memory" />
      <PageHeader eyebrow="SASUKE" title="長期記憶" />
      {enabled ? <Memories /> : <p className="banner">長期記憶還沒啟用：需要先核准並套用資料庫變更（C2）。</p>}
    </div>
  );
}
