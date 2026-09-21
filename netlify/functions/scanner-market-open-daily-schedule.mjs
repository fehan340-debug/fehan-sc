import { getSiteSettings, getDataStore } from '../../lib.js';
import { refreshUniverse } from './scanner-universe-core.mjs';
import { dispatchFloatWorker } from './float-worker-trigger.mjs';
import { refreshIpoCache } from './scanner-ipo-core.mjs';

function nyParts(){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
}

export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const parts=nyParts();
  const weekday=parts.find(x=>x.type==='weekday')?.value||'';
  const hour=Number(parts.find(x=>x.type==='hour')?.value||0);
  const minute=Number(parts.find(x=>x.type==='minute')?.value||0);
  if(['Sat','Sun'].includes(weekday)||hour!==9||minute!==15)return new Response('waiting for 09:15 America/New_York',{status:200});

  const store=getDataStore();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const marker=await store.get('scanner-market-open-refresh-date',{type:'json',consistency:'strong'}).catch(()=>null);
  if(marker?.date===today&&marker?.state==='complete')return new Response('daily market-open refresh already completed',{status:200});
  const floatJob=await store.get('scanner-float-job-v1',{type:'json',consistency:'strong'}).catch(()=>null);
  if(marker?.date===today&&marker?.state==='dispatched'&&floatJob?.active)return new Response('daily Finviz float worker already running',{status:200});

  const startedAt=new Date().toISOString();
  await store.setJSON('scanner-market-open-refresh-status',{state:'building',date:today,startedAt,finishedAt:null,error:null});
  try{
    // Refresh IPOs and the authoritative 100-day split universe before the
    // market opens, then scrape Free Float from that exact universe.
    const ipo=await refreshIpoCache();
    const universe=await refreshUniverse();
    const worker=await dispatchFloatWorker({source:'daily-market-open'});
    await store.setJSON('scanner-market-open-refresh-date',{date:today,state:'dispatched',startedAt,universeUpdatedAt:universe.updatedAt,ipoUpdatedAt:ipo?.updatedAt||null,worker,updatedAt:new Date().toISOString()});
    await store.setJSON('scanner-market-open-refresh-status',{state:'dispatched',date:today,startedAt,finishedAt:null,error:null,universeUpdatedAt:universe.updatedAt,ipoUpdatedAt:ipo?.updatedAt||null,tickers:universe.tickers?.length||0,worker});
    return new Response(JSON.stringify({ok:true,date:today,tickers:universe.tickers?.length||0,worker}),{status:202,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  }catch(e){
    const message=String(e?.message||e||'Daily market-open refresh failed');
    await store.setJSON('scanner-market-open-refresh-status',{state:'error',date:today,startedAt,finishedAt:new Date().toISOString(),error:message});
    return new Response(message,{status:500});
  }
}

export const config={schedule:'* * * * 1-5'};
