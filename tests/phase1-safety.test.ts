import { describe, expect, it, vi } from 'vitest';
import { isAllowedPushEndpoint } from '@/push/endpoints';

vi.mock('server-only', () => ({}));
const throttle = await import('@/server/login-throttle');

describe('push endpoint allowlist', () => {
  it('accepts real browser push services', () => {
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGx1')).toBe(true);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
  });
  it('rejects anything else (no requests to arbitrary hosts)', () => {
    expect(isAllowedPushEndpoint('https://evil.example.com/push.apple.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://push.apple.com.evil.example/')).toBe(false);
    expect(isAllowedPushEndpoint('http://web.push.apple.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://web.push.apple.com:8443/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedPushEndpoint('not a url')).toBe(false);
  });
});

describe('login throttle', () => {
  it('locks a client out after repeated failures within the window', async () => {
    vi.useFakeTimers();
    const key = 'test-client';
    const now = Date.now();
    for (let i = 0; i < 8; i += 1) {
      const pending = throttle.recordFailure(key, now);
      vi.advanceTimersByTime(1000);
      await pending;
    }
    expect(throttle.isLockedOut(key, now)).toBe(true);
    expect(throttle.isLockedOut(key, now + 16 * 60 * 1000)).toBe(false);
    throttle.clearFailures(key);
    expect(throttle.isLockedOut(key, now)).toBe(false);
    vi.useRealTimers();
  });
});

describe('ToolError across bundles', () => {
  it('is recognised by brand even when instanceof fails', async () => {
    const { isToolError, toToolError, ToolError } = await import('@/hub/errors');
    const foreign = Object.assign(new Error('沒有存成記憶'), { code: 'INVALID_INPUT', name: 'ToolError', [Symbol.for('noirxu-ai.ToolError')]: true });
    expect(foreign instanceof ToolError).toBe(false);
    expect(isToolError(foreign)).toBe(true);
    expect(toToolError(foreign).code).toBe('INVALID_INPUT');
    expect(toToolError(new Error('x')).code).toBe('INTERNAL');
  });
});
