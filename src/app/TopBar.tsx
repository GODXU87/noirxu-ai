export function TopBar({ current }: { current: 'chat' | 'connections' }) {
  return (
    <header className="top">
      <div className="brand">NOIRXU <span>AI</span></div>
      <nav className="nav">
        <a href="/" aria-current={current === 'chat' ? 'page' : undefined}>對話</a>
        <a href="/connections" aria-current={current === 'connections' ? 'page' : undefined}>Connections</a>
        <form method="post" action="/api/logout"><button type="submit">登出</button></form>
      </nav>
    </header>
  );
}
