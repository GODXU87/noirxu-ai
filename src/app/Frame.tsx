import { Suspense } from 'react';
import { loadFeatureFlags } from '@/lib/features';
import { uiMode } from '@/server/ui-mode';
import { SasukeNav } from './sasuke/SasukeNav';
import { TopBar, type Page } from './TopBar';

/** Picks the navigation for the chosen interface; the classic TopBar stays as the fallback. */
export async function Frame({ current }: { current: Page }) {
  if ((await uiMode()) === 'sasuke') return <Suspense fallback={null}><SasukeNav current={current} water={loadFeatureFlags().water} /></Suspense>;
  return <TopBar current={current} />;
}
