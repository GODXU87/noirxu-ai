'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { ACCEPTANCE_STATUS,PROJECTS,type Acceptance,type Evidence,type Project } from '@/acceptance/model';
import type { OwnerAction } from '@/acceptance/actions';
import { safeTaskLinks } from '@/tasks/evidence';
import { taipeiLocalToIso } from '@/goals/form';
const CHANGED='noirxu-acceptance-changed';
const local=(at:string)=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
/** Only application-owned GETs. No provider checks on mount, poll or focus. */
function useRecords<T>(path:string){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const generation=useRef(0),controller=useRef<AbortController|null>(null);
 const refresh=useCallback(async()=>{const g=++generation.current;controller.current?.abort();const c=new AbortController();controller.current=c;setLoading(true);
  try{const r=await fetch(path,{cache:'no-store',signal:c.signal});const b=await r.json();if(!r.ok||!b.ok)throw Error(b?.error?.message??'讀取失敗，請重新整理。');if(g===generation.current){setData(b);setError('');}}
  catch(e){if(g===generation.current&&!c.signal.aborted)setError(e instanceof Error?e.message:'連線中斷，請重新整理。');}
  finally{if(g===generation.current)setLoading(false);}
 },[path]);
 useEffect(()=>{void refresh();const changed=()=>{if(document.visibilityState!=='hidden')void refresh();};const timer=setInterval(changed,20000);
  for(const event of [CHANGED,'noirxu-tasks-changed','noirxu-goals-changed','focus','online'])window.addEventListener(event,changed);
  document.addEventListener('visibilitychange',changed);
  return()=>{generation.current++;controller.current?.abort();clearInterval(timer);for(const event of [CHANGED,'noirxu-tasks-changed','noirxu-goals-changed','focus','online'])window.removeEventListener(event,changed);document.removeEventListener('visibilitychange',changed);};
 },[refresh]);return {data,error,loading,refresh};
}
function SafeLink({url,label}:{url:string;label?:string}){const safe=safeTaskLinks([{url,label:label??'來源'}])[0];return safe?<a href={safe.url} target="_blank" rel="noopener noreferrer" className="acceptance-link"><span>{label??new URL(safe.url).host}</span><small>{new URL(safe.url).host} · {safe.url}</small></a>:null;}
function EvidenceView({evidence}:{evidence?:Evidence}){return <div className="acceptance-stages">
 <div><strong>1 · GitHub commit</strong><p>{evidence?.commit.reason??'尚未查核完整 SHA。'}</p>{evidence?.commit.url&&<SafeLink url={evidence.commit.url}/>}</div>
 <div><strong>2 · CI 與正式部署</strong><p>{evidence?.deployment.reason??'目前沒有部署平台唯讀驗證能力；GitHub 綠燈不是正式部署 READY 的證明。'}</p>{evidence?.ci.map((s,i)=><p key={`${s.context}:${i}`}>CI 回報 · {s.context}：{s.state}{s.url&&<SafeLink url={s.url}/>}</p>)}{evidence?.ci_reason&&<p className="hint">{evidence.ci_reason}</p>}</div>
 <div><strong>3 · 正式網址與功能</strong><p>{evidence?.runtime.reason??'尚未自動驗證正式網址、版本或功能；不會自動開啟網站或重跑操作。請依條件人工檢查。'}</p></div>
 {evidence&&<p className="hint">查核時間：<time dateTime={evidence.checked_at}>{local(evidence.checked_at)}</time>；這是保留的觀察，不是即時監控。</p>}
 </div>;}
