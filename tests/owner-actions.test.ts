import {expect,it} from 'vitest';
import {ownerActions} from '@/acceptance/actions';
const now=new Date('2026-10-31T16:30:00Z'); // Taiwan Nov1,00:30
const task=(status:string,extra={})=>({id:'t1',title:'Synthetic task',status,updated_at:now.toISOString(),next_at:null,runs:[],...extra}) as any;
const goal=(status:string,extra={})=>({id:'g1',title:'Synthetic goal',status,deadline:'2026-11-01T15:59:00Z',check_at:null,next_step:'Review result',...extra}) as any;
it('deduplicates source IDs, prioritizes unknown outcomes over native approvals and routes without executing',()=>{
 const items=ownerActions({tasks:[task('waiting_approval'),task('waiting_approval'),task('outcome_unknown',{id:'t2'})],goals:[],acceptances:[]},now);
 expect(items).toHaveLength(2);expect(items[0].id).toBe('task:t2');expect(items[1].href).toBe('/tasks?task=t1#task-t1');expect(items[1].reason).toContain('確認');
});
it('separates Taiwan today deadlines from future waiting and preserves resolved native state',()=>{
 const items=ownerActions({tasks:[task('completed')],goals:[goal('active'),goal('active',{id:'g2',deadline:'2026-11-02T01:00:00Z'}),goal('completed',{id:'g3'})],acceptances:[]},now);
 expect(items.find(i=>i.id==='goal:g1')?.state).toBe('action');expect(items.find(i=>i.id==='goal:g2')?.state).toBe('waiting');
 expect(items.find(i=>i.id==='goal:g3')?.state).toBe('resolved');expect(items.find(i=>i.id==='task:t1')?.state).toBe('resolved');
});
it('connection failures link to native settings, no nag for unrelated disconnected integrations',()=>{
 const a=ownerActions({tasks:[task('failed',{runs:[{steps:[{error_code:'NOT_CONNECTED'}]}]})],goals:[],acceptances:[]},now);
 expect(a).toHaveLength(1);expect(a[0].href).toBe('/connections');expect(a[0].reason).toContain('連線');
});
it('manual acceptance resolves only its review item, not a waiting tool approval',()=>{
 const items=ownerActions({tasks:[task('waiting_approval')],goals:[],acceptances:[{id:'a1',title:'Synthetic acceptance',status:'manual_pass',due_at:null} as any]},now);
 expect(items.find(i=>i.id==='acceptance:a1')?.state).toBe('resolved');expect(items.find(i=>i.id==='task:t1')?.state).toBe('action');
});
it('surfaces unresolved failures and unknown outcomes from the latest recurring run',()=>{
 const items=ownerActions({tasks:[task('queued',{id:'unknown',runs:[{status:'outcome_unknown',steps:[]}]}),task('queued',{id:'connection',runs:[{status:'failed',steps:[{error_code:'NOT_CONNECTED'}]}]}),task('cancelled',{id:'cancelled',runs:[{status:'outcome_unknown',steps:[]}]})],goals:[],acceptances:[]},now);
 expect(items.find(i=>i.id==='task:unknown')?.state).toBe('action');expect(items.find(i=>i.id==='task:unknown')?.priority).toBe(0);expect(items.find(i=>i.id==='task:connection')?.href).toBe('/connections');expect(items.find(i=>i.id==='task:cancelled')?.state).toBe('resolved');
});
