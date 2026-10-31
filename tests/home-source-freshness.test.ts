import {expect,it,vi} from 'vitest';
import {eveningInsight} from '@/garmin/insight';
import {cachedWeather} from '@/weather/open-meteo';
it('does not describe missing daily/activity observations as a light healthy day',()=>{
 const r=eveningInsight({date:'2026-10-31',daily:null,activities:[],sleepToday:null,profile:{plan:{},goal:null},waterGoalMl:2000,waterTodayMl:null,includeWater:false});
 expect(r.headline).toContain('資料不足');expect(r.headline).not.toContain('輕鬆');expect(r.gaps).toContain('今天的活動摘要');
});
it('keeps weather source time when falling back to an old forecast',async()=>{
 vi.useFakeTimers();try{
 vi.setSystemTime(new Date('2026-10-31T01:00:00Z'));
 const body={daily:{time:['2026-10-31'],temperature_2m_min:[18],temperature_2m_max:[24],weather_code:[1]}};
 const first=await cachedWeather(0,'2026-10-31',{lat:0,lon:0,name:'Synthetic place'},vi.fn(async()=>new Response(JSON.stringify(body))) as typeof fetch);
 expect(first.fetched_at).toBe('2026-10-31T01:00:00.000Z');expect(first.stale).toBe(false);
 vi.setSystemTime(new Date('2026-10-31T02:00:00Z'));
 const old=await cachedWeather(0,'2026-10-31',{lat:0,lon:0,name:'Synthetic place'},vi.fn(async()=>{throw Error('Synthetic outage');}) as typeof fetch);
 expect(old.fetched_at).toBe(first.fetched_at);expect(old.stale).toBe(true);
 }finally{vi.useRealTimers();}
});
it('treats a normalized all-null daily object as missing observations, not a light day',()=>{
 const daily={date:'2026-10-31',steps:null,step_goal:null,moderate_minutes:null,vigorous_minutes:null,stress_avg:null,body_battery_latest:null,body_battery_low:null,hydration_ml:null} as any;
 const r=eveningInsight({date:'2026-10-31',daily,activities:[],sleepToday:null,profile:{plan:{},goal:null},waterGoalMl:2000,waterTodayMl:null,includeWater:false});
 expect(r.headline).toContain('資料不足');expect(r.gaps).toContain('今天的活動摘要');
});
it('never presents yesterday\'s tomorrow cache as tomorrow after the calendar rolls over',async()=>{
 vi.useFakeTimers();try{
 vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
 const body={daily:{time:['2026-10-30','2026-10-31'],temperature_2m_min:[18,19],temperature_2m_max:[24,25],weather_code:[1,1]}};
 await cachedWeather(1,'2026-10-30',{lat:0,lon:0,name:'Synthetic place'},vi.fn(async()=>new Response(JSON.stringify(body))) as typeof fetch);
 vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
 await expect(cachedWeather(1,'2026-10-31',{lat:0,lon:0,name:'Synthetic place'},vi.fn(async()=>{throw Error('Synthetic outage');}) as typeof fetch)).rejects.toThrow();
 }finally{vi.useRealTimers();}
});
