// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AcceptancePanel,OwnerActionsPanel} from '@/app/components/Acceptance';
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const a={id:'a1',project:'noirxu-ai',sha:'a'.repeat(40),title:'Synthetic acceptance',criteria:'Verify mobile task results',status:'open',revision:1,due_at:null,reports:[],created_at:'2026-10-31T00:00:00Z',updated_at:'2026-10-31T00:00:00Z'};
const response=(data:unknown)=>({ok:true,json:async()=>data}) as Response;
const render=(component:any)=>act(async()=>root.render(createElement(component)));
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;
it('loads retained evidence only, labels unsupported stages, and checks only on explicit action',async()=>{
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>response(init?.method==='POST'?{ok:true,item:{...a,revision:3}}:{ok:true,items:[a]}));vi.stubGlobal('fetch',fetcher);
 await render(AcceptancePanel);expect(fetcher.mock.calls.every(([,i])=>!i?.method||i.method==='GET')).toBe(true);
 expect(host.textContent).toContain('不是正式部署');expect(host.textContent).toContain('人工');
 await act(async()=>button('GitHub 唯讀查核').click());expect(fetcher.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
 expect(host.textContent).not.toContain('自動驗收完成');
});
it('does not mutate when closing manual report and does not expose an approve shortcut',async()=>{
 const fetcher=vi.fn(async()=>response({ok:true,items:[a]}));vi.stubGlobal('fetch',fetcher);await render(AcceptancePanel);
 await act(async()=>button('記錄人工驗收').click());expect(host.querySelector('textarea[aria-label="實際觀察"]')).not.toBeNull();
 await act(async()=>button('取消編輯').click());expect(host.querySelector('textarea[aria-label="實際觀察"]')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
 expect([...host.querySelectorAll('button')].some(b=>b.textContent==='確認執行')).toBe(false);
});
it('owner actions distinguish waiting/resolved and show source failure instead of empty success',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>response({ok:true,items:[{id:'task:t1',title:'Approval',state:'action',reason:'Await approval',next_step:'Review',href:'/tasks#task-t1',source:'task',due_at:null},{id:'goal:g1',title:'Future',state:'waiting',reason:'Later',next_step:'Wait',href:'/tasks?goal=g1',source:'goal',due_at:null}],errors:['目標暫時讀不到；不是沒有待辦。'],as_of:'2026-10-31T00:00:00Z'})));
 await render(OwnerActionsPanel);expect(host.textContent).toContain('目標暫時讀不到');expect(host.querySelector('a')?.getAttribute('href')).toBe('/tasks#task-t1');
 await act(async()=>button('等待中').click());expect(host.textContent).toContain('Future');expect(host.textContent).not.toContain('Approval');
});
it('freezes an uncertain create and retries the identical request after close/reopen',async()=>{
 const posts:string[]=[];const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){posts.push(String(init.body));if(posts.length===1)throw Error('offline after save');return response({ok:true,item:a});}return response({ok:true,items:[]});});vi.stubGlobal('fetch',fetcher);await render(AcceptancePanel);
 await act(async()=>button('新增驗收').click());
 async function fill(label:string,value:string){await act(async()=>{const el=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
 await fill('要驗收的工作','Synthetic create');await fill('完整 commit SHA','b'.repeat(40));await fill('具體驗收條件','Check the mobile result evidence is readable');
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(posts).toHaveLength(1);expect(host.textContent).toContain('草稿已鎖定');expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
 await act(async()=>button('取消新增').click());await act(async()=>button('新增驗收').click());
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(posts).toHaveLength(2);expect(posts[0]).toBe(posts[1]);expect(host.querySelector('form')).toBeNull();
});
it('focuses a requested acceptance only after its async source is loaded',async()=>{
 let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=r})));
 await act(async()=>root.render(createElement(AcceptancePanel,{initialId:'a1'})));expect(host.querySelector('#acceptance-a1')).toBeNull();
 await act(async()=>resolve(response({ok:true,items:[a]})));expect(document.activeElement?.id).toBe('acceptance-a1');
});
