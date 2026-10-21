export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <div className="brand">NOIRXU <span>AI</span></div>
      <form method="post" action="/api/login" style={{ display: 'grid', gap: 10 }}>
        <input type="password" name="password" placeholder="密碼" autoComplete="current-password" required autoFocus />
        {error && <p className="hint" style={{ color: 'var(--danger)' }}>密碼不正確。</p>}
        <button className="primary" type="submit">登入</button>
      </form>
    </main>
  );
}
