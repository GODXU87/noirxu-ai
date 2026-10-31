// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const route=vi.hoisted(()=>({path:'/tasks'}));
vi.mock('next/navigation',()=>({usePathname:()=>route.path,useRouter:()=>({push:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
vi.mock('@/app/sasuke/Inbox',()=>({Inbox:()=>null}));
import {SasukeNav} from '@/app/sasuke/SasukeNav';
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});route.path='/tasks';localStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const opener=()=>host.querySelector<HTMLButtonElement>('button[aria-label="開啟選單"]')!;
const drawer=()=>host.querySelector<HTMLElement>('.sk-drawer')!;
async function mount(){await act(async()=>root.render(createElement(SasukeNav)));}
async function open(){await act(async()=>{opener().focus();opener().click();});}
async function key(key:string,shiftKey=false){await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true})));}
it('announces expanded/controls and focuses the dialog close control on open',async()=>{await mount();expect(opener().getAttribute('aria-expanded')).toBe('false');await open();expect(opener().getAttribute('aria-expanded')).toBe('true');expect(opener().getAttribute('aria-controls')).toBe(drawer().id);expect(drawer().getAttribute('role')).toBe('dialog');expect(drawer().getAttribute('aria-modal')).toBe('true');expect(document.activeElement?.getAttribute('aria-label')).toBe('關閉選單');expect(drawer().querySelector('a[href="/tasks"]')?.getAttribute('aria-current')).toBe('page');});
it('Escape closes and restores focus without a focusable hidden close button',async()=>{await mount();await open();await key('Escape');expect(opener().getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(opener());expect(drawer().hasAttribute('inert')).toBe(true);expect(drawer().querySelector('button')).toBeNull();expect(document.body.classList.contains('drawer-open')).toBe(false);});
it('contains Tab and Shift+Tab at the dialog edges and redirects outside focus',async()=>{await mount();await open();const first=drawer().querySelector<HTMLButtonElement>('button')!;const last=drawer().querySelector<HTMLButtonElement>('button[aria-label="登出"]')!;last.focus();await key('Tab');expect(document.activeElement).toBe(first);await key('Tab',true);expect(document.activeElement).toBe(last);await act(async()=>opener().focus());expect(document.activeElement).toBe(first);});
it('close button and scrim both restore the opener and repeated opening works',async()=>{await mount();await open();await act(async()=>drawer().querySelector<HTMLButtonElement>('button[aria-label="關閉選單"]')!.click());expect(document.activeElement).toBe(opener());await open();await act(async()=>host.querySelector<HTMLElement>('.sk-scrim')!.click());expect(document.activeElement).toBe(opener());expect(opener().getAttribute('aria-expanded')).toBe('false');});
it('route changes and unmount clean up the dialog lifecycle',async()=>{await mount();await open();route.path='/memory';await act(async()=>root.render(createElement(SasukeNav)));expect(opener().getAttribute('aria-expanded')).toBe('false');expect(document.body.classList.contains('drawer-open')).toBe(false);await open();await act(async()=>root.unmount());root=createRoot(host);expect(document.body.classList.contains('drawer-open')).toBe(false);});
