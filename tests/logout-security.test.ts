import { expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { POST } = await import('@/app/api/logout/route');

function request(origin?: string) {
  const headers: Record<string, string> = { host: 'example.test' };
  if (origin !== undefined) headers.origin = origin;
  return new Request('https://example.test/api/logout', { method: 'POST', headers });
}

// Removing the route's origin guard must fail these response assertions: an
// untrusted form POST must not clear the session, even without an incoming cookie.
it.each(['https://attacker.test', 'null', undefined])('rejects logout from untrusted origin %s without changing a cookie', async origin => {
  const response = await POST(request(origin));
  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('location')).toBeNull();
});

it('preserves intentional same-origin logout and clears the session cookie', async () => {
  const response = await POST(request('https://example.test'));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://example.test/login');
  expect(response.headers.get('set-cookie')).toContain('noirxu_ai_session=;');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});
