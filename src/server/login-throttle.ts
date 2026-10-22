import 'server-only';

// Per-instance limiter for the owner login. Serverless instances do not share memory,
// so this slows guessing rather than guaranteeing a global limit; failures also wait.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const FAILURE_DELAY_MS = 800;
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

export function clientKey(request: Request): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

export function isLockedOut(key: string, now = Date.now()): boolean {
  return recent(key, now).length >= MAX_FAILURES;
}

export async function recordFailure(key: string, now = Date.now()): Promise<void> {
  recent(key, now).push(now);
  await new Promise(resolve => setTimeout(resolve, FAILURE_DELAY_MS));
}

export function clearFailures(key: string): void {
  failures.delete(key);
}
