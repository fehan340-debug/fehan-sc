import crypto from 'node:crypto';
import { store } from './store.mjs';
import { borrowFromScraperAPI } from '../netlify/functions/chartexchange.mjs';
import { fetchFinvizStockInfo } from './finviz.mjs';

const JOB_KEY='scanner-borrow-job-v4';
const STATUS_KEY='scanner-borrow-status';
const TRIGGER_KEY='trigger_short_update';
const TIMEOUT_MS=15000;
const ENGINE_VERSION=8;
const finite=n=>Number.isFinite(Number(n))?Number(n):null;

async function getJson(key){return await store.get(key);}
async function setJson(key,value){await store.setJSON(key,value);}

function supportedExchange(value){return ['XNAS','XNYS','XASE'].includes(String(value||'').toUpperCase());}

async function instantPublish(ticker,b,stamp){
  const key='scanner-cache-v1';
  const base=await getJson(key);
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
      freeFloatUpdatedAt:ff!==null?(b?.freeFloatUpdatedAt||stamp):(row.freeFloatUpdatedAt||null),
      finvizPrice:b?.finvizPrice!=null?b.finvizPrice:row.finvizPrice,
      finvizPreMarketPrice:b?.finvizPreMarketPrice!=null?b.finvizPreMarketPrice:row.finvizPreMarketPrice,
      finvizAfterHoursPrice:b?.finvizAfterHoursPrice!=null?b.finvizAfterHoursPrice:row.finvizAfterHoursPrice,
      finvizPriceUpdatedAt:b?.finvizPriceUpdatedAt||row.finvizPriceUpdatedAt||null,
      finvizSource:b?.finvizSource||row.finvizSource||null
    };
  });
  const payload={...base,records:rows,borrowUpdatedAt:stamp,updatedAt:stamp};
  await setJson(key,payload);
  await setJson('scanner-central-cache-v1',payload);
  await setJson('scanner-cache-pointer-v2',{version:2,key,updatedAt:stamp,records:rows.length});
}

