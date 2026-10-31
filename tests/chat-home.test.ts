// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {TodayGlance,useToday,homeNotifications} from '@/app/components/TodayGlance';
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);sessionStorage.clear();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('filters hydration home notices before selecting two, preserving the original inbox',()=>{
 const inbox=[{key:'w',kind:'water',title:'Synthetic hydration'},{key:'legacy',title:'喝水提醒'},{key:'t',kind:'task',title:'Synthetic task'},{key:'t2',kind:'task',title:'Synthetic task 2'}];
 expect(homeNotifications(inbox).map(x=>x.key)).toEqual(['t','t2']);expect(inbox).toHaveLength(4);
});
it('keeps weather provenance and body gaps but never renders legacy hydration data',async()=>{
 await act(async()=>root.render(createElement(TodayGlance,{data:{weather:{weather:{temp_min:18,temp_max:24,rain_chance:null,summary:'Synthetic forecast',source:'Open-Meteo',place:'Synthetic place',date:'2026-10-31',stale:true}},body:{line:'',headline:'資料尚未齊全',date:'2026-10-31',gaps:['活動摘要']},water:{water:{total_ml:1000,goal_ml:2000}},agenda:{today:0,overdue:0,next:[]}},loading:new Set<'agenda'|'weather'|'body'>(),ask:vi.fn()})));
 expect(host.textContent).not.toContain('喝水');expect(host.textContent).toContain('Synthetic place');expect(host.textContent).toContain('Open-Meteo');expect(host.textContent).toContain('活動摘要');expect(host.textContent).toContain('資料尚未齊全');expect(host.textContent).toContain('今日到期');expect(host.textContent).toContain('舊預報');
});
it('does not reuse browser cached health data or silently convert failed reads to fresh data',async()=>{
 sessionStorage.setItem('sasuke:today:v1',JSON.stringify({at:Date.now(),data:{body:{ok:true,line:'OLD SYNTHETIC PRIVATE CACHE'}}}));
 const fetcher=vi.fn(async(_url:string)=>({ok:false,json:async()=>({ok:false,error:{message:'Synthetic unavailable'}})}));vi.stubGlobal('fetch',fetcher);
 function View(){const t=useToday(true);return createElement(TodayGlance,{...t,ask:vi.fn()});}
 await act(async()=>root.render(createElement(View)));
 expect(fetcher).toHaveBeenCalledTimes(3);expect(fetcher.mock.calls.every(c=>!String(c[0]).includes('water'))).toBe(true);
 expect(host.textContent).not.toContain('OLD SYNTHETIC');expect(host.textContent).toContain('Synthetic unavailable');
});
it('refresh failures replace earlier data with explicit failure and no new success timestamp',async()=>{
 let fail=false;vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:!fail,json:async()=>fail?{ok:false,error:{message:'Synthetic refresh failure'}}:{ok:true,part:url.split('=')[1],headline:'Synthetic first reading',date:'2026-10-31',today:1}})));
 function View(){const t=useToday(true);return createElement(TodayGlance,{...t,ask:vi.fn()});}
 await act(async()=>root.render(createElement(View)));
 expect(host.textContent).toContain('Synthetic first reading');
 fail=true;await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='重新讀取')!.click());
 expect(host.textContent).not.toContain('Synthetic first reading');expect(host.textContent).toContain('Synthetic refresh failure');expect(host.textContent).not.toContain('讀取 10/');
});
it('does not let late responses from an older refresh replace a newer source reading',async()=>{
 const pending:Array<{url:string;done:(r:any)=>void}>=[];vi.stubGlobal('fetch',vi.fn((url:string)=>new Promise(resolve=>pending.push({url,done:resolve}))));
 let refresh:()=>void=()=>{};function View(){const t=useToday(true);refresh=t.refresh;return createElement(TodayGlance,{...t,ask:vi.fn()});}
 await act(async()=>root.render(createElement(View)));await act(async()=>refresh());
 const response=(headline:string)=>({ok:true,json:async()=>({ok:true,headline,date:'2026-10-31',today:0})});
 await act(async()=>pending.slice(3).forEach(p=>p.done(response('NEW synthetic reading'))));
 await act(async()=>pending.slice(0,3).forEach(p=>p.done(response('OLD synthetic reading'))));
 expect(host.textContent).toContain('NEW synthetic reading');expect(host.textContent).not.toContain('OLD synthetic reading');
});
it('reports source timeout instead of an empty success',async()=>{
 vi.useFakeTimers();try{
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(Error('aborted'))))));
 function View(){const t=useToday(true);return createElement(TodayGlance,{...t,ask:vi.fn()});}
 await act(async()=>root.render(createElement(View)));await act(async()=>vi.advanceTimersByTimeAsync(15000));
 expect(host.textContent).toContain('讀取逾時');expect([...host.querySelectorAll('button')].find(b=>b.textContent==='重新讀取')?.disabled).toBe(false);
 }finally{vi.useRealTimers();}
});
