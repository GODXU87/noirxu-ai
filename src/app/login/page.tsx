import { BrandMark } from '../components/Icon';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand"><BrandMark size={56} /><span>NOIRXU <em>AI</em></span></div>
        <p>Ledger · Journal · RADAR · Gmail，在同一個對話中。</p>
        <form method="post" action="/api/login" style={{ display: 'grid', gap: 10 }}>
          <input type="password" name="password" placeholder="密碼" autoComplete="current-password" required autoFocus aria-label="密碼" />
          {error && <p style={{ color: 'var(--danger)' }}>{error === 'locked' ? '嘗試次數太多，請 15 分鐘後再試。' : '密碼不正確。'}</p>}
          <button className="primary" type="submit">登入</button>
        </form>
      </div>
    </main>
  );
}
