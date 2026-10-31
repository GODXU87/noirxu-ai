import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { MemoryHubStore } from '@/hub/store';
import { TaskService } from '@/tasks/service';
import { vault } from './helpers/chat-hub';
const now = new Date('2026-10-31T00:00:00Z');
function fixture(result: any) {
  const proposals = new MemoryHubStore();
  const invoke = vi.fn(async () => result);
  const tasks = new TaskService({ store: new MemoryAgendaStore(), vault, executor: { invoke }, proposals, notify: vi.fn(async () => ({status:'provider_accepted'})), briefing: vi.fn() });
  const create = () => tasks.create({userId:'owner',title:'Synthetic result',kind:'background',schedule:{type:'once',at:now.toISOString()},steps:[{type:'tool',tool:'sample.get',input:{}}],now});
  return {tasks,proposals,invoke,create};
}
describe('task result evidence', () => {
  it('persists only bounded safe deduplicated source links with the real read summary', async () => {
    const f=fixture({status:'ok',tool:'sample.get',data:{items:[1,2],secret:'not retained'},links:[{label:'來源',url:'https://example.com/result'},{label:'來源',url:'https://example.com/result'},{label:'bad',url:'javascript:alert(1)'},{label:'credential',url:'https://user:pass@example.com'}]});
    const t=await f.create();await f.tasks.runDue(now);const saved=await f.tasks.get(t.id);
    expect(saved?.runs[0].steps[0]).toMatchObject({summary:'2 筆事項',links:[{label:'來源',url:'https://example.com/result'}]});
    expect(JSON.stringify(saved)).not.toContain('not retained');
  });
  it('keeps machine-readable failure reason without replaying a write', async () => {
    const f=fixture({status:'error',tool:'sample.get',code:'NOT_CONNECTED',message:'請連接來源'});const t=await f.create();await f.tasks.runDue(now);
    expect((await f.tasks.get(t.id))?.runs[0].steps[0]).toMatchObject({error_code:'NOT_CONNECTED',summary:'請連接來源'});
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});

it.each(['succeeded','outcome_unknown','failed'] as const)('retains confirmed proposal evidence for %s without invoking again', async status => {
  const f=fixture({status:'confirmation_required',tool:'sample.create',proposalId:'p1',preview:{title:'Synthetic proposal',fields:[]},expiresAt:'2026-11-01T00:00:00Z'});
  const t=await f.create();await f.tasks.runDue(now);
  vi.spyOn(f.proposals,'getProposal').mockResolvedValue({id:'p1',userId:'owner',tool:'sample.create',input:{},preview:{title:'Synthetic',fields:[]},idempotencyKey:'p1',status,createdAt:now.toISOString(),expiresAt:'2026-11-01T00:00:00Z',result:{title:'實際結果'},links:[{label:'原系統',url:'https://example.com/record'}],...(status!=='succeeded'?{error:{code:'OUTCOME_UNKNOWN' as const,message:'結果需核對'}}:{})});
  await f.tasks.runDue(new Date(+now+60000));await f.tasks.runDue(new Date(+now+120000));
  const s=(await f.tasks.get(t.id))!.runs[0].steps[0];
  expect(s.links).toEqual([{label:'原系統',url:'https://example.com/record'}]);
  expect(s.summary).toBe(status==='succeeded'?'實際結果':'結果需核對');
  if(status!=='succeeded')expect(s.error_code).toBe('OUTCOME_UNKNOWN');
  expect(f.invoke).toHaveBeenCalledTimes(1);
});
it('marks an expired approval step without invoking its operation again',async()=>{
 const f=fixture({status:'confirmation_required',tool:'sample.create',proposalId:'expired',preview:{title:'Synthetic',fields:[]},expiresAt:'2026-11-01T00:00:00Z'});const t=await f.create();await f.tasks.runDue(now);
 vi.spyOn(f.proposals,'getProposal').mockResolvedValue({id:'expired',userId:'owner',tool:'sample.create',input:{},preview:{title:'Synthetic',fields:[]},idempotencyKey:'expired',status:'pending',createdAt:now.toISOString(),expiresAt:now.toISOString()});
 await f.tasks.runDue(new Date(+now+60000));
 expect((await f.tasks.get(t.id))?.runs[0].steps[0]).toMatchObject({status:'error',error_code:'PROPOSAL_EXPIRED'});expect(f.invoke).toHaveBeenCalledTimes(1);
});
