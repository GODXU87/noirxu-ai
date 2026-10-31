import type { SourceLink } from '@/hub/types';
import type { StepResult, TaskRun } from './model';

/** Tool links are evidence of a source, not proof that an artifact was created. */
export function safeTaskLinks(input: unknown): SourceLink[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const links: SourceLink[] = [];
  for (const item of input.slice(0, 50)) {
    if (!item || typeof item.url !== 'string' || item.url.length > 2048 || typeof item.label !== 'string') continue;
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      // Never persist login callbacks, bearer credentials or signed download URLs.
      const sensitive = /token|secret|password|passwd|authorization|credential|signature|api.?key|^key$|^code$|^sig$|^auth$|^policy$|^key-pair-id$|^awsaccesskeyid$/i;
      if ([...url.searchParams.keys()].some(k => sensitive.test(k)) || url.hash) continue;
      if ([...url.searchParams.values()].some(v => /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|^Bearer\s+|^(?:sk-|ghp_|github_pat_)/i.test(v))) continue;
      if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:token|secret|password|api[-_]?key)[/=]/i.test(decodeURIComponent(url.pathname))) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ label: item.label.slice(0, 120), url: url.href });
      if (links.length === 8) break;
    } catch { /* Invalid URLs are not navigable evidence. */ }
  }
  return links;
}

export function taskNextStep(run: Pick<TaskRun, 'status' | 'steps'>): string | null {
  const codes = (run.steps ?? []).map((s: StepResult) => s.error_code);
  if (run.status === 'outcome_unknown' || codes.includes('OUTCOME_UNKNOWN')) return '先到原系統核對是否已產生紀錄；結果未明前不要重新執行，以免重複寫入。';
  if (codes.includes('PROPOSAL_EXPIRED')) return '這個待確認步驟已過期，沒有執行；先核對前面已完成的步驟。若仍需要，請重新提出要求並檢查新的確認內容。';
  if (run.status === 'waiting_approval') return '請查看待確認操作；只有你明確確認後才會執行。通知送達不代表已執行。';
  if (codes.some(c => c === 'NOT_CONNECTED' || c === 'UNAUTHORIZED' || c === 'NOT_CONFIGURED')) return '先到連線頁檢查對應來源；修復連線不會自動重跑這次操作。';
  if (run.status === 'failed') return '查看下方失敗步驟與原因；先核對已完成的步驟，再決定是否另提新要求。這裡不會自動重跑寫入。';
  if (run.status === 'not_met') return '這次條件未達成，沒有觸發後續操作；請查看任務的下次排程。';
  if (run.status === 'skipped') return '這次已略過，沒有補跑；請查看任務的下次排程。';
  return null;
}
