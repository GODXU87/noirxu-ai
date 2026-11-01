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
it('reports uncertain rating delivery instead of silently resetting on connection loss',async()=>{
 await mount();await fill('Synthetic question');await act(async()=>submit());await act(async()=>posts[0].resolve(new Response(JSON.stringify({ok:true,messages:[],events:[],reply:'Synthetic answer'}))));
 const up=host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!;
 await act(async()=>up.click());expect(posts[1].url).toBe('/api/quality');
 expect(up.getAttribute('aria-pressed')).toBe('false');expect(host.textContent).toContain('回饋傳送中');
 await act(async()=>posts[1].reject(Error('Synthetic disconnect')));
 expect(host.textContent).toContain('無法確認回饋是否收到');expect(posts).toHaveLength(2);
});
it('locks repeated same-tick rating clicks to one request',async()=>{
 await mount();await fill('Synthetic question');await act(async()=>submit());await act(async()=>posts[0].resolve(new Response(JSON.stringify({ok:true,messages:[],events:[],reply:'Synthetic answer'}))));
 const up=host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!;
 await act(async()=>{up.click();up.click();});expect(posts.filter(p=>p.url==='/api/quality')).toHaveLength(1);
});
async function ratedReply(){await mount();await fill('Synthetic question');await act(async()=>submit());await act(async()=>posts[0].resolve(new Response(JSON.stringify({ok:true,messages:[],events:[],reply:'Synthetic answer'}))));return host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!;}
it('marks a rating confirmed only after server ok and keeps a newer draft',async()=>{const up=await ratedReply();await fill('Unsent newer draft');await act(async()=>up.click());await act(async()=>posts[1].resolve(new Response(JSON.stringify({ok:true}))));expect(up.getAttribute('aria-pressed')).toBe('true');expect(host.textContent).toContain('回饋已收到');expect(host.querySelector('textarea')!.value).toBe('Unsent newer draft');});
it('distinguishes a rejected HTTP request and allows only an explicit retry',async()=>{const up=await ratedReply();await act(async()=>up.click());await act(async()=>posts[1].resolve(new Response(JSON.stringify({ok:false}),{status:429})));expect(host.textContent).toContain('伺服器拒絕回饋');expect(up.disabled).toBe(false);expect(posts).toHaveLength(2);await act(async()=>up.click());expect(posts).toHaveLength(3);});
it('treats a server error or malformed success as unknown and never silently retries',async()=>{const up=await ratedReply();await act(async()=>up.click());await act(async()=>posts[1].resolve(new Response('not-json',{status:500})));expect(host.textContent).toContain('無法確認回饋是否收到');expect(up.disabled).toBe(true);expect(up.getAttribute('aria-pressed')).toBe('false');expect(posts).toHaveLength(2);});
it('restores interrupted rating as unknown after remount without sending again',async()=>{const up=await ratedReply();await act(async()=>up.click());await act(async()=>root.unmount());root=createRoot(host);await mount();expect(host.textContent).toContain('無法確認回饋是否收到');expect(host.textContent).not.toContain('回饋已收到');expect(host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!.disabled).toBe(true);expect(posts).toHaveLength(2);});
async function resetConversation(){await act(async()=>root.render(createElement(Chat,{connected:{},variant:'classic',features:{...loadFeatureFlags(),voice:false},ai:null})));await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="開新對話"]')!.click());await act(async()=>root.render(createElement(Chat,{connected:{},variant:'sasuke',features:{...loadFeatureFlags(),voice:false},ai:null})));await fill('New conversation question');await act(async()=>submit());const request=posts.at(-1)!;await act(async()=>request.resolve(new Response(JSON.stringify({ok:true,messages:[],events:[],reply:'New conversation answer'}))));}
it('ignores old pending rating completion after conversation reset and allows rating the new reply',async()=>{const up=await ratedReply();const down=host.querySelector<HTMLButtonElement>('button[aria-label="回覆不好"]')!;await act(async()=>down.click());const old=posts[1];await resetConversation();await act(async()=>old.resolve(new Response(JSON.stringify({ok:true}))));const fresh=host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!;expect(fresh.disabled).toBe(false);expect(host.textContent).not.toContain('這則已記下');await act(async()=>fresh.click());expect(posts.filter(p=>p.url==='/api/quality')).toHaveLength(2);});
it('clears a confirmed rating lock when resetting the conversation',async()=>{const up=await ratedReply();await act(async()=>up.click());await act(async()=>posts[1].resolve(new Response(JSON.stringify({ok:true}))));await resetConversation();const fresh=host.querySelector<HTMLButtonElement>('button[aria-label="回覆有幫助"]')!;await act(async()=>fresh.click());expect(posts.filter(p=>p.url==='/api/quality')).toHaveLength(2);});

