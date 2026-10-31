import { PROJECTS, projectSchema, shaSchema, type Evidence, type Project } from './model';
import { safeTaskLinks } from '@/tasks/evidence';

/** Public API only. No credentials, arbitrary hosts, redirects or returned URLs are fetched. */
async function github(path: string, fetcher: typeof fetch): Promise<any> {
 const response = await fetcher(`https://api.github.com${path}`, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
  headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(8000) });
 if (!response.ok) throw new Error(response.status === 404 ? 'not_visible' : response.status === 403 || response.status === 429 ? 'limited' : 'upstream');
 const reader = response.body?.getReader(); if (!reader) throw new Error('format');
 const decoder = new TextDecoder(); let size = 0, body = '';
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 256_000) throw new Error('format'); body += decoder.decode(value, { stream: true }); } }
 finally { await reader.cancel().catch(() => {}); }
 return JSON.parse(body + decoder.decode());
}
const reason = (e: unknown) => e instanceof Error && e.message === 'not_visible' ? '此公開 API 看不到指定 commit；可能是私有儲存庫或 SHA 不存在。請由原系統核對，不會索取或新增權限。'
 : e instanceof Error && e.message === 'limited' ? 'GitHub 拒絕或限流；稍後再查，或到原系統人工核對。'
 : 'GitHub 回應中斷、逾時或格式不符；本次無法查證，請稍後再查。';
export async function readGitHubEvidence(project: Project, sha: string, now: Date, fetcher: typeof fetch = fetch): Promise<Evidence> {
 projectSchema.parse(project); sha = shaSchema.parse(sha); const repo = PROJECTS[project].repo;
 const result: Evidence = { checked_at: now.toISOString(), commit: { state: 'unknown', reason: '尚未查證' }, ci: [],
  deployment: { state: 'unsupported', reason: '尚無 Vercel 唯讀驗證能力。下方 CI 狀態不是正式環境 READY、alias 或部署 SHA 的證明。請在部署平台核對。' },
  runtime: { state: 'unsupported', reason: '未自動開啟正式網站或執行功能。網址與 HTTP 200 都不等於功能驗收；請依驗收條件人工檢查並記錄。' } };
 try {
  // Git commit endpoint avoids unnecessary diff/content payloads.
  const commit = await github(`/repos/${repo}/git/commits/${sha}`, fetcher);
  if (commit?.sha !== sha) { result.commit = { state: 'blocked', reason: '來源回傳的 SHA 不符；請核對完整 commit，不會視為完成。' }; return result; }
  result.commit = { state: 'verified', reason: 'GitHub 確認此完整 SHA 存在；不代表已部署或功能通過。', url: `https://github.com/${repo}/commit/${sha}` };
 } catch (e) { result.commit = { state: e instanceof Error && ['not_visible','limited'].includes(e.message) ? 'blocked' : 'unknown', reason: reason(e) }; return result; }
 try {
  const status = await github(`/repos/${repo}/commits/${sha}/status?per_page=10`, fetcher);
  if (status?.sha !== sha || !Array.isArray(status.statuses)) throw new Error('format');
  result.ci = status.statuses.slice(0,10).filter((s: any) => typeof s?.context === 'string' && ['success','failure','error','pending'].includes(s.state)).map((s: any) => {
   const safe = safeTaskLinks([{ label: 'CI', url: s.target_url }])[0];
   const url = safe && ['github.com','vercel.com'].includes(new URL(safe.url).hostname) ? safe.url : undefined;
   return { context: s.context.slice(0,100), state: s.state, ...(url ? { url } : {}) };
  });
  result.ci_reason = result.ci.length ? '只顯示最近最多 10 筆 commit 狀態，非正式部署驗證。' : '沒有可讀取的 CI 狀態；不能推斷成功。';
 } catch (e) { result.ci_reason = reason(e); }
 return result;
}
