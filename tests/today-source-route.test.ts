import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('@/server/session',()=>({currentUser:async()=> 'synthetic-owner'}));
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@/server/hub',()=>({getHub:()=>({garmin:{},executor:{invoke:mocks.invoke}})}));
const {GET}=await import('@/app/api/today/route');
it('preserves body source date and gaps in the public-facing owner response',async()=>{
 mocks.invoke.mockResolvedValue({status:'ok',data:{date:'2026-10-31',headline:'Synthetic unknown',push_line:'',gaps:['Synthetic missing activity'],signals:[],narrative:[]}});
 const result=await GET(new Request('http://localhost/api/today?part=body'));
 expect(await result.json()).toMatchObject({ok:true,date:'2026-10-31',gaps:['Synthetic missing activity'],line:''});
 expect(mocks.invoke.mock.calls[0][1]).toMatchObject({hydration:false});
});
