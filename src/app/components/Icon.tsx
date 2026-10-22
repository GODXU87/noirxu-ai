// Line icons (1.6px stroke, 24px grid), drawn to match the NOIRXU sites.
const PATHS = {
  overview: 'M4 5h7v6H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 13h7v6H4z',
  chat: 'M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16h-.5A.5.5 0 0 1 5 15.5z',
  report: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4M9 13h6M9 16.5h6M9 9.5h2',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  logout: 'M14 4h4.5a.5.5 0 0 1 .5.5v15a.5.5 0 0 1-.5.5H14M10 8l-4 4 4 4M6 12h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  send: 'M5 12l14-7-5 15-2.5-6.5z',
  close: 'M6 6l12 12M18 6L6 18',
  edit: 'M5 19l1-4 9.5-9.5a2.1 2.1 0 0 1 3 3L9 18zM14 7l3 3',
  calendar: 'M5 6.5h14v13H5zM5 10.5h14M9 4v4M15 4v4',
  arrow: 'M9 6l6 6-6 6',
  print: 'M7 9V4h10v5M7 17H5v-7h14v7h-2M7 14h10v6H7z',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13V9H6.5A2.5 2.5 0 0 1 4 7.5zM15.5 14h.01',
  chart: 'M4 19.5h16M7 16v-5M11 16V7M15 16v-3M19 16V9',
  drop: 'M12 3.5c3 4 5.5 7 5.5 10.2A5.5 5.5 0 0 1 6.5 13.7C6.5 10.5 9 7.5 12 3.5z'
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** N/X monogram used in the sidebar, login and empty states. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect x="16" y="16" width="480" height="480" rx="112" fill="none" stroke="var(--line-strong)" strokeWidth="14" />
      <path d="M150 360V152l120 208V152" fill="none" stroke="var(--text)" strokeWidth="38" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M318 152l64 104-64 104" fill="none" stroke="var(--accent)" strokeWidth="38" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