async function finish(job,stamp){
  const targetMs=job?.publishAt?new Date(job.publishAt).getTime():0;
  if(Number.isFinite(targetMs)&&targetMs>Date.now()){
    await new Promise(resolve=>setTimeout(resolve,targetMs-Date.now()));
    stamp=new Date().toISOString();
  }
  const doneUnique=job.tickers.filter(t=>job.records[t]?.state==='ready').length;
  const payload={version:5,ready:true,updatedAt:stamp,records:job.records,universeUpdatedAt:job.universeUpdatedAt||null,total:job.total,liveCount:doneUnique,missingCount:Math.max(0,job.total-doneUnique),attempts:job.attempted};
  const versionedKey=`scanner-borrow-data-v5:${job.jobId}`;
  await setJson(versionedKey,payload);
  await setJson('scanner-borrow-pointer-v2',{version:5,key:versionedKey,updatedAt:stamp,total:job.total,liveCount:doneUnique,missingCount:Math.max(0,job.total-doneUnique)});
  await setJson('scanner-borrow-v1',payload);
  await setJson('scanner-borrow-v2',payload);
  // Publish the completed short snapshot into the same market snapshot that the
  // browser reads. This happens once at the top of the hour, not once per ticker,
  // so customers never see a half-written short dataset.
  const central=await getJson('scanner-cache-v1');
  if(central?.ready&&Array.isArray(central.records)){
    const shortMap=job.records||{};
    const mergedRecords=central.records.map(row=>{
      const ticker=String(row?.ticker||'').toUpperCase();
      const b=shortMap[ticker];
      if(!b)return row;
      const shares=finite(b.shares), fee=finite(b.fee), ff=finite(b.freeFloat??b.free_float);
      const retainedFloat=ff!==null?ff:finite(row.freeFloat??row.free_float);
      return {...row,
        shortShares:shares,
        borrowFee:fee,
        freeFloat:retainedFloat,
        free_float:retainedFloat,
        shortDataState:(shares!==null&&fee!==null)?'ready':(row.shortDataState||'unavailable'),
        shortDataSource:b.source||row.shortDataSource||null,
        shortDataUpdatedAt:b.updatedAt||row.shortDataUpdatedAt||null,
        freeFloatSource:ff!==null?(b.freeFloatSource||b.source||null):(row.freeFloatSource||null),
        freeFloatUpdatedAt:ff!==null?(b.freeFloatUpdatedAt||stamp):(row.freeFloatUpdatedAt||null),
        finvizPrice:b.finvizPrice!=null?b.finvizPrice:row.finvizPrice,
        finvizPreMarketPrice:b.finvizPreMarketPrice!=null?b.finvizPreMarketPrice:row.finvizPreMarketPrice,
        finvizAfterHoursPrice:b.finvizAfterHoursPrice!=null?b.finvizAfterHoursPrice:row.finvizAfterHoursPrice,
        finvizPriceUpdatedAt:b.finvizPriceUpdatedAt||row.finvizPriceUpdatedAt||null,
        finvizSource:b.finvizSource||row.finvizSource||null
      };
    });
    const merged={...central,records:mergedRecords,borrowUpdatedAt:stamp,shortUpdatedAt:stamp,updatedAt:central.updatedAt||stamp};
    await setJson('scanner-cache-v1',merged);
    await setJson('scanner-central-cache-v1',merged);
    await setJson('scanner-cache-pointer-v2',{version:2,key:'scanner-cache-v1',updatedAt:merged.updatedAt,records:mergedRecords.length,shortUpdatedAt:stamp});
  }
  await setJson('trigger_short_update',{trigger:false,status:'complete',clearedAt:stamp,source:job.triggerSource||'external-worker',jobId:job.jobId});
  await setJson(STATUS_KEY,{state:'ready',jobId:job.jobId,startedAt:job.startedAt,finishedAt:stamp,error:null,total:job.total,done:job.total,attempts:job.attempted,successful:doneUnique,failed:Math.max(0,job.total-doneUnique),records:Object.keys(job.records).length,phase:'complete',timeoutMs:TIMEOUT_MS,publishedAt:stamp,mode:'external-github-actions',worker:'github-actions'});
  await store.delete(JOB_KEY).catch(()=>{});
}

