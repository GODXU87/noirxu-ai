import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { getHub } from '@/server/hub';
import { errorResponse,json,requireContext } from '@/server/http';
import { AcceptanceService } from '@/acceptance/service';
import { acceptanceCreate,acceptanceReport,acceptanceView } from '@/acceptance/model';
export const runtime='nodejs';
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),input:acceptanceCreate}).strict(),
 z.object({action:z.literal('check'),id:z.uuid(),revision:z.number().int().positive()}).strict(),
 z.object({action:z.literal('report'),id:z.uuid(),revision:z.number().int().positive(),input:acceptanceReport}).strict(),
]);
export async function GET(request:Request){try{const ctx=await requireContext(request,{mutating:false});const h=getHub();return json({ok:true,items:(await new AcceptanceService({store:h.agenda,vault:h.vault}).list(ctx.userId)).map(acceptanceView)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{const ctx=await requireContext(request,{mutating:true});const parsed=command.safeParse(await request.json().catch(()=>null));if(!parsed.success)throw new ToolError('INVALID_INPUT','請檢查驗收條件、完整 SHA、日期與回報內容。');const c=parsed.data;const h=getHub();const service=new AcceptanceService({store:h.agenda,vault:h.vault});
 const item=c.action==='create'?await service.create(ctx.userId,c.input,ctx.now()):c.action==='check'?await service.check(ctx.userId,c.id,c.revision,ctx.now()):await service.report(ctx.userId,c.id,c.revision,c.input,ctx.now());return json({ok:true,item:acceptanceView(item)});
}catch(e){return errorResponse(e);}}
