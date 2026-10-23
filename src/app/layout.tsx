import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import './globals.css';
import { ServiceWorker } from './components/ServiceWorker';
import { uiMode } from '@/server/ui-mode';

export const metadata: Metadata = {
  title: 'NOIRXU AI',
  description: '在一個對話中查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。',
  appleWebApp: { capable: true, title: 'NOIRXU AI', statusBarStyle: 'black-translucent' }
};
export async function generateViewport(): Promise<Viewport> {
  const ui = await uiMode();
  return { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: ui === 'sasuke' ? '#04060a' : '#0b0d0d' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ui = await uiMode();
  return <html lang="zh-Hant" className={ui === 'sasuke' ? 'ui-sasuke' : undefined}><body>{children}<ServiceWorker /></body></html>;
}
