import { randomUUID } from 'node:crypto';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';
import { acceptanceCreate, acceptanceReport, type Acceptance, type Evidence, type Project } from './model';
import { readGitHubEvidence } from './github';
interface Document { records: Acceptance[]; next_check_at?: string }
interface Deps { store: AgendaStore; vault: TokenVault; reader?: (project: Project, sha: string, now: Date) => Promise<Evidence> }
const key = (userId: string) => `acceptance:${userId}`;
export class AcceptanceService {
 constructor(private readonly deps: Deps) {}
 private async read(userId: string) { const sealed = await this.deps.store.getSetting(key(userId)); return { sealed, doc: sealed ? JSON.parse(this.deps.vault.open(sealed,key(userId))) as Document : { records: [] } as Document }; }
 private async change<T>(userId: string, fn: (doc: Document) => T) {
  for(let n=0;n<8;n++) { const {sealed,doc}=await this.read(userId); const before=JSON.stringify(doc);const value=fn(doc);
   if(JSON.stringify(doc)===before || await this.deps.store.compareAndSetSetting(key(userId),sealed,this.deps.vault.seal(JSON.stringify(doc),key(userId)))) return value;
  } throw new ToolError('CONFLICT','驗收紀錄正在更新，請重新讀取。');
 }
 private find(doc:Document,id:string,revision?:number) {const a=doc.records.find(a=>a.id===id);if(!a)throw new ToolError('NOT_FOUND','找不到驗收紀錄。');if(revision!==undefined&&a.revision!==revision)throw new ToolError('CONFLICT','驗收紀錄版本已更新，請重新讀取，勿覆蓋較新的結果。');return a;}
 async list(userId:string) {return (await this.read(userId)).doc.records;}
 async create(userId:string,raw:unknown,now:Date) {
  const i=acceptanceCreate.parse(raw);return this.change(userId,doc=>{
   const existing=doc.records.find(a=>a.request_id===i.request_id);
   if(existing){if(existing.project!==i.project||existing.sha!==i.sha||existing.title!==i.title||existing.criteria!==i.criteria||existing.due_at!==i.due_at)throw new ToolError('CONFLICT','此建立請求已使用；請重新讀取。');return existing;}
   if(doc.records.length>=50)throw new ToolError('INVALID_INPUT','驗收紀錄已達 50 筆上限；本次未建立。');
   const a:Acceptance={...i,id:randomUUID(),revision:1,created_at:now.toISOString(),updated_at:now.toISOString(),status:'open',reports:[],checks:[]};doc.records.unshift(a);return a;
  });
 }
 async report(userId:string,id:string,revision:number,raw:unknown,now:Date) {
  const p=acceptanceReport.parse(raw);return this.change(userId,doc=>{const a=this.find(doc,id,revision);
   a.status=({pass:'manual_pass',fail:'manual_fail',cancel:'cancelled',reopen:'open'} as const)[p.decision];
   a.reports=[{...p,source:'user_report' as const,at:now.toISOString(),evidence_revision:a.checks?.[0]?.revision},...a.reports].slice(0,10);a.revision++;a.updated_at=now.toISOString();delete a.check_claim;delete a.check_until;return a;
  });
 }
 async check(userId:string,id:string,revision:number,now:Date) {
  const claim=randomUUID();const reserved=await this.change(userId,doc=>{const a=this.find(doc,id,revision);
   if(a.status==='cancelled')throw new ToolError('INVALID_INPUT','驗收已取消；如需查核請明確重新開啟。');
   if(doc.next_check_at&&Date.parse(doc.next_check_at)>+now){if(a.evidence)return {record:a,cached:true};throw new ToolError('CONFLICT','剛查詢過或正在查詢；每位使用者每分鐘最多一次，請稍後重新整理。');}
   doc.next_check_at=new Date(+now+60000).toISOString();a.check_claim=claim;a.check_until=new Date(+now+30000).toISOString();a.revision++;a.updated_at=now.toISOString();return {record:a,cached:false};
  });if(reserved.cached)return reserved.record;
  let evidence:Evidence;
  try { evidence=await (this.deps.reader??readGitHubEvidence)(reserved.record.project,reserved.record.sha,now); }
  catch { evidence={checked_at:now.toISOString(),commit:{state:'unknown',reason:'查核未完成；請重新整理後再查。'},ci:[],deployment:{state:'unsupported',reason:'部署未驗證。'},runtime:{state:'unsupported',reason:'功能未驗證。'}}; }
  return this.change(userId,doc=>{const a=this.find(doc,id);if(a.check_claim!==claim)return a;a.evidence=evidence;delete a.check_claim;delete a.check_until;a.revision++;a.checks=[{revision:a.revision,evidence},...(a.checks??[])].slice(0,10);a.updated_at=now.toISOString();return a;});
 }
}
