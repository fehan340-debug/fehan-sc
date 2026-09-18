import crypto from 'node:crypto';
import { store, getNetlifyStoreSafe } from './store.mjs';
import { borrowFromScraperAPI } from '../netlify/functions/chartexchange.mjs';

const JOB_KEY='scanner-borrow-job-v4';
const STATUS_KEY='scanner-borrow-status';
const TRIGGER_KEY='trigger_short_update';
const TIMEOUT_MS=4000;
const ENGINE_VERSION=7;
const finite=n=>Number.isFinite(Number(n))?Number(n):null;

async function getJson(key){return await store.get(key,{type:'json',consistency:'strong'}).catch(()=>null);}
async function getJsonWithNetlifyFallback(key){
  const supabaseValue=await getJson(key);
  if(supabaseValue!=null)return supabaseValue;
  try{
    const netlify=getNetlifyStoreSafe();
    if(!netlify)return null;
    const value=await netlify.get(key,{type:'json',consistency:'strong'});
    if(value!=null)await store.setJSON(key,value).catch(()=>{});
    return value??null;
  }catch(error){
    console.warn('[external-short-worker] Netlify fallback read failed',{key,error:String(error?.message||error)});
    return null;
  }
}
async function setJson(key,value){await store.setJSON(key,value);}

function supportedExchange(value){return ['XNAS','XNYS','XASE'].includes(String(value||'').toUpperCase());}

async function instantPublish(ticker,b,stamp){
  const pointer=await getJsonWithNetlifyFallback('scanner-cache-pointer-v2');
  const key=pointer?.key||'scanner-cache-v1';
  const base=await getJsonWithNetlifyFallback(key);
  if(!base?.ready||!Array.isArray(base.records))return;
  const rows=base.records.map(row=>{
    if(String(row.ticker||'').toUpperCase()!==ticker)return row;
    const shares=finite(b?.shares), fee=finite(b?.fee), ff=finite(b?.freeFloat??b?.free_float);
    const retained=ff!==null?ff:finite(row.freeFloat??row.free_float);
    return {...row,
      shortShares:shares,
      borrowFee:fee,
      freeFloat:retained,
      free_float:retained,
      shortDataState:shares!==null&&fee!==null?'ready':'unavailable',
      shortDataSource:b?.source||null,
      shortDataUpdatedAt:b?.updatedAt||stamp,
      freeFloatSource:ff!==null?(b?.freeFloatSource||b?.source||null):(row.freeFloatSource||null),
      freeFloatUpdatedAt:ff!==null?(b?.freeFloatUpdatedAt||stamp):(row.freeFloatUpdatedAt||null)
    };
  });
  const payload={...base,records:rows,borrowUpdatedAt:stamp,updatedAt:stamp};
  await setJson(key,payload);
  await setJson('scanner-cache-v1',payload);
  await setJson('scanner-cache-pointer-v2',{...(pointer||{}),key,updatedAt:stamp,records:rows.length});
}

