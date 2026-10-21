import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorker } from './components/ServiceWorker';

export const metadata: Metadata = {
  title: 'NOIRXU AI',
  description: '在一個對話中查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。',
  appleWebApp: { capable: true, title: 'NOIRXU AI', statusBarStyle: 'black-translucent' }
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0b0d0d' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hant"><body>{children}<ServiceWorker /></body></html>;
}
