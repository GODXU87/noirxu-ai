import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import './globals.css';
import { ServiceWorker } from './components/ServiceWorker';
import { ViewportSync } from './components/ViewportSync';
import { PushToast } from './components/PushToast';
import { Suspense } from 'react';
import { uiMode } from '@/server/ui-mode';
import { SasukeNav } from './sasuke/SasukeNav';

export const metadata: Metadata = {
  title: 'NOIRXU AI',
  description: '在一個對話中查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。',
  appleWebApp: { capable: true, title: 'SASUKE', statusBarStyle: 'black-translucent' }
};
export async function generateViewport(): Promise<Viewport> {
  const ui = await uiMode();
  return { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: ui === 'sasuke' ? '#04060a' : '#0b0d0d' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ui = await uiMode();
  return (
    <html lang="zh-Hant" className={ui === 'sasuke' ? 'ui-sasuke' : undefined} suppressHydrationWarning>
      <body>
        {/* Apply the saved sidebar width before first paint so the layout never jumps. */}
        {ui === 'sasuke' && <script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('noirxu-ui-sidebar-collapsed')==='1')document.documentElement.classList.add('sidebar-collapsed')}catch(e){}" }} />}
        {ui === 'sasuke' && <Suspense fallback={null}><SasukeNav /></Suspense>}
        {ui === 'sasuke' && <ViewportSync />}
        {ui === 'sasuke' && <PushToast />}
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