async function finish(job,stamp){
  const doneUnique=job.tickers.filter(t=>job.records[t]?.state==='ready').length;
  const payload={version:5,ready:true,updatedAt:stamp,records:job.records,universeUpdatedAt:job.universeUpdatedAt||null,total:job.total,liveCount:doneUnique,missingCount:Math.max(0,job.total-doneUnique),attempts:job.attempted};
  const versionedKey=`scanner-borrow-data-v5:${job.jobId}`;
  await setJson(versionedKey,payload);
  await setJson('scanner-borrow-pointer-v2',{version:5,key:versionedKey,updatedAt:stamp,total:job.total,liveCount:doneUnique,missingCount:Math.max(0,job.total-doneUnique)});
  await setJson('scanner-borrow-v1',payload);
  await setJson('scanner-borrow-v2',payload);
  await setJson('trigger_short_update',{trigger:false,status:'complete',clearedAt:stamp,source:job.triggerSource||'external-worker',jobId:job.jobId});
  await setJson(STATUS_KEY,{state:'ready',jobId:job.jobId,startedAt:job.startedAt,finishedAt:stamp,error:null,total:job.total,done:job.total,attempts:job.attempted,successful:doneUnique,failed:Math.max(0,job.total-doneUnique),records:Object.keys(job.records).length,phase:'complete',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions'});
  await store.delete(JOB_KEY).catch(()=>{});
}

async function createJob(trigger){
  const universe=await getJsonWithNetlifyFallback('scanner-universe-v2');
  const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
  if(!tickers.length)throw new Error('لم يتم العثور على قائمة الأسهم المعتمدة للشورت في scanner-universe-v2.');
  const previous=await getJsonWithNetlifyFallback('scanner-borrow-v2');
  const records=previous?.records&&typeof previous.records==='object'?{...previous.records}:{};
  const exchangeByTicker=Object.fromEntries(tickers.map(t=>[t,String(universe?.references?.[t]?.primary_exchange||'').toUpperCase()]));
  const now=new Date().toISOString();
  const job={active:true,engineVersion:ENGINE_VERSION,jobId:crypto.randomUUID(),triggerSource:trigger?.source||'external-worker',startedAt:now,tickers,exchangeByTicker,cursor:0,attempted:0,successful:0,failed:0,records,universeUpdatedAt:universe?.updatedAt||null,total:tickers.length,lastActivityAt:now};
  await setJson(JOB_KEY,job);
  await setJson(STATUS_KEY,{state:'building',jobId:job.jobId,startedAt:now,finishedAt:null,error:null,total:job.total,done:0,attempts:0,successful:0,failed:0,records:Object.keys(records).length,phase:'one-by-one',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions'});
  return job;
}

async function processTicker(job,ticker){
  const exchange=String(job.exchangeByTicker?.[ticker]||'').toUpperCase();
  const old=job.records[ticker]||{};
  let value=null,resultOk=false,error=null;
  try{
    if(!supportedExchange(exchange))throw new Error('Missing supported exchange mapping');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
    try{value=await borrowFromScraperAPI(ticker,exchange,{signal:controller.signal});}
    finally{clearTimeout(timer);}
    resultOk=Boolean(value&&(value.shares!=null||value.fee!=null||value.freeFloat!=null||value.free_float!=null));
    if(!resultOk)error=value?.reason||'no-data';
  }catch(e){error=e?.name==='AbortError'?'scraperapi-timeout':String(e?.message||e);}
  const stamp=new Date().toISOString();
  job.attempted++;
  if(resultOk){
    job.successful++;
    const freshFloat=finite(value?.freeFloat??value?.free_float);
    const retainedFloat=freshFloat!==null?freshFloat:finite(old.freeFloat??old.free_float);
    job.records[ticker]={shares:finite(value?.shares),fee:finite(value?.fee),freeFloat:retainedFloat,free_float:retainedFloat,freeFloatSource:freshFloat!==null?(value?.source||'chartexchange-direct-html'):(old.freeFloatSource||null),freeFloatUpdatedAt:freshFloat!==null?stamp:(old.freeFloatUpdatedAt||null),updatedAt:stamp,source:value?.source||'scraperapi-chartexchange-direct-html',state:'ready'};
  }else{
    job.failed++;
    job.records[ticker]={shares:finite(old.shares),fee:finite(old.fee),freeFloat:finite(old.freeFloat??old.free_float),free_float:finite(old.freeFloat??old.free_float),freeFloatSource:old.freeFloatSource||null,freeFloatUpdatedAt:old.freeFloatUpdatedAt||null,updatedAt:old.updatedAt||null,source:old.source||'pending',state:(finite(old.shares)!==null||finite(old.fee)!==null)?'previous':'pending',lastError:error||'no-data'};
    console.warn('[external-short-worker] ticker failed',{ticker,exchange,error});
  }
  job.cursor++;
  job.lastActivityAt=stamp;
  // Durable per-ticker checkpoint in Supabase: one row/key per symbol.
  // This means a completed ticker is saved immediately and does not depend on
  // the 200-ticker batch finishing successfully.
  await setJson(`scanner-short-record:${ticker}`, {
    ticker,
    exchange,
    ...job.records[ticker],
    jobId: job.jobId,
    index: job.cursor,
    total: job.total,
    savedAt: stamp
  });
  await setJson(JOB_KEY,job);
  await instantPublish(ticker,{...job.records[ticker],updatedAt:stamp},stamp);
  const doneUnique=job.tickers.filter(t=>job.records[t]?.state==='ready').length;
  await setJson(STATUS_KEY,{state:job.cursor>=job.total?'ready':'building',jobId:job.jobId,startedAt:job.startedAt,finishedAt:job.cursor>=job.total?stamp:null,error:null,total:job.total,done:job.cursor,attempts:job.attempted,successful:doneUnique,failed:job.failed,records:Object.keys(job.records).length,phase:job.cursor>=job.total?'complete':'one-by-one',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions',currentTicker:ticker,currentIndex:job.cursor,remaining:Math.max(0,job.total-job.cursor),lastTickerAt:stamp});
  return job.cursor>=job.total;
}

async function main(){
  let trigger=await getJson(TRIGGER_KEY);
  // A manual GitHub Actions run is also allowed to start a scrape directly.
  // The website/cron path still uses the durable Supabase trigger flag.
  if(trigger?.trigger!==true && String(process.env.FORCE_SHORT_RUN||'').toLowerCase()==='true') {
    trigger={trigger:true,source:'manual-github-actions',requestedAt:new Date().toISOString()};
  }
  if(trigger?.trigger!==true){console.log('No pending short trigger.');return;}
  let job=await getJson(JOB_KEY);
  const stale=job?.active&&job.lastActivityAt&&Date.now()-new Date(job.lastActivityAt).getTime()>5*60*1000;
  if(job?.active&&stale){
    await setJson(STATUS_KEY,{state:'recovering',jobId:job.jobId,phase:'stale-job-recovery',error:'Previous worker stopped; resuming from saved cursor.',updatedAt:new Date().toISOString(),total:job.total,done:job.cursor,timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions'});
  }
  if(!job?.active||stale){
    if(stale)job={...job,active:false};
    job=await createJob(trigger);
  }
  if(job.cursor>=job.total){await finish(job,new Date().toISOString());return;}
  while(job.cursor<job.total){
    const ticker=job.tickers[job.cursor];
    const complete=await processTicker(job,ticker);
    if(complete){await finish(job,new Date().toISOString());return;}
  }
  await finish(job,new Date().toISOString());
}

main().catch(async e=>{
  const error=String(e?.stack||e?.message||e);
  console.error(error);
  await setJson(STATUS_KEY,{state:'error',phase:'worker-fatal',error:error.slice(0,1200),finishedAt:new Date().toISOString(),mode:'external-github-actions',worker:'github-actions'}).catch(()=>{});
  process.exitCode=1;
});