async function createJob(trigger){
  // The approved short universe is normally produced by the Netlify scanner.
  // Prefer scanner-universe-v2, then fall back to the dedicated short-universe
  // copy if an older deployment has not populated v2 yet.
  const universe=await getJson('scanner-universe-v2')
    || await getJson('scanner-borrow-universe-v1');
  const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
  if(!tickers.length)throw new Error('لم يتم العثور على قائمة الأسهم المعتمدة للشورت في scanner-universe-v2.');
  const previous=await getJson('scanner-borrow-v2');
  const records=previous?.records&&typeof previous.records==='object'?{...previous.records}:{};
  const exchangeByTicker=Object.fromEntries(tickers.map(t=>[t,String(universe?.references?.[t]?.primary_exchange||'').toUpperCase()]));
  const now=new Date().toISOString();
  const job={active:true,engineVersion:ENGINE_VERSION,jobId:crypto.randomUUID(),triggerSource:trigger?.source||'external-worker',startedAt:now,tickers,exchangeByTicker,cursor:0,attempted:0,successful:0,failed:0,records,universeUpdatedAt:universe?.updatedAt||null,total:tickers.length,lastActivityAt:now,publishAt:new Date(Math.ceil(Date.now()/3600000)*3600000).toISOString()};
  await setJson(JOB_KEY,job);
  await setJson(STATUS_KEY,{state:'building',jobId:job.jobId,startedAt:now,finishedAt:null,error:null,total:job.total,done:0,attempts:0,successful:0,failed:0,records:Object.keys(records).length,phase:'one-by-one',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions'});
  return job;
}

async function processTicker(job,ticker){
  const exchange=String(job.exchangeByTicker?.[ticker]||'').toUpperCase();
  const old=job.records[ticker]||{};
  let value=null,shortOk=false,error=null;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try{
    if(!supportedExchange(exchange))throw new Error('Missing supported exchange mapping');
    // Phase 1: ChartExchange only. Free Float is deliberately NOT fetched here.
    value=await borrowFromScraperAPI(ticker,exchange,{signal:controller.signal});
    shortOk=Boolean(value&&(value.shares!=null||value.fee!=null));
    if(!shortOk)error=value?.reason||'scrape-no-borrow-data';
  }catch(e){
    error=e?.name==='AbortError'?'scraperapi-timeout':String(e?.message||e);
  }finally{clearTimeout(timer);}

  const stamp=new Date().toISOString();
  job.attempted++;
  if(shortOk){
    job.successful++;
    const shares=finite(value?.shares), fee=finite(value?.fee);
    job.records[ticker]={
      ...old,
      shares,fee,
      freeFloat:finite(old.freeFloat??old.free_float),
      free_float:finite(old.freeFloat??old.free_float),
      freeFloatSource:old.freeFloatSource||null,
      freeFloatUpdatedAt:old.freeFloatUpdatedAt||null,
      updatedAt:stamp,
      source:value?.source||'scraperapi-chartexchange-direct-html',
      state:'ready',
      shortDataSource:value?.source||'scraperapi-chartexchange-direct-html',
      shortDataUpdatedAt:stamp,
      lastError:null
    };
  }else{
    job.failed++;
    job.records[ticker]={
      ...old,
      shares:finite(old.shares),fee:finite(old.fee),
      freeFloat:finite(old.freeFloat??old.free_float),free_float:finite(old.freeFloat??old.free_float),
      updatedAt:old.updatedAt||null,source:old.source||'pending',
      state:(finite(old.shares)!==null||finite(old.fee)!==null)?'previous':'pending',
      lastError:error||'no-data'
    };
    console.warn('[external-short-worker] ticker failed',{ticker,exchange,error,shortStatus:value?.status||null,shortPreview:value?.responsePreview||''});
  }
  job.cursor++;
  job.lastActivityAt=stamp;
  await setJson(`scanner-short-record:${ticker}`, {ticker,exchange,...job.records[ticker],jobId:job.jobId,index:job.cursor,total:job.total,savedAt:stamp});
  await setJson(JOB_KEY,job);
  const doneUnique=job.tickers.filter(t=>['ready','previous'].includes(job.records[t]?.state)).length;
  await setJson(STATUS_KEY,{state:job.cursor>=job.total?'ready':'building',jobId:job.jobId,startedAt:job.startedAt,finishedAt:job.cursor>=job.total?stamp:null,error:null,total:job.total,done:job.cursor,attempts:job.attempted,successful:doneUnique,failed:job.failed,records:Object.keys(job.records).length,phase:job.cursor>=job.total?'short-complete-awaiting-float':'one-by-one',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions',currentTicker:ticker,currentIndex:job.cursor,remaining:Math.max(0,job.total-job.cursor),lastTickerAt:stamp});
  return job.cursor>=job.total;
}

function easternDate(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

async function refreshDailyFinvizFloat(job){
  const today=easternDate();
  const marker=await getJson('scanner-finviz-float-daily-v1');
  if(marker?.date===today && marker?.state==='ready'){
    await setJson(STATUS_KEY,{state:'ready',jobId:job.jobId,startedAt:job.startedAt,finishedAt:new Date().toISOString(),error:null,total:job.total,done:job.total,attempts:job.attempted,successful:job.successful,failed:job.failed,records:Object.keys(job.records).length,phase:'daily-float-already-complete',timeoutMs:TIMEOUT_MS,mode:'external-github-actions',worker:'github-actions',floatDate:today,floatUpdatedAt:marker.completedAt||null});
    return marker;
  }

  const startedAt=new Date().toISOString();
  await setJson('scanner-finviz-float-status-v1',{state:'building',date:today,startedAt,finishedAt:null,total:job.total,done:0,successful:0,failed:0});
  let idx=0,successful=0,failed=0;
  const tickers=job.tickers.slice();
  const worker=async()=>{
    while(true){
      const i=idx++; if(i>=tickers.length)return;
      const ticker=tickers[i];
      const old=job.records[ticker]||{};
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
      try{
        const finviz=await fetchFinvizStockInfo(ticker,{signal:controller.signal});
        const ff=finviz?.ok?finite(finviz.freeFloat):null;
        if(ff!==null){
          job.records[ticker]={...old,freeFloat:ff,free_float:ff,freeFloatSource:'finviz',freeFloatUpdatedAt:new Date().toISOString(),finvizSource:'finviz',state:old.state||'ready'};
          successful++;
          await setJson(`scanner-short-record:${ticker}`,{ticker,exchange:job.exchangeByTicker?.[ticker]||'',...job.records[ticker],jobId:job.jobId,index:i+1,total:job.total,savedAt:new Date().toISOString()});
        }else{
          failed++;
          console.warn('[external-short-worker] finviz float failed',{ticker,status:finviz?.status||null,reason:finviz?.reason||'finviz-no-free-float'});
        }
      }catch(e){
        failed++;
        console.warn('[external-short-worker] finviz float exception',{ticker,error:e?.name==='AbortError'?'finviz-timeout':String(e?.message||e)});
      }finally{clearTimeout(timer);}
      if((i+1)===1||(i+1)%5===0||(i+1)===tickers.length){
        await setJson('scanner-finviz-float-status-v1',{state:'building',date:today,startedAt,finishedAt:null,total:tickers.length,done:i+1,successful,failed,currentTicker:ticker,updatedAt:new Date().toISOString()});
      }
    }
  };
  // Keep Finviz separate from ChartExchange and lightly parallelized to avoid a very long daily run.
  await Promise.all(Array.from({length:3},worker));
  const completedAt=new Date().toISOString();
  const markerOut={version:1,state:'ready',date:today,startedAt,completedAt,total:tickers.length,successful,failed,universeUpdatedAt:job.universeUpdatedAt||null,source:'finviz-daily'};
  await setJson('scanner-finviz-float-daily-v1',markerOut);
  await setJson('scanner-finviz-float-status-v1',markerOut);
  return markerOut;
}

async function autoUpdatesEnabled(){
  try{
    // Settings are stored in Supabase under the same key/value table.
    // Missing settings keep the worker enabled by default.
    const settings=await getJson('site-settings');
    return settings?.auto_update_enabled!==false && settings?.autoUpdateEnabled!==false;
  }catch(error){
    console.warn('[external-short-worker] Supabase site-settings read failed; keeping worker enabled.', String(error?.message||error));
    return true;
  }
}

async function main(){
  if(!(await autoUpdatesEnabled())){
    console.log('Automatic updates are disabled; external short worker will not start.');
    return;
  }
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
  if(job.cursor>=job.total){await refreshDailyFinvizFloat(job);await finish(job,new Date().toISOString());return;}
  while(job.cursor<job.total){
    const ticker=job.tickers[job.cursor];
    const complete=await processTicker(job,ticker);
    if(complete){await refreshDailyFinvizFloat(job);await finish(job,new Date().toISOString());return;}
  }
  await refreshDailyFinvizFloat(job);
  await finish(job,new Date().toISOString());
}

main().catch(async e=>{
  const error=String(e?.stack||e?.message||e);
  console.error(error);
  await setJson(STATUS_KEY,{state:'error',phase:'worker-fatal',error:error.slice(0,1200),finishedAt:new Date().toISOString(),mode:'external-github-actions',worker:'github-actions'}).catch(()=>{});
  process.exitCode=1;
});
