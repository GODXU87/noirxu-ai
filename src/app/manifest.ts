import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'NOIRXU AI',
    short_name: 'NOIRXU AI',
    description: '在一個對話中查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0d0d',
    theme_color: '#0b0d0d',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }, { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' }]
  };
}
