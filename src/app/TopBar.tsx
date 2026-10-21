type Page = 'chat' | 'overview' | 'connections';

const NAV: Array<{ id: Page; href: string; label: string; icon: string }> = [
  { id: 'overview', href: '/overview', label: '總覽', icon: '▦' },
  { id: 'chat', href: '/', label: '對話', icon: '◍' },
  { id: 'connections', href: '/connections', label: '連線', icon: '⇄' }
];

export function TopBar({ current }: { current: Page }) {
  return (
    <>
      <header className="top">
        <a href="/" className="brand">NOIRXU <span>AI</span></a>
        <nav className="nav">
          {NAV.map(item => <a key={item.id} href={item.href} aria-current={current === item.id ? 'page' : undefined}>{item.label}</a>)}
          <form method="post" action="/api/logout"><button type="submit">登出</button></form>
        </nav>
      </header>
      <nav className="bottom-nav" aria-label="主要導覽">
        {NAV.map(item => <a key={item.id} href={item.href} aria-current={current === item.id ? 'page' : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}</a>)}
      </nav>
    </>
  );
}
