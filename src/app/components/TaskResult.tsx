import type { TaskRun } from '@/tasks/model';
import { safeTaskLinks, taskNextStep } from '@/tasks/evidence';

const STATUS: Record<string, string> = { completed: '完成', failed: '失敗', waiting_approval: '等你確認', outcome_unknown: '結果不明', skipped: '略過', not_met: '條件未達成' };
const STEP: Record<string, string> = { ok: '步驟完成', error: '步驟未完成', waiting_approval: '等待確認', skipped: '略過' };
function deliveryEvidence(status?: string) {
  switch (status) {
    case 'provider_accepted': return '推播服務已接受；不代表裝置已顯示或開啟。';
    case 'failed': return '通知重試已達上限；請到通知收件匣查看。';
    case 'expired': return '通知已過期，未送出；請到通知收件匣查看。';
    case 'held': return '通知僅保留在收件匣，沒有推播。';
    case 'grouped': return '通知併入摘要，不代表裝置已顯示。';
    case 'obsolete': return '確認已結束，不再推送此通知。';
    case 'pending': case 'sending': case 'claimed': case 'retry_pending': return '通知待送出或重試中，不代表裝置已收到。';
    default: return null;
  }
}
/** One evidence view for newest and historical runs; never executes or fetches anything. */
export function TaskResult({ run, latest = false }: { run: Partial<TaskRun> & { local?: string }; latest?: boolean }) {
  const steps = run.steps ?? [];
  const next = run.status ? taskNextStep({ status: run.status, steps }) : null;
  return <section className="task-result" aria-label={latest ? '最近結果' : '執行結果'}>
    <header className="task-result-heading"><strong>{latest ? '最近結果' : '執行結果'} · {STATUS[run.status ?? ''] ?? '狀態未提供'}</strong><span className="muted">{run.local ?? '時間未記錄'}{run.late_minutes ? ` · 晚 ${run.late_minutes} 分` : ''}</span></header>
    {run.error && <p className="hint tone-error">原因：{run.error}</p>}
    {next && <p className="task-result-next">下一步：{next}</p>}
    {!steps.length && <p className="hint">這筆紀錄沒有保留步驟摘要或來源連結，不能從這裡確認產物內容。</p>}
    {steps.length > 0 && <ol className="task-result-steps">{steps.map((s, i) => {
      const links = safeTaskLinks(s.links);
      const delivery = deliveryEvidence(s.delivery_status) ?? s.delivery_summary;
      return <li key={`${s.step ?? i}:${s.tool ?? s.type}`}>
        <div className="task-result-step"><span className="muted">步驟 {(s.step ?? i) + 1} · {s.type === 'tool' ? (s.error_code === 'OUTCOME_UNKNOWN' || (run.status === 'outcome_unknown' && s.status === 'error') ? '結果不明' : STEP[s.status] ?? s.status) : '通知處理'}</span>{((s.type !== 'notify' && s.type !== 'briefing') || !delivery) && <p>{s.summary || '沒有保留摘要'}</p>}</div>
        {delivery && <p className="hint">通知證據：{delivery}</p>}
        {links.length > 0 && <div className="task-result-links"><span className="muted">來源連結（工具提供，非產物驗證）</span>{links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"><span>{new URL(link.url).host}</span><span className="task-result-url">{link.url}</span><span>開啟</span></a>)}</div>}
        {s.type === 'tool' && !links.length && <p className="hint">未提供可開啟的來源連結。</p>}
      </li>;
    })}</ol>}
  </section>;
}
