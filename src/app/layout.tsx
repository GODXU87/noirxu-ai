import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource/noto-serif-tc/300.css';
import '@fontsource/noto-serif-tc/500.css';
import '@fontsource/noto-sans-tc/300.css';
import '@fontsource/noto-sans-tc/400.css';
import './globals.css';
import { ServiceWorker } from './components/ServiceWorker';
import { uiMode } from '@/server/ui-mode';

export async function generateMetadata(): Promise<Metadata> {
  const ui = await uiMode();
  return {
    title: 'NOIRXU AI',
    description: '在一個對話中查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。',
    appleWebApp: { capable: true, title: 'NOIRXU AI', statusBarStyle: ui === 'sasuke' ? 'default' : 'black-translucent' }
  };
}
export async function generateViewport(): Promise<Viewport> {
  const ui = await uiMode();
  return { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: ui === 'sasuke' ? '#f6f4ef' : '#0b0d0d' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ui = await uiMode();
  return <html lang="zh-Hant" className={ui === 'sasuke' ? 'ui-sasuke' : undefined}><body>{children}<ServiceWorker /></body></html>;
}