async function command(value:unknown){const r=await fetch('/api/acceptance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const b=await r.json();if(!r.ok||!b.ok)throw Object.assign(Error(b?.error?.message??'更新未確認，請重新整理；不要重複操作。'),{status:r.status});return b.item as Acceptance;}
function AcceptanceCard({item,changed}:{item:Acceptance;changed:()=>void}){
 const [editing,setEditing]=useState(false),[observation,setObservation]=useState(''),[decision,setDecision]=useState('pass'),[busy,setBusy]=useState(false),[error,setError]=useState('');const locked=useRef(false);
 const [editingRevision,setEditingRevision]=useState(item.revision);
 const act=async(value:unknown)=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await command(value);setEditing(false);setObservation('');changed();}catch(e){setError(e instanceof Error?e.message:'更新未確認。');}finally{locked.current=false;setBusy(false);}};
 const stale=editing&&editingRevision!==item.revision;
 return <article tabIndex={-1} className="acceptance-record" id={`acceptance-${item.id}`}>
  <header><h3>{item.title}</h3><span className="state-chip">{ACCEPTANCE_STATUS[item.status]}</span></header>
  <p className="hint">{PROJECTS[item.project].name} · 期望 commit <code>{item.sha}</code>{item.due_at&&<> · 期限 {local(item.due_at)}</>}</p>
  <p><strong>驗收條件：</strong>{item.criteria}</p>
  <SafeLink url={PROJECTS[item.project].url} label="手動開啟預期網站（尚非部署證明）"/>
  <EvidenceView evidence={item.evidence}/>
  <div className="row acceptance-buttons"><button type="button" className="ghost" disabled={busy||item.status==='cancelled'} onClick={()=>void act({action:'check',id:item.id,revision:item.revision})}>GitHub 唯讀查核</button><button type="button" className="ghost" disabled={busy} onClick={()=>{setEditingRevision(item.revision);setEditing(true);setError('');}}>記錄人工驗收</button></div>
  <p className="hint">公開 GitHub 每位使用者每分鐘最多查核一次；限流期間保留原時間。私有 repo 不會要求新增權限。人工回報不會批准或重跑任何原任務。</p>
  {item.check_until&&<p className="hint">{Date.parse(item.check_until)>Date.now()?'有查核正在處理；可稍後重新整理。':'先前查核可能中斷；未取得結果，可重新查核。'}</p>}
  {error&&<p role="alert" className="hint tone-error">{error}</p>}
  {editing&&<form className="stack" onSubmit={e=>{e.preventDefault();if(stale||busy||!e.currentTarget.checkValidity())return;void act({action:'report',id:item.id,revision:editingRevision,input:{decision,observation}});}}>
   <label>人工判定<select aria-label="人工判定" value={decision} onChange={e=>setDecision(e.target.value)}><option value="pass">人工驗收通過（未獨立查證）</option><option value="fail">人工驗收未通過</option><option value="cancel">取消這筆驗收</option><option value="reopen">重新開啟驗收</option></select></label>
   <label>實際觀察<textarea aria-label="實際觀察" value={observation} onChange={e=>setObservation(e.target.value)} minLength={10} maxLength={1500} required placeholder="寫下檢查步驟、看到的結果與仍未驗證的部分；不要貼密碼或私密連結。"/></label>
   {stale&&<p role="alert">紀錄已更新；你的草稿保留。請取消編輯，重新查看最新證據再回報。</p>}
   <div className="row acceptance-buttons"><button type="submit" className="primary" disabled={busy||stale}>保存人工回報</button><button type="button" className="ghost" disabled={busy} onClick={()=>{setEditing(false);setObservation('');}}>取消編輯</button></div>
  </form>}
  {(item.checks?.length??0)>1&&<details><summary>查核歷程（最近 {item.checks.length} 筆）</summary>{item.checks.map(c=><div key={c.revision}><h4>查核版本 {c.revision}</h4><EvidenceView evidence={c.evidence}/></div>)}</details>}
  {item.reports.length>0&&<details><summary>人工回報紀錄（最近 {item.reports.length} 筆）</summary>{item.reports.map((r,i)=><p key={`${r.at}:${i}`}>使用者回報 · {local(r.at)} · {({pass:'通過',fail:'未通過',cancel:'取消',reopen:'重新開啟'} as const)[r.decision]}：{r.observation}（當時查核版本：{r.evidence_revision??'無自動查核'}）</p>)}</details>}
 </article>;
}
export function AcceptancePanel({initialId}:{initialId?:string}){
 const {data,error,loading,refresh}=useRecords<{items:Acceptance[]}>('/api/acceptance');const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const [project,setProject]=useState<Project>('noirxu-ai'),[title,setTitle]=useState(''),[sha,setSha]=useState(''),[criteria,setCriteria]=useState(''),[due,setDue]=useState('');const requestId=useRef(''),locked=useRef(false);const pendingCreate=useRef<unknown>(null);const [uncertain,setUncertain]=useState(false);
 useEffect(()=>{if(!initialId||!data?.items.some(a=>a.id===initialId))return;const el=document.getElementById(`acceptance-${initialId}`);el?.scrollIntoView?.({block:'start'});el?.focus({preventScroll:true});},[initialId,Boolean(data?.items.some(a=>a.id===initialId))]);
 const changed=()=>{window.dispatchEvent(new Event(CHANGED));};
 async function create(e:React.FormEvent<HTMLFormElement>){e.preventDefault();if(locked.current||!e.currentTarget.checkValidity())return;locked.current=true;setBusy(true);setProblem('');
  try{requestId.current||=crypto.randomUUID();pendingCreate.current??={action:'create',input:{request_id:requestId.current,project,title,sha,criteria,due_at:due?taipeiLocalToIso(due):null}};await command(pendingCreate.current);pendingCreate.current=null;setUncertain(false);setOpen(false);setTitle('');setSha('');setCriteria('');setDue('');requestId.current='';changed();}
  catch(e){const known=!pendingCreate.current||[400,401,403].includes((e as {status?:number}).status??0);if(known){pendingCreate.current=null;requestId.current='';}setUncertain(!known);setProblem(e instanceof Error?e.message:'建立未確認；請先重新整理。');}finally{locked.current=false;setBusy(false);}}
 return <section className="card acceptance-panel"><div className="row acceptance-buttons"><h2>網站任務驗收</h2><button type="button" className="ghost" disabled={loading} onClick={()=>void refresh()}>重新整理驗收</button><button type="button" className="primary" disabled={busy} onClick={()=>setOpen(v=>!v)}>新增驗收</button></div>
  <p className="hint">分開看 commit、部署與功能證據；人工通過不是工具已執行，也不會取代原本的確認程序。</p>
  {error&&<p role="alert">{error}</p>}{problem&&<p role="alert">{problem}</p>}
  {open&&<form className="stack" onSubmit={create}>
   {uncertain&&<p role="alert">上次保存結果未確認。草稿已鎖定；再按保存只重送同一份請求，不會新增第二筆。取消新增只關閉編輯，不會解除這次待確認請求。</p>}
   <fieldset disabled={busy||uncertain} className="stack acceptance-fields">
   <label>網站<select aria-label="網站" value={project} onChange={e=>setProject(e.target.value as Project)}>{Object.entries(PROJECTS).map(([id,p])=><option value={id} key={id}>{p.name}</option>)}</select></label>
   <label>要驗收的工作<input aria-label="要驗收的工作" value={title} onChange={e=>setTitle(e.target.value)} maxLength={100} required/></label>
   <label>完整 commit SHA<input aria-label="完整 commit SHA" value={sha} onChange={e=>setSha(e.target.value.trim())} pattern="[a-fA-F0-9]{40}" maxLength={40} required autoCapitalize="none" spellCheck={false}/></label>
   <label>具體驗收條件<textarea aria-label="具體驗收條件" value={criteria} onChange={e=>setCriteria(e.target.value)} minLength={10} maxLength={1000} required/></label>
   <label>期限（台灣時間，可留空）<input aria-label="驗收期限" type="datetime-local" value={due} onChange={e=>setDue(e.target.value)}/></label>
   </fieldset><div className="row acceptance-buttons"><button type="submit" className="primary" disabled={busy}>保存驗收條件</button><button type="button" className="ghost" disabled={busy} onClick={()=>setOpen(false)}>取消新增</button></div>
  </form>}
  {initialId&&data&&!data.items.some(a=>a.id===initialId)&&<p role="status">找不到指定驗收紀錄；請確認目前登入帳戶或重新整理。</p>}
  {!data?<p role="status">{error?'尚未取得驗收紀錄。':'讀取驗收紀錄…'}</p>:data.items.length?data.items.map(a=><AcceptanceCard key={a.id} item={a} changed={changed}/>):<p className="hint">還沒有驗收紀錄。先記錄網站、完整 commit 與具體條件；不會自動連接或操作其他網站。</p>}
 </section>;
}
export function OwnerActionsPanel(){
 const {data,error,loading,refresh}=useRecords<{items:OwnerAction[];errors:string[];as_of:string;truncated?:boolean}>('/api/owner-actions');const [tab,setTab]=useState<OwnerAction['state']>('action');
 const visible=data?.items.filter(i=>i.state===tab)??[];return <section className="card owner-actions"><div className="row acceptance-buttons"><h2>今天需要你處理</h2><button className="ghost" type="button" disabled={loading} onClick={()=>void refresh()}>重新整理待辦</button></div>
  <p className="hint">依原始任務與目標去重，不重發通知。完成或取消要回原處理流程，這裡沒有代批准的完成勾選。</p>
  <div className="row acceptance-buttons" role="group" aria-label="待辦狀態">{(['action','waiting','resolved'] as const).map(state=><button type="button" className={tab===state?'primary':'ghost'} aria-pressed={tab===state} key={state} onClick={()=>setTab(state)}>{({action:'需要處理',waiting:'等待中',resolved:'已解決／結束'})[state]}（{data?.items.filter(i=>i.state===state).length??0}）</button>)}</div>
  {error&&<p role="alert">{error} 可能仍顯示上次資料。</p>}{data?.errors.map(e=><p role="alert" key={e}>{e}</p>)}
  {data?.as_of&&<p className="hint">最後讀取 {local(data.as_of)}（台灣時間）；頁面可見時每 20 秒重新讀取原始狀態。</p>}
  {!data?<p role="status">{error?'尚未取得待辦。':'讀取待辦…'}</p>:visible.length?<ul className="owner-action-list">{visible.map(i=><li key={i.id}><h3>{i.title}</h3><p>{i.reason}</p><p>下一步：{i.next_step}</p>{i.due_at&&<p className="hint">期限／下次排程：{local(i.due_at)}</p>}<a className="ghost" href={i.href}>前往原處理流程</a></li>)}</ul>:<p className="hint">{data.errors.length?'已讀取來源中沒有這類項目；仍有來源讀取失敗。':tab==='action'?'目前沒有需要你立即處理的項目。':tab==='waiting'?'目前沒有等待中的項目。':'目前沒有已結束的項目。'}</p>}
  {data?.truncated&&<p className="hint">目前顯示前 200 項；請到原任務中心查看完整清單。</p>}
 </section>;
}
