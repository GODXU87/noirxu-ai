import type { Task } from '@/tasks/model';
import type { Goal } from '@/goals/model';
import type { Acceptance } from './model';
export interface OwnerAction { id:string; title:string; state:'action'|'waiting'|'resolved'; priority:number; reason:string; next_step:string; due_at:string|null; href:string; source:'task'|'goal'|'acceptance' }
export interface ActionSources { tasks:Task[]; goals:Goal[]; acceptances:Acceptance[] }
const date = (at:Date) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
/** Derived state only: never writes, approves, sends a notification or fetches a provider. */
export function ownerActions(sources:ActionSources,now:Date):OwnerAction[] {
 const rows:OwnerAction[]=[];const today=date(now);
 for(const t of sources.tasks){
  const attention=!['completed','cancelled','paused'].includes(t.status);
  const codes=t.runs[0]?.steps.map(s=>s.error_code)??[];const connection=attention&&codes.some(c=>['NOT_CONNECTED','NOT_CONFIGURED','UNAUTHORIZED'].includes(c??''));
  const unknown=attention&&(t.status==='outcome_unknown'||t.runs[0]?.status==='outcome_unknown');const failed=attention&&(t.status==='failed'||t.runs[0]?.status==='failed');const approval=t.status==='waiting_approval';
  const resolved=['completed','cancelled'].includes(t.status);
  rows.push({id:`task:${t.id}`,title:t.title,source:'task',state:resolved?'resolved':unknown||failed||approval?'action':'waiting',priority:unknown?0:approval?1:failed?2:5,due_at:t.next_at,
   reason:unknown?'外部操作結果不明，不能自動重跑。':approval?'有待你明確確認的操作；通知不是批准。':connection?'任務因來源連線或授權問題未完成。':failed?'任務失敗；請先核對已完成的步驟。':resolved?'原任務已結束；不是由收件匣代為標示完成。':t.status==='paused'?'任務已暫停。':'等待原任務排程或執行結果，現在不需你批准。',
   next_step:unknown?'到原系統核對，再查看任務結果。':approval?'開啟任務的「查看待確認操作」；若已處理或逾期，依最新原始狀態處理。':connection?'檢查對應連線；修復不會自動重跑外部寫入。':resolved?'可在任務中心的「含已結束」查看歷史。':'開啟原任務查看最新狀態。',href:connection&&!unknown&&!approval?'/connections':`/tasks?task=${encodeURIComponent(t.id)}#task-${encodeURIComponent(t.id)}`});
 }
 for(const g of sources.goals){
  const resolved=['completed','cancelled'].includes(g.status);const paused=g.status==='paused';const due=date(new Date(g.deadline))<=today;
  const check=g.check_at&&Date.parse(g.check_at)<=+now;const action=!resolved&&!paused&&(g.status==='blocked'||due||check);
  rows.push({id:`goal:${g.id}`,title:g.title,source:'goal',state:resolved?'resolved':action?'action':'waiting',priority:g.status==='blocked'?2:Date.parse(g.deadline)<+now?2:3,due_at:g.deadline,
   reason:resolved?'目標已結束；完成仍是使用者回報。':paused?'目標追蹤已暫停。':g.status==='blocked'?`目標受阻：${g.blocker??'請查看原紀錄'}`:due?'目標期限在今天或已逾期（台灣時間）。':check?'已到這個目標的進度確認時間。':'尚未到目標的期限或確認時間。',next_step:g.next_step??'查看目標結果與依據。',href:`/tasks?goal=${encodeURIComponent(g.id)}#goal-${encodeURIComponent(g.id)}`});
 }
 for(const a of sources.acceptances){const resolved=['manual_pass','cancelled'].includes(a.status);rows.push({id:`acceptance:${a.id}`,title:a.title,source:'acceptance',state:resolved?'resolved':'action',priority:a.status==='manual_fail'?2:4,due_at:a.due_at,
  reason:a.status==='manual_pass'?'人工驗收已回報通過，不等於 provider 自動驗證。':a.status==='cancelled'?'驗收已取消。':a.status==='manual_fail'?'人工驗收未通過，需要修正或重新檢查。':'待你查看分階段證據並依條件驗收，CI 成功不等於功能通過。',next_step:resolved?'保留原證據與人工回報。':'查看 commit／部署／功能的各別證據，記錄實際結果。',href:`/tasks?acceptance=${encodeURIComponent(a.id)}#acceptance-${encodeURIComponent(a.id)}`});}
 return [...new Map(rows.map(r=>[r.id,r])).values()].sort((a,b)=>({action:0,waiting:1,resolved:2}[a.state]-{action:0,waiting:1,resolved:2}[b.state])||a.priority-b.priority||(a.due_at??'9999').localeCompare(b.due_at??'9999')||a.id.localeCompare(b.id));
}
