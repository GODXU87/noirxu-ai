import { getHub } from '@/server/hub';
import { errorResponse,json,requireContext } from '@/server/http';
import { AcceptanceService } from '@/acceptance/service';
import { ownerActions } from '@/acceptance/actions';
export const runtime='nodejs';
export async function GET(request:Request){try{
 const ctx=await requireContext(request,{mutating:false});const h=getHub();
 const results=await Promise.allSettled([h.tasks?.list(ctx.userId,{includeFinished:true})??Promise.resolve([]),h.goals?.list(ctx.userId,true)??Promise.resolve([]),new AcceptanceService({store:h.agenda,vault:h.vault}).list(ctx.userId)]);
 const errors=results.flatMap((r,i)=>r.status==='rejected'?[`${['自動任務','目標','驗收'][i]}暫時讀不到；不是沒有待辦。請重新整理。`]:[]);
 if(!h.tasks||!h.goals)errors.push('部分任務功能未啟用；清單不包含未啟用的來源。');
 const tasks=results[0].status==='fulfilled'?results[0].value:[];const goals=results[1].status==='fulfilled'?results[1].value:[];const acceptances=results[2].status==='fulfilled'?results[2].value:[];
 const items=ownerActions({tasks,goals,acceptances},ctx.now());return json({ok:true,items:items.slice(0,200),total:items.length,truncated:items.length>200,errors,as_of:ctx.now().toISOString()});
}catch(e){return errorResponse(e);}}
