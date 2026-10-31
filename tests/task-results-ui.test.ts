// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskCard } from '@/app/components/shared';
import { safeTaskLinks, taskNextStep } from '@/tasks/evidence';
let root: Root, host: HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const base={id:'t1',title:'合成任務',kind:'background',kind_label:'背景任務',status:'completed',status_label:'已完成',schedule_label:'單次',runs_kept:1};
it('shows the latest real result and source host without opening history or making requests',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await act(async()=>root.render(createElement(TaskCard,{task:{...base,last_run:{status:'completed',local:'10/31 08:00',steps:[{step:0,type:'tool',status:'ok',summary:'2 筆事項',links:[{label:'官方完成產物',url:'https://example.com/result'}]}]}}})));
 expect(host.textContent).toContain('最近結果');expect(host.textContent).toContain('2 筆事項');expect(host.textContent).toContain('example.com');
 expect(host.textContent).toContain('來源連結');expect(host.textContent).not.toContain('官方完成產物');
 const a=host.querySelector('a[href="https://example.com/result"]')!;expect(a.getAttribute('rel')).toBe('noopener noreferrer');expect(fetcher).not.toHaveBeenCalled();
});
it('makes uncertain partial results actionable without a retry action or fake success',async()=>{
 await act(async()=>root.render(createElement(TaskCard,{task:{...base,status:'outcome_unknown',status_label:'結果不明',last_run:{status:'outcome_unknown',local:'今天',error:'連線中斷',steps:[{step:0,type:'tool',status:'ok',summary:'已讀取 2 筆'},{step:1,type:'tool',status:'error',summary:'寫入結果未明',error_code:'OUTCOME_UNKNOWN',links:[]}]}}})));
 expect(host.textContent).toContain('已讀取 2 筆');expect(host.textContent).toContain('先到原系統核對');expect(host.textContent).toContain('寫入結果未明');expect(host.textContent).not.toContain('步驟未完成');expect(host.textContent).not.toContain('已完成');
 expect([...host.querySelectorAll('button')].some(b=>/重跑|重試/.test(b.textContent||''))).toBe(false);
});
it('renders legacy empty evidence honestly and replaces it on a fresh result',async()=>{
 await act(async()=>root.render(createElement(TaskCard,{task:{...base,last_run:{status:'completed',local:'昨天'}}})));
 expect(host.textContent).toContain('沒有保留步驟摘要或來源連結');expect(host.querySelector('a')).toBeNull();
 await act(async()=>root.render(createElement(TaskCard,{task:{...base,last_run:{status:'completed',local:'今天',steps:[{step:0,type:'notify',status:'ok',summary:'通知已排入',delivery_status:'provider_accepted'}]}}})));
 expect(host.textContent).not.toContain('昨天');expect(host.textContent).toContain('不代表裝置已顯示');
});
it('rejects unsafe and obvious secret URLs and deduplicates at the rendering boundary',()=>{
 expect(safeTaskLinks(['javascript:alert(1)','data:text/html,a','file:///tmp/a','https://u:p@example.com','https://example.com?access_token=secret','https://example.com?X-Amz-Signature=secret','https://example.com/#token','https://example.com/token/secret','https://example.com?q=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature','https://example.com?Policy=abc&Key-Pair-Id=xyz'].map(url=>({label:'source',url})))).toEqual([]);
 expect(safeTaskLinks([{label:'one',url:'https://example.com'},{label:'two',url:'https://example.com/'}])).toHaveLength(1);
 expect(taskNextStep({status:'failed',steps:[{step:0,type:'tool',status:'error',summary:'expired',error_code:'PROPOSAL_EXPIRED'}]})).toContain('沒有執行');
});
it.each(['held','grouped','expired'])('shows terminal %s delivery without an old retry promise',async delivery_status=>{
 await act(async()=>root.render(createElement(TaskCard,{task:{...base,last_run:{status:'completed',local:'今天',steps:[{step:0,type:'notify',status:'ok',summary:'等裝置可接收時重試',delivery_status}]}}})));
 expect(host.textContent).not.toContain('等裝置可接收時重試');expect(host.textContent).toContain('通知證據');
});
