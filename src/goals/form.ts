/** Parse HTML datetime-local values as Taiwan time, never the browser/host timezone.
 * Browsers may include seconds/fractions. Reject empty or rolled-over calendar dates
 * before toISOString(), so invalid input never produces an uncaught RangeError.
 */
export function taipeiLocalToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  const invalid = () => new Error('請輸入有效的日期與時間（台灣時間）。');
  if (!match) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(v => Number(v ?? 0));
  const ms = Number((match[7] ?? '').padEnd(3, '0'));
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (year < 1000 || wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) throw invalid();
  return new Date(wall.getTime() - 8 * 3600_000).toISOString();
}

/** One shared boundary for create/edit/history actions: even validation or unexpected
 * transport exceptions release the busy lock, and repeated clicks cannot double-submit.
 */
export async function submitGoalForm(
  lock: { current: boolean }, setBusy: (busy: boolean) => void, setError: (message: string) => void,
  action: () => Promise<void>
): Promise<void> {
  if (lock.current) return;
  lock.current = true; setBusy(true); setError('');
  try { await action(); }
  catch (error) { setError(error instanceof Error ? error.message : '資料尚未儲存，請檢查欄位後再試。'); }
  finally { lock.current = false; setBusy(false); }
}
