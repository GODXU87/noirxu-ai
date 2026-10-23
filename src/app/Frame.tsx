import { uiMode } from '@/server/ui-mode';
import { TopBar, type Page } from './TopBar';

/**
 * Classic navigation per page. The SASUKE navigation lives once in the root layout, so it is
 * not rebuilt (and does not flicker) when moving between pages.
 */
export async function Frame({ current }: { current: Page }) {
  if ((await uiMode()) === 'sasuke') return null;
  return <TopBar current={current} />;
}
