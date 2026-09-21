import crypto from 'node:crypto';
import { store } from './store.mjs';
import { fetchFinvizStockInfo } from './finviz.mjs';

const TIMEOUT_MS=8000;
const JOB_KEY='scanner-float-job-v1';
const STATUS_KEY='scanner-finviz-float-status-v1';
const finite=n=>Number.isFinite(Number(n))?Number(n):null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(key){return await store.get(key);}
async function setJson(key,value){return await store.setJSON(key,value);}
function easternDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}

async function publishFloatSnapshot(job,stamp){
  const records={};
  for(const ticker of job.tickers){
    const r=job.records[ticker];
    if(r?.freeFloat!=null)records[ticker]={ticker,freeFloat:r.freeFloat,free_float:r.freeFloat,freeFloatSource:'finviz-scrapingant',freeFloatUpdatedAt:r.freeFloatUpdatedAt||stamp};
  }
  const payload={version:1,ready:true,updatedAt:stamp,date:job.date,total:job.total,successful:Object.keys(records).length,failed:job.failed,records,source:'finviz-via-scrapingant'};
  await setJson('scanner-float-data-v1',payload);

  // Update only Float fields in the published customer snapshot. Short/current
  // fields are intentionally left untouched.
  const pointer=await getJson('scanner-cache-pointer-v2');
  const central=(pointer?.key?await getJson(pointer.key):null)||await getJson('scanner-cache-v1');
  if(central?.ready&&Array.isArray(central.records)){
    const mergedRecords=central.records.map(row=>{
      const t=String(row?.ticker||'').toUpperCase();
      const f=records[t];
      return f?{...row,freeFloat:f.freeFloat,free_float:f.freeFloat,freeFloatSource:f.freeFloatSource,freeFloatUpdatedAt:f.freeFloatUpdatedAt}:row;
    });
    const merged={...central,records:mergedRecords,freeFloatUpdatedAt:stamp,updatedAt:central.updatedAt||stamp};
    await setJson('scanner-cache-v1',merged);
    await setJson('scanner-central-cache-v1',merged);
    await setJson('scanner-cache-pointer-v2',{version:2,key:'scanner-cache-v1',updatedAt:merged.updatedAt,records:mergedRecords.length,freeFloatUpdatedAt:stamp});
  }
  await setJson('scanner-market-open-refresh-date',{date:job.date,state:'complete',startedAt:job.startedAt,finishedAt:stamp,universeUpdatedAt:job.universeUpdatedAt,total:job.total,successful:Object.keys(records).length,failed:job.failed});
  await setJson(STATUS_KEY,{state:'ready',date:job.date,startedAt:job.startedAt,finishedAt:stamp,total:job.total,done:job.total,successful:Object.keys(records).length,failed:job.failed,currentTicker:null,source:'finviz-via-scrapingant'});
  return payload;
}

async function main(){
  const date=easternDate();
  const forceRun=String(process.env.FORCE_FLOAT_RUN||'').toLowerCase()==='true';
  const universe=await getJson('scanner-universe-v2');
  const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
  if(!tickers.length)throw new Error('لا توجد قائمة أسهم في scanner-universe-v2.');

  const marker=await getJson('scanner-finviz-float-daily-v1');
  if(marker?.date===date&&marker?.state==='ready'&&!forceRun)return;

  const startedAt=new Date().toISOString();
  const job={active:true,jobId:crypto.randomUUID(),date,startedAt,universeUpdatedAt:universe?.updatedAt||null,tickers,total:tickers.length,cursor:0,successful:0,failed:0,records:{}};
  await setJson(JOB_KEY,job);
  await setJson(STATUS_KEY,{state:'building',date,startedAt,finishedAt:null,total:tickers.length,done:0,successful:0,failed:0,currentTicker:null,source:'finviz-via-scrapingant'});

  // Two concurrent requests balance throughput with Finviz/ScrapingAnt rate limits.
  let idx=0;
  const worker=async()=>{
    while(true){
      const i=idx++;
      if(i>=tickers.length)return;
      const ticker=tickers[i];
      const old=(await getJson(`scanner-short-record:${ticker}`))||{};
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
      try{
        const finviz=await fetchFinvizStockInfo(ticker,{signal:controller.signal});
        const ff=finviz?.ok?finite(finviz.freeFloat):null;
        if(ff!==null){
          job.records[ticker]={...old,freeFloat:ff,free_float:ff,freeFloatSource:'finviz-scrapingant',freeFloatUpdatedAt:new Date().toISOString()};
          job.successful++;
          await setJson(`scanner-short-record:${ticker}`,{ticker,exchange:universe?.references?.[ticker]?.primary_exchange||'',...job.records[ticker],jobId:job.jobId,index:i+1,total:job.total,savedAt:new Date().toISOString()});
        }else{
          job.records[ticker]={...old,freeFloat:finite(old.freeFloat??old.free_float),free_float:finite(old.freeFloat??old.free_float),freeFloatSource:old.freeFloatSource||null,freeFloatUpdatedAt:old.freeFloatUpdatedAt||null};
          job.failed++;
        }
      }catch(e){
        job.failed++;
        job.records[ticker]={...old,freeFloat:finite(old.freeFloat??old.free_float),free_float:finite(old.freeFloat??old.free_float),freeFloatSource:old.freeFloatSource||null,freeFloatUpdatedAt:old.freeFloatUpdatedAt||null};
      }finally{clearTimeout(timer);}
      job.cursor=i+1;
      job.lastActivityAt=new Date().toISOString();
      await setJson(JOB_KEY,job);
      if(job.cursor===1||job.cursor%5===0||job.cursor===job.total){
        await setJson(STATUS_KEY,{state:job.cursor===job.total?'publishing':'building',date,startedAt,finishedAt:null,total:job.total,done:job.cursor,successful:job.successful,failed:job.failed,currentTicker:ticker,updatedAt:job.lastActivityAt,source:'finviz-via-scrapingant'});
      }
      if(i+1<tickers.length)await sleep(Math.max(0,Number(process.env.FINVIZ_DELAY_MS||250)));
    }
  };
  await Promise.all([worker(),worker()]);
  const completedAt=new Date().toISOString();
  await setJson('scanner-finviz-float-daily-v1',{version:1,state:'ready',date,startedAt,completedAt,total:job.total,successful:job.successful,failed:job.failed,universeUpdatedAt:job.universeUpdatedAt,source:'finviz-via-scrapingant'});
  await publishFloatSnapshot(job,completedAt);
  job.active=false;
  await setJson(JOB_KEY,job);
}

main().catch(async e=>{
  const error=String(e?.stack||e?.message||e);
  console.error(error);
  await setJson(STATUS_KEY,{state:'error',date:easternDate(),finishedAt:new Date().toISOString(),error:error.slice(0,1200),source:'finviz-via-scrapingant'}).catch(()=>{});
  process.exitCode=1;
});