it('updates one pre-existing polite failure region without exposing server details or moving focus',async()=>{
 await mount(); const region=host.querySelector('[role="status"][aria-atomic="true"]'); expect(region).not.toBeNull(); expect(region!.textContent).toBe('');
 await fill('Synthetic request'); await act(async()=>submit()); const input=host.querySelector('textarea')!; input.focus();
 expect(region!.textContent).toBe(''); expect(host.textContent).toContain('正在處理');
 await act(async()=>posts[0].resolve(new Response(JSON.stringify({ok:false,error:{message:'PRIVATE_SYNTHETIC_STACK'}}))));
 expect(host.querySelector('[role="status"][aria-atomic="true"]')).toBe(region); expect(region!.textContent).toContain('本次'); expect(region!.textContent).toContain('核對紀錄'); expect(region!.textContent).not.toContain('PRIVATE_SYNTHETIC_STACK');
 expect(host.querySelectorAll('[role="status"]')).toHaveLength(1); expect(host.querySelector('.msg.error')!.closest('[aria-live],[role="alert"],[role="status"]')).toBeNull();
 expect(document.activeElement).toBe(input); expect(input.value).toBe('Synthetic request'); expect(posts).toHaveLength(1);
 const changes:MutationRecord[]=[]; const observer=new MutationObserver(records=>changes.push(...records)); observer.observe(region!,{subtree:true,childList:true,characterData:true});
 await fill('Synthetic newer draft'); expect(changes).toHaveLength(0); observer.disconnect();
});
it('clears the failure region for a new explicit request and announces a later failure without resending',async()=>{
 await mount();const region=host.querySelector('[role="status"][aria-atomic="true"]');expect(region).not.toBeNull();
 await fill('/早報'); await act(async()=>submit()); await act(async()=>posts[0].reject(Error('Synthetic disconnect'))); const summary=region!.textContent; expect(summary).toContain('本次');
 const restore=[...host.querySelectorAll('button')].find(b=>b.textContent==='放回輸入框')!; await act(async()=>restore.click()); expect(posts).toHaveLength(1); expect(region!.textContent).toBe(summary);
 await act(async()=>submit());expect(region!.textContent).toBe('');await act(async()=>posts[1].reject(Error('Second synthetic disconnect')));expect(region!.textContent).toBe(summary);expect(posts).toHaveLength(2);
});
it('restores only a generic previous-outcome status rather than replaying historical error details',async()=>{
 await mount(); await fill('Synthetic request');await act(async()=>submit());await act(async()=>posts[0].reject(Error('Synthetic disconnect')));
 await act(async()=>root.unmount());root=createRoot(host);await mount();const region=host.querySelector('[role="status"][aria-atomic="true"]');expect(region).not.toBeNull();expect(region!.textContent).toContain('上次');expect(region!.textContent).not.toContain('本次');expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);expect(posts).toHaveLength(1);
});

it.each([
 ['Safari IME keyCode 229', {key:'Enter',keyCode:229}],
 ['IME candidate navigation', {key:'ArrowDown',isComposing:true}],
 ['IME candidate dismissal', {key:'Escape',isComposing:true}],
])('leaves %s to the input method rather than handling the command palette',async(_label,init)=>{
 await mount();await fill('/早報');
 const input=host.querySelector('textarea')!;
 const event=new KeyboardEvent('keydown',{...init,bubbles:true,cancelable:true});
 await act(async()=>input.dispatchEvent(event));
 expect(event.defaultPrevented).toBe(false);
 expect(input.value).toBe('/早報');
 expect(host.querySelector('[role="listbox"]')).not.toBeNull();
 expect(posts).toHaveLength(0);
});
it('does not run a complete command from the Enter that just committed composition',async()=>{
 await mount();await fill('/早報');const input=host.querySelector('textarea')!;
 const now=vi.spyOn(Date,'now').mockReturnValue(10000);
 try{
  await act(async()=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'報'})));
  const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  await act(async()=>input.dispatchEvent(enter));
  expect(posts).toHaveLength(0);expect(input.value).toBe('/早報');expect(enter.defaultPrevented).toBe(false);
 }finally{now.mockRestore();}
});
it('still sends an intentionally selected command after IME composition has settled',async()=>{
 await mount();await fill('/早報');const input=host.querySelector('textarea')!;
 const now=vi.spyOn(Date,'now').mockReturnValue(10000);
 try{await act(async()=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'報'})));now.mockReturnValue(10100);
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
 expect(posts).toHaveLength(1);expect(posts[0].url).toBe('/api/command');expect(JSON.parse(posts[0].init.body as string).text).toBe('/早報');
 }finally{now.mockRestore();}
});
it('keeps normal command selection and Tab completion working outside composition',async()=>{
 await mount();await fill('/');const input=host.querySelector('textarea')!;
 const options=[...host.querySelectorAll('[role="option"]')];expect(options.length).toBeGreaterThan(1);
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
 expect(options[1].getAttribute('aria-selected')).toBe('true');
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true})));
 expect(options[0].getAttribute('aria-selected')).toBe('true');
 const complete=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
 await act(async()=>input.dispatchEvent(complete));expect(complete.defaultPrevented).toBe(true);expect(input.value).not.toBe('/');expect(posts).toHaveLength(0);
});
it.each([{ctrlKey:true},{metaKey:true}])('keeps explicit modified Enter sending ordinary chat: %j',async modifier=>{
 await mount();await fill('Synthetic intentional keyboard message');
 await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',...modifier,bubbles:true,cancelable:true})));
 expect(posts).toHaveLength(1);expect(posts[0].url).toBe('/api/chat');
});
