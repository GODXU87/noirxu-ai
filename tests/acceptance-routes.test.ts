import {beforeEach,expect,it,vi} from 'vitest';
import {MemoryAgendaStore} from '@/agenda/store';
import {vault} from './helpers/chat-hub';
const mocked=vi.hoisted(()=>({user:'owner' as string|null,hub:null as any}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/session',()=>({currentUser:async()=>mocked.user}));
vi.mock('@/server/hub',()=>({getHub:()=>mocked.hub}));
const acceptance=await import('@/app/api/acceptance/route');
const actions=await import('@/app/api/owner-actions/route');
const input={request_id:'12345678-1234-4234-8234-123456789012',project:'noirxu-ai',sha:'a'.repeat(40),title:'Synthetic check',criteria:'Verify exact flow after release',due_at:null};
const request=(body:unknown,origin='https://example.test')=>new Request('https://example.test/api/acceptance',{method:'POST',headers:{host:'example.test',origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{mocked.user='owner';mocked.hub={agenda:new MemoryAgendaStore(),vault,tasks:{list:vi.fn(async()=>[])},goals:{list:vi.fn(async()=>[])}};});
it('rejects unauthenticated and cross-origin reads/writes and malformed commands',async()=>{
 mocked.user=null;expect((await acceptance.GET(new Request('https://example.test/api/acceptance'))).status).toBe(401);expect((await actions.GET(new Request('https://example.test/api/owner-actions'))).status).toBe(401);
 mocked.user='owner';expect((await acceptance.POST(request({action:'create',input},'https://attacker.test'))).status).toBe(403);
 expect((await acceptance.POST(request({action:'check',id:'bad',revision:1}))).status).toBe(400);expect(mocked.hub.agenda.settings.size).toBe(0);
});
it('creates owner-scoped records but no provider calls or native task writes on create/list',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 try{expect((await acceptance.POST(request({action:'create',input}))).status).toBe(200);
  const read=await(await acceptance.GET(new Request('https://example.test/api/acceptance'))).json();expect(read.items).toHaveLength(1);expect(JSON.stringify(read)).not.toContain('request_id');
  mocked.user='other';expect((await(await acceptance.GET(new Request('https://example.test/api/acceptance'))).json()).items).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();}
});
it('aggregates read-only sources and labels partial failure rather than asserting nothing needs attention',async()=>{
 mocked.hub.goals.list.mockRejectedValue(Error('private DB error detail'));
 const before=mocked.hub.agenda.settings.size;const result=await(await actions.GET(new Request('https://example.test/api/owner-actions'))).json();
 expect(result.errors).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('private DB error detail');expect(mocked.hub.agenda.settings.size).toBe(before);
 expect(mocked.hub.tasks.list).toHaveBeenCalledWith('owner',{includeFinished:true});
});
