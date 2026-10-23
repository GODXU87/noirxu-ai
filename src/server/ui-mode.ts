import 'server-only';
import { cookies } from 'next/headers';

export type UiMode = 'classic' | 'sasuke';
export const UI_COOKIE = 'noirxu_ui';

/** Per-browser choice (cookie) first, then the site default (NOIRXU_AI_UI=classic to revert), else SASUKE. */
export async function uiMode(): Promise<UiMode> {
  const chosen = (await cookies()).get(UI_COOKIE)?.value;
  if (chosen === 'classic' || chosen === 'sasuke') return chosen;
  return process.env.NOIRXU_AI_UI?.trim() === 'classic' ? 'classic' : 'sasuke';
}
