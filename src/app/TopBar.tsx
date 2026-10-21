import { BrandMark, Icon, type IconName } from './components/Icon';

export type Page = 'chat' | 'overview' | 'report' | 'connections';

const NAV: Array<{ id: Page; href: string; label: string; icon: IconName }> = [
  { id: 'overview', href: '/overview', label: '總覽', icon: 'overview' },
  { id: 'chat', href: '/', label: '對話', icon: 'chat' },
  { id: 'report', href: '/report', label: '報告', icon: 'report' },
  { id: 'connections', href: '/connections', label: '連線', icon: 'link' }
];

/** Sidebar on desktop, compact header + bottom tab bar on phones (same pattern as NOIRXU Ledger). */
export function TopBar({ current }: { current: Page }) {
  return (
    <>
      <aside className="sidebar">
        <a href="/overview" className="brand"><BrandMark size={30} /><span>NOIRXU <em>AI</em></span></a>
        <nav className="side-nav" aria-label="主要導覽">
          {NAV.map(item => (
            <a key={item.id} href={item.href} aria-current={current === item.id ? 'page' : undefined}>
              <Icon name={item.icon} />{item.label}
            </a>
          ))}
        </nav>
        <form method="post" action="/api/logout" className="side-foot"><button type="submit" className="link-button"><Icon name="logout" size={18} />登出</button></form>
      </aside>
      <header className="mobile-top">
        <a href="/overview" className="brand"><BrandMark size={26} /><span>NOIRXU <em>AI</em></span></a>
        <form method="post" action="/api/logout"><button type="submit" className="icon-button" aria-label="登出"><Icon name="logout" size={19} /></button></form>
      </header>
      <nav className="tab-bar" aria-label="主要導覽">
        {NAV.map(item => (
          <a key={item.id} href={item.href} aria-current={current === item.id ? 'page' : undefined}>
            <Icon name={item.icon} size={22} /><span>{item.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
