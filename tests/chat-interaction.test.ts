// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
import {Chat} from '@/app/Chat';
import {loadFeatureFlags} from '@/lib/features';
let root:Root,host:HTMLDivElement;
const posts:Array<{url:string;init:RequestInit;resolve:(r:Response)=>void;reject:(e:Error)=>void}>=[];
const reads:string[]=[];
beforeEach(()=>{localStorage.clear();sessionStorage.clear();posts.length=0;reads.length=0;Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));Element.prototype.scrollIntoView=vi.fn();vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{if(init?.method==='POST')return new Promise((resolve,reject)=>posts.push({url,init,resolve,reject}));reads.push(url);return Promise.resolve(new Response(JSON.stringify({ok:true,items:[],today:0,headline:'Synthetic body',date:'2026-10-31',gaps:[]})));}));host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function mount(){await act(async()=>root.render(createElement(Chat,{connected:{},variant:'sasuke',features:{...loadFeatureFlags(),voice:false},ai:null})));}
async function fill(value:string){await act(async()=>{const el=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
function submit(){host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
it('keeps composer primary, context collapsed and no initial glance/inbox requests',async()=>{
 await mount();const detail=host.querySelector('details')!;expect(detail).not.toBeNull();expect(detail.open).toBe(false);expect(host.querySelector('form')!.compareDocumentPosition(detail)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(host.querySelector('.sk-notices,.sk-quick')).toBeNull();expect(reads).toEqual([]);
 await act(async()=>{detail.open=true;detail.dispatchEvent(new Event('toggle'));});expect(reads.sort()).toEqual(['/api/today?part=body','/api/today?part=weather']);
});
it('accepts one request for repeated same-tick submits and shows pending',async()=>{await mount();await fill('Synthetic hello');await act(async()=>{submit();submit();});expect(posts).toHaveLength(1);expect(host.textContent).toContain('正在處理');expect(host.querySelector<HTMLButtonElement>('button[aria-label="送出"]')!.disabled).toBe(true);});
it('preserves failed text and restores it without executing an unknown outcome again',async()=>{await mount();await fill('Synthetic request');await act(async()=>submit());await act(async()=>posts[0].reject(Error('Synthetic disconnect')));expect(host.querySelector('textarea')!.value).toBe('Synthetic request');expect(host.textContent).toContain('無法確認');expect(host.textContent).not.toContain('沒有送出');const restore=[...host.querySelectorAll('button')].find(b=>b.textContent==='放回輸入框')!;expect(restore).toBeTruthy();await act(async()=>restore.click());expect(posts).toHaveLength(1);});
it('does not overwrite a newer draft when an earlier request fails',async()=>{await mount();await fill('Synthetic first');await act(async()=>submit());await fill('Synthetic newer unsent');await act(async()=>posts[0].reject(Error('Synthetic disconnect')));expect(host.querySelector('textarea')!.value).toBe('Synthetic newer unsent');});
it('Escape dismisses the command menu without deleting the draft',async()=>{await mount();await fill('/早');expect(host.querySelector('[role="listbox"]')).not.toBeNull();await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(host.querySelector('textarea')!.value).toBe('/早');expect(host.querySelector('[role="listbox"]')).toBeNull();});
it('restores an unsent tab draft after remount without sending it',async()=>{await mount();await fill('Synthetic unsent navigation draft');await act(async()=>root.unmount());root=createRoot(host);await mount();expect(host.querySelector('textarea')!.value).toBe('Synthetic unsent navigation draft');expect(posts).toHaveLength(0);});
it('command transport failure is unknown, retains draft and never auto-retries',async()=>{await mount();await fill('/早報');await act(async()=>submit());expect(posts[0].url).toBe('/api/command');await act(async()=>posts[0].reject(Error('Synthetic command disconnect')));expect(host.textContent).toContain('無法確認指令結果');expect(host.querySelector('textarea')!.value).toBe('/早報');expect(posts).toHaveLength(1);});
it('retains an in-flight draft across navigation with an uncertain outcome warning',async()=>{await mount();await fill('Synthetic pending navigation');await act(async()=>submit());await act(async()=>root.unmount());root=createRoot(host);await mount();expect(host.querySelector('textarea')!.value).toBe('Synthetic pending navigation');expect(host.textContent).toContain('上次處理結果尚未確認');expect(posts).toHaveLength(1);});
it('keeps text editable and warns when tab draft storage throws',async()=>{
 await mount();const original=Storage.prototype.setItem;const fail=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key:string,value:string){if(this===sessionStorage&&key.startsWith('noirxu-ai-draft'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);});
 try{await fill('Synthetic draft despite quota');expect(host.querySelector('textarea')!.value).toBe('Synthetic draft despite quota');expect(host.textContent).toContain('草稿目前無法保存在此分頁');expect(posts).toHaveLength(0);}finally{fail.mockRestore();}
});
it('success clears the pending draft marker and does not restore a sent message after navigation',async()=>{
 await mount();await fill('Synthetic completed request');await act(async()=>submit());await act(async()=>posts[0].resolve(new Response(JSON.stringify({ok:true,messages:[],events:[],reply:'Synthetic complete'}),{headers:{'content-type':'application/json'}})));expect(host.querySelector('textarea')!.value).toBe('');expect(host.textContent).not.toContain('上次處理結果尚未確認');await act(async()=>root.unmount());root=createRoot(host);await mount();expect(host.querySelector('textarea')!.value).toBe('');expect(host.textContent).not.toContain('上次處理結果尚未確認');expect(posts).toHaveLength(1);
});
