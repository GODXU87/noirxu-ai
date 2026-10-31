'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

type Part = 'agenda' | 'weather' | 'body';
const PARTS: Part[] = ['weather', 'body', 'agenda'];
type Reading = Record<string, any>;
export function homeNotifications<T extends {kind?:string;title:string}>(items:T[]):T[] {
  // Home presentation only: never mutates or marks the original inbox read.
  return items.filter(i=>i.kind!=='water'&&!/喝水|飲水|补水|補水|hydration/i.test(i.title)).slice(0,2);
}

/** Current-mount reads only. No browser cache of health data, no provider writes. */
export function useToday(enabled:boolean,includeAgenda=true) {
  const [data,setData]=useState<Partial<Record<Part,Reading>>>({});
  const [loading,setLoading]=useState<Set<Part>>(new Set(PARTS));
  const controller=useRef<AbortController|null>(null);
  const refresh=useCallback(()=>{
    if(!enabled)return;
    controller.current?.abort();const c=new AbortController();controller.current=c;
    const parts=includeAgenda?PARTS:PARTS.filter(p=>p!=='agenda');
    setLoading(new Set(parts));
    for(const part of parts){
      const timeout=setTimeout(()=>c.abort(),15000);
      void fetch(`/api/today?part=${part}`,{cache:'no-store',signal:c.signal})
        .then(async r=>{const b=await r.json();if(!r.ok||!b?.ok)throw Error(b?.error?.message??'暫時讀不到');return b;})
        .then(b=>{if(controller.current===c&&!c.signal.aborted)setData(d=>({...d,[part]:{...b,...(!b.error?{read_at:new Date().toISOString()}:{} )}}));})
        .catch(e=>{if(controller.current===c)setData(d=>({...d,[part]:{error:{message:c.signal.aborted?'讀取逾時，請重新讀取。':e instanceof Error?e.message:'連線中斷'}}}));})
        .finally(()=>{clearTimeout(timeout);if(controller.current===c)setLoading(s=>{const n=new Set(s);n.delete(part);return n;});});
    }
  },[enabled,includeAgenda]);
  useEffect(()=>{refresh();return()=>{controller.current?.abort();controller.current=null;};},[refresh]);
  return {data,loading,refresh};
}
const stamp=(value:string)=>new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
function ReadingState({value,loading}:{value?:Reading;loading:boolean}){
  return <>{loading&&<span className="tg-sub" role="status">讀取中…{value&&!value.error?'（仍顯示上次讀取）':''}</span>}{value?.error&&<span className="tg-sub tone-error" role="status">{value.error.message??'暫時讀不到'}</span>}{!loading&&!value&&<span className="tg-sub">尚未取得資料</span>}{value?.read_at&&!value.error&&<span className="tg-meta">讀取 {stamp(value.read_at)} · 台灣時間</span>}</>;
}

export function TodayGlance({data,loading,ask,refresh,showAgenda=true}:{data:Partial<Record<Part|'water',Reading>>;loading:Set<Part>;ask:(text:string)=>void;refresh?:()=>void;showAgenda?:boolean}){
  const w=data.weather,b=data.body,a=data.agenda;
  const show=(p:Part)=>!data[p]?.off;
  const weather=w?.weather;
  const bodyLine=b?.line?.trim()||b?.headline?.trim();
  return <section className="home-glance" aria-label="今天一覽">
    <div className="home-readings">
      {show('weather')&&<article className="home-reading">
        <h2>{w?.tomorrow?'明天天氣':'天氣'}</h2>
        {!w?.error&&weather&&<><p className="home-reading-value">{Number.isFinite(weather.temp_min)&&Number.isFinite(weather.temp_max)?`${Math.round(weather.temp_min)}–${Math.round(weather.temp_max)}°`:'溫度未提供'}<span>{weather.summary}</span></p><p className="tg-sub">{Number.isFinite(weather.rain_chance)?`降雨 ${Math.round(weather.rain_chance)}%`:'降雨資料未提供'}</p><p className="tg-meta">{weather.place||'地點未提供'} · {weather.date||'日期未提供'} · {weather.source||'來源未提供'}</p>{weather.fetched_at&&<p className="tg-meta">來源取得 {stamp(weather.fetched_at)}</p>}{weather.stale&&<p className="tg-sub tone-warn">目前為保留的舊預報；來源更新失敗，請稍後再讀取。</p>}</>}
        <ReadingState value={w} loading={loading.has('weather')}/>
        <button type="button" className="home-text-action" onClick={()=>ask(w?.tomorrow?'明天天氣如何？':'今天天氣如何？')}>詢問天氣詳情</button>
      </article>}
      {show('body')&&<article className="home-reading">
        <h2>身體近況</h2>
        {!b?.error&&b&&<><p className="home-reading-value">{bodyLine||'資料不足，暫不判斷身體狀況。'}</p><p className="tg-meta">Garmin · {b.date||'資料日期未提供'} · 固定規則摘要，非醫療診斷</p>{b.signals?.[0]&&<p className="tg-sub">{b.signals[0].text}</p>}{b.gaps?.length>0&&<p className="tg-sub">尚缺：{b.gaps.join('、')}</p>}</>}
        <ReadingState value={b} loading={loading.has('body')}/>
        <button type="button" className="home-text-action" onClick={()=>ask('我身體狀況如何')}>查看身體依據</button>
      </article>}
    </div>
    <div className="home-dayline">{showAgenda&&<><Link href="/tasks">今日到期{a&&!a.error&&Number.isFinite(a.today)?` ${a.today} 件`:''}{(a?.overdue??0)>0&&!a?.error?` · 逾期 ${a?.overdue} 件`:''}</Link><ReadingState value={a} loading={loading.has('agenda')}/></>}{refresh&&<button className="home-text-action" type="button" disabled={loading.size>0} onClick={refresh}>{loading.size?'更新中…':'重新讀取'}</button>}</div>
  </section>;
}
