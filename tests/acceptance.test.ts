import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { vault } from './helpers/chat-hub';
import { AcceptanceService } from '@/acceptance/service';
import { readGitHubEvidence } from '@/acceptance/github';
const now=new Date('2026-10-31T00:00:00Z');const sha='a'.repeat(40);
const input={request_id:'12345678-1234-4234-8234-123456789012',project:'noirxu-ai' as const,sha,title:'Synthetic acceptance',criteria:'Check task result display and failed next step',due_at:'2026-11-01T00:00:00Z'};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const provider=()=>vi.fn(async()=>({checked_at:now.toISOString(),commit:{state:'verified' as const,reason:'exact commit'},ci:[],deployment:{state:'unsupported' as const,reason:'not connected'},runtime:{state:'unsupported' as const,reason:'not checked'}}));
function setup(){const store=new MemoryAgendaStore();const reader=provider();return {store,reader,service:new AcceptanceService({store,vault,reader})};}
describe('acceptance evidence',()=>{
 it('only fetches fixed GitHub paths and never promotes CI success to deployment or acceptance',async()=>{
  const fetcher=vi.fn(async(url:string,_init?:RequestInit)=>response(url.includes('/status?')?{sha,statuses:[{context:'Vercel',state:'success',target_url:'https://vercel.com/example/project/deploy'}]}:{sha}));
  const result=await readGitHubEvidence('noirxu-ai',sha,now,fetcher as typeof fetch);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls.every(([u])=>u.startsWith('https://api.github.com/repos/GODXU87/noirxu-ai/'))).toBe(true);
  expect(result.commit.state).toBe('verified');expect(result.ci[0].state).toBe('success');expect(result.deployment.state).toBe('unsupported');expect(result.runtime.state).toBe('unsupported');
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',credentials:'omit'});
 });
 it('rejects malicious project/SHA before fetching and stores no raw upstream secret',async()=>{
  const f=vi.fn(async()=>response({message:'secret upstream'},403));
  await expect(readGitHubEvidence('../evil' as any,sha,now,f as typeof fetch)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
  await expect(readGitHubEvidence('noirxu-ai','../head',now,f as typeof fetch)).rejects.toThrow();
  const result=await readGitHubEvidence('noirxu-ai',sha,now,f as typeof fetch);expect(result.commit.state).toBe('blocked');expect(JSON.stringify(result)).not.toContain('secret upstream');
 });
 it('mismatched sha and network errors never mean verified',async()=>{
  expect((await readGitHubEvidence('noirxu-ai',sha,now,vi.fn(async()=>response({sha:'b'.repeat(40)})) as typeof fetch)).commit.state).toBe('blocked');
  expect((await readGitHubEvidence('noirxu-ai',sha,now,vi.fn(async()=>{throw Error('network')}) as typeof fetch)).commit.state).toBe('unknown');
 });
 it('persists encrypted, deduplicates retries, isolates owners and never auto-completes',async()=>{
  const f=setup();const a=await f.service.create('owner',input,now);expect((await f.service.create('owner',input,now)).id).toBe(a.id);
  expect(await f.service.list('other')).toEqual([]);expect(JSON.stringify([...f.store.settings.values()])).not.toContain(input.title);
  const checked=await f.service.check('owner',a.id,a.revision,now);expect(checked.status).toBe('open');expect(checked.evidence?.commit.state).toBe('verified');
  expect((await new AcceptanceService({store:f.store,vault,reader:f.reader}).list('owner'))[0].evidence).toEqual(checked.evidence);
 });
 it('durably limits concurrent/restarted provider checks, without repeating external writes',async()=>{
  const f=setup();const a=await f.service.create('owner',input,now);
  await Promise.allSettled([f.service.check('owner',a.id,a.revision,now),new AcceptanceService({store:f.store,vault,reader:f.reader}).check('owner',a.id,a.revision,now)]);
  expect(f.reader).toHaveBeenCalledTimes(1);
  const latest=(await f.service.list('owner'))[0];await f.service.check('owner',a.id,latest.revision,new Date(+now+1000));expect(f.reader).toHaveBeenCalledTimes(1);
 });
 it('manual acceptance needs concrete report, stays attributed and rejects stale revision',async()=>{
  const f=setup();const a=await f.service.create('owner',input,now);
  await expect(f.service.report('owner',a.id,a.revision,{decision:'pass',observation:''},now)).rejects.toThrow();
  const done=await f.service.report('owner',a.id,a.revision,{decision:'pass',observation:'Checked the synthetic flow on mobile; labels are readable.'},now);
  expect(done.status).toBe('manual_pass');expect(done.reports[0].source).toBe('user_report');expect(done.evidence).toBeUndefined();
  await expect(f.service.report('owner',a.id,a.revision,{decision:'fail',observation:'Older report must not overwrite a newer one'},now)).rejects.toThrow();
 });
 it('a late check cannot overwrite cancellation or manual report',async()=>{
  const f=setup();let finish!:(v:any)=>void;f.reader.mockImplementation(()=>new Promise(r=>{finish=r}));const a=await f.service.create('owner',input,now);
  const pending=f.service.check('owner',a.id,a.revision,now);await vi.waitFor(()=>expect(f.reader).toHaveBeenCalledTimes(1));
  const running=(await f.service.list('owner'))[0];await f.service.report('owner',a.id,running.revision,{decision:'cancel',observation:'Cancelled this synthetic verification request'},now);finish(await provider()());await pending;
  expect((await f.service.list('owner'))[0].status).toBe('cancelled');
 });
});
it('bounds provider body size and does not follow status links or persist credentials',async()=>{
 const tooBig=vi.fn(async()=>new Response('x'.repeat(256001)));
 expect((await readGitHubEvidence('noirxu-ai',sha,now,tooBig as typeof fetch)).commit.state).toBe('unknown');
 const fetcher=vi.fn(async(url:string)=>response(url.includes('/status?')?{sha,statuses:[{context:'Synthetic',state:'success',target_url:'http://127.0.0.1/private'},{context:'Synthetic',state:'success',target_url:'https://vercel.com/example?token=secret'}]}:{sha}));
 const evidence=await readGitHubEvidence('noirxu-ai',sha,now,fetcher as typeof fetch);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(evidence.ci.every(c=>!c.url)).toBe(true);expect(JSON.stringify(evidence)).not.toContain('secret');
});
it('recovers a crashed check after durable cooldown without claiming the old incomplete run succeeded',async()=>{
 const f=setup();f.reader.mockImplementationOnce(()=>new Promise(()=>{}));const a=await f.service.create('owner',input,now);void f.service.check('owner',a.id,a.revision,now);
 await vi.waitFor(()=>expect(f.reader).toHaveBeenCalledTimes(1));const current=(await f.service.list('owner'))[0];expect(current.evidence).toBeUndefined();
 const recovered=await new AcceptanceService({store:f.store,vault,reader:provider()}).check('owner',a.id,current.revision,new Date(+now+61000));expect(recovered.status).toBe('open');expect(recovered.check_until).toBeUndefined();
});
it('retains bounded historical checks and ties manual reports to the observed evidence revision',async()=>{
 const f=setup();const a=await f.service.create('owner',input,now);const first=await f.service.check('owner',a.id,a.revision,now);
 const report=await f.service.report('owner',a.id,first.revision,{decision:'pass',observation:'Synthetic manual review of the first evidence snapshot'},now);
 expect(report.reports[0].evidence_revision).toBe(first.revision);
 const next=await f.service.check('owner',a.id,report.revision,new Date(+now+61000));expect(next.checks).toHaveLength(2);expect(next.checks[1].revision).toBe(first.revision);expect(next.reports[0].evidence_revision).toBe(first.revision);
});
