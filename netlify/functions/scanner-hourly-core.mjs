import crypto from 'node:crypto';
import { getDataStore } from '../../lib.js';
import { getUniverse } from './scanner-universe-core.mjs';
import { readBorrowCache } from './scanner-borrow-core.mjs';
import { writeDataBundle, readDataBundle } from './scanner-data-bundle.mjs';
import { readIpoCache } from './scanner-ipo-core.mjs';

const MASSIVE='https://api.massive.com';
const SUPABASE_URL=()=>String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,'');
const SUPABASE_KEY=()=>String(process.env.SUPABASE_KEY||'').trim();
const SUPABASE_TABLE=()=>String(process.env.SUPABASE_TABLE||'scanner_worker_store').trim();
async function mirrorCentralSnapshot(payload){
  const url=SUPABASE_URL(), key=SUPABASE_KEY(), table=SUPABASE_TABLE();
  if(!url||!key){console.warn('[central-supabase] SUPABASE_URL/SUPABASE_KEY not configured; Netlify central mirror skipped.');return false;}
  const response=await fetch(`${url}/rest/v1/${encodeURIComponent(table)}`,{
    method:'POST',
    headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},
    body:JSON.stringify({key:'scanner-central-cache-v1',value:payload})
  });
  if(!response.ok){const body=await response.text();throw new Error(`Supabase central mirror HTTP ${response.status}: ${body.slice(0,500)}`);}
  return true;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const key=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const iso=d=>d.toISOString().slice(0,10);

async function massive(path){
  const k=key(); if(!k) throw new Error('MASSIVE_API_KEY غير مهيأ.');
  const sep=path.includes('?')?'&':'?'; let last='';
  for(let i=0;i<4;i++){
    const r=await fetch(`${MASSIVE}${path}${sep}apiKey=${encodeURIComponent(k)}`,{headers:{accept:'application/json'}});
    const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
    if(r.ok)return d;
    last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
    if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}
    throw new Error(last);
  }
  throw new Error(last||'Massive request failed.');
}
function dateBar(b){return Number.isFinite(Number(b?.t))?new Date(Number(b.t)).toISOString().slice(0,10):null;}
function etDate(b){return Number.isFinite(Number(b?.t))?new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Number(b.t))):null;}
function rsi(v,p=14){if(v.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const c=v[i]-v[i-1];g+=Math.max(c,0);l+=Math.max(-c,0);}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const c=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(c,0))/p;al=(al*(p-1)+Math.max(-c,0))/p;}return al===0?100:100-100/(1+ag/al);}
function ma(v,p){if(v.length<p)return null;const a=v.slice(-p);return a.reduce((x,y)=>x+y,0)/p;}
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)e=(v[i]-e)*k+e;return e;}
function cci(bars,p=14){if(bars.length<p)return null;const tp=bars.map(b=>(Number(b.h)+Number(b.l)+Number(b.c))/3).slice(-p);const mean=tp.reduce((a,b)=>a+b,0)/p;const dev=tp.reduce((a,b)=>a+Math.abs(b-mean),0)/p;return dev===0?0:(tp.at(-1)-mean)/(0.015*dev);}
function dailyChange(bars){if(bars.length<2)return null;const a=Number(bars.at(-2)?.c),b=Number(bars.at(-1)?.c);return Number.isFinite(a)&&a!==0&&Number.isFinite(b)?(b-a)/a*100:null;}
function tradingDays(bars,date){return new Set(bars.map(dateBar).filter(Boolean).filter(x=>x>date)).size;}
function lowSince(bars,date){let low=Infinity,lowDate=null;for(const b of bars){const d=dateBar(b);const v=Number(b?.l);if(d&&d>=date&&Number.isFinite(v)&&v>0&&v<low){low=v;lowDate=d;}}return {low:Number.isFinite(low)?low:null,lowDate,sinceLow:lowDate?tradingDays(bars,lowDate):null};}
function fourHInfo(bars,splitDate,daily){let low=Infinity,lowDate=null,splitHigh=-Infinity;for(const b of bars){const d=etDate(b);if(!d||d<splitDate)continue;const l=Number(b.l),h=Number(b.h);if(Number.isFinite(l)&&l>0&&l<low){low=l;lowDate=d;}if(d===splitDate&&Number.isFinite(h)&&h>0)splitHigh=Math.max(splitHigh,h);}return {low4h:Number.isFinite(low)?low:null,low4hDate:lowDate,low4hDays:lowDate?tradingDays(daily,lowDate):null,split4hHigh:Number.isFinite(splitHigh)?splitHigh:null};}
function flag(info){const c=String(info?.country||'').toUpperCase();return ({US:'🇺🇸',CA:'🇨🇦',CN:'🇨🇳',HK:'🇭🇰',GB:'🇬🇧',IL:'🇮🇱',AU:'🇦🇺',JP:'🇯🇵',KR:'🇰🇷',SG:'🇸🇬',IE:'🇮🇪',BR:'🇧🇷',CH:'🇨🇭',DE:'🇩🇪',FR:'🇫🇷',NL:'🇳🇱',IN:'🇮🇳',TW:'🇹🇼'})[c]||'';}

async function daily(t,from,to){return (await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`)).results||[];}
async function fourH(t,from,to){
  const direct=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/4/hour/${from}/${to}?adjusted=true&sort=asc&limit=50000`)).results||[];
  const validDirect=direct.filter(b=>Number(b?.l)>0&&Number(b?.h)>0&&Number(b?.c)>0&&Number.isFinite(Number(b?.t)));
  if(validDirect.length)return validDirect;
  const one=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=50000`)).results||[];
  const buckets=new Map();
  for(const b of one){const d=etDate(b);if(!d)continue;const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',hour12:false}).formatToParts(new Date(Number(b.t)));const h=Number(parts.find(x=>x.type==='hour')?.value);const bucket=Math.floor(Math.max(0,h-4)/4)*4+4;const k=`${d}|${bucket}`;const old=buckets.get(k);if(!old)buckets.set(k,{t:Number(b.t),o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c)});else{old.h=Math.max(old.h,Number(b.h));old.l=Math.min(old.l,Number(b.l));old.c=Number(b.c);}}
  return [...buckets.values()].filter(b=>Number(b.l)>0&&Number(b.h)>0&&Number(b.c)>0).sort((a,b)=>a.t-b.t);
}
function marketSession(){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const h=Number(parts.find(x=>x.type==='hour')?.value||0), m=Number(parts.find(x=>x.type==='minute')?.value||0), mins=h*60+m;
  if(mins>=240&&mins<570)return 'pre';
  if(mins>=570&&mins<960)return 'regular';
  if(mins>=960&&mins<1200)return 'after';
  return 'closed';
}
async function snapshotTicker(symbol){
  const d=await massive(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`);
  return d?.ticker||d?.results?.[0]||d;
}
export async function snapshot(tickers=[]){
  const d=await massive('/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false');
  const m=new Map();
  for(const x of d.tickers||[]){
    if(!x.ticker)continue;
    const regular=Number(x.lastTrade?.p??x.day?.c??x.min?.c);
    const pre=Number(x.preMarket?.p), after=Number(x.afterHours?.p);
    if(Number.isFinite(regular)&&regular>0)m.set(String(x.ticker).toUpperCase(),{price:regular,regularPrice:regular,preMarket:Number.isFinite(pre)&&pre>0?pre:null,afterHours:Number.isFinite(after)&&after>0?after:null});
  }
  // During extended hours, verify the exact per-symbol Massive/Polygon snapshot
  // endpoint so preMarket/afterHours is used instead of yesterday's close.
  const session=marketSession();
  if((session==='pre'||session==='after')&&Array.isArray(tickers)&&tickers.length){
    let idx=0;
    const worker=async()=>{while(true){const i=idx++;if(i>=tickers.length)return;const t=String(tickers[i]).toUpperCase();try{const x=await snapshotTicker(t);const pre=Number(x?.preMarket?.p),after=Number(x?.afterHours?.p),last=Number(x?.lastTrade?.p),day=Number(x?.day?.c);const extended=session==='pre'?pre:after;const price=Number.isFinite(extended)&&extended>0?extended:(Number.isFinite(last)&&last>0?last:(Number.isFinite(day)&&day>0?day:null));if(price!=null)m.set(t,{price,regularPrice:Number.isFinite(last)&&last>0?last:day,preMarket:Number.isFinite(pre)&&pre>0?pre:null,afterHours:Number.isFinite(after)&&after>0?after:null,priceSession:session,priceSource:Number.isFinite(extended)&&extended>0?(session==='pre'?'preMarket':'afterHours'):'regular'});}catch(e){console.warn('[snapshot] ticker snapshot failed',{ticker:t,error:String(e?.message||e)});}}};
    await Promise.all(Array.from({length:Math.min(8,tickers.length)},worker));
  }
  return m;
}

async function buildTicker(t,events,refs,snap,borrow){
  const earliest=events.reduce((a,e)=>e.execution_date<a?e.execution_date:a,events[0].execution_date);
  const to=iso(new Date()), from=iso(new Date(Date.now()-370*86400000));
  let bars=await daily(t,from,to);
  if(!bars.some(b=>dateBar(b)===earliest)){
    for(const adjusted of [true,false]){try{const exact=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${earliest}/${earliest}?adjusted=${adjusted?'true':'false'}&sort=asc&limit=10`)).results||[];if(exact.length){const map=new Map(bars.map(b=>[dateBar(b),b]));for(const b of exact)map.set(dateBar(b),b);bars=[...map.values()].sort((a,b)=>a.t-b.t);}}catch{}if(bars.some(b=>dateBar(b)===earliest))break;}
  }
  const tech=bars.filter(b=>['o','h','l','c'].every(k=>Number.isFinite(Number(b[k]))));
  const closes=tech.map(b=>Number(b.c));
  const ind={rsi:rsi(closes),ma5:ma(closes,5),ma20:ma(closes,20),ema20:ema(closes,20),ema50:ema(closes,50),cci:cci(tech)};
  const change=dailyChange(tech), snapRow=snap.get(t);
  const snapPrice=Number(snapRow?.price);
  const latestClose=Number(tech.at(-1)?.c);
  const current=Number.isFinite(snapPrice)&&snapPrice>0?snapPrice:(Number.isFinite(latestClose)&&latestClose>0?latestClose:null);
  const preMarketPrice=Number.isFinite(Number(snapRow?.preMarket))&&Number(snapRow.preMarket)>0?Number(snapRow.preMarket):null;
  const afterHoursPrice=Number.isFinite(Number(snapRow?.afterHours))&&Number(snapRow.afterHours)>0?Number(snapRow.afterHours):null;
  const currentPrice=Number.isFinite(current)&&current>0?current:null;
  const closePrice=Number.isFinite(latestClose)&&latestClose>0?latestClose:null;
  const intraday=await fourH(t,earliest,to);
  const shares=Number.isFinite(Number(borrow?.shares))?Number(borrow.shares):null, fee=Number.isFinite(Number(borrow?.fee))?Number(borrow.fee):null;
  const shortState=shares!==null&&fee!==null?'ready':'unavailable';
  const rows=[];
  for(const e of events){
    const split=bars.find(b=>dateBar(b)===e.execution_date); if(!split)continue;
    const splitOpen=Number(split.o); if(!Number.isFinite(splitOpen))continue;
    const post=tech.slice(-252);
    const range={high52:post.length?Math.max(...post.map(b=>Number(b.h)).filter(Number.isFinite)):null,low52:post.length?Math.min(...post.map(b=>Number(b.l)).filter(Number.isFinite)):null};
    const low=lowSince(tech,e.execution_date), h=fourHInfo(intraday,e.execution_date,tech);
    rows.push({ticker:t,splitDate:e.execution_date,splitOpen,current,currentPrice,preMarketPrice,afterHoursPrice,closePrice,rsi:ind.rsi,ma5:ind.ma5,ma20:ind.ma20,ema20:ind.ema20,ema50:ind.ema50,cci:ind.cci,low:low.low,lowDate:low.lowDate,sinceLow:low.sinceLow,high52:range.high52,low52:range.low52,low4h:h.low4h,low4hDate:h.low4hDate,low4hDays:h.low4hDays,split4hHigh:h.split4hHigh,shortShares:shares,borrowFee:fee,freeFloat:Number.isFinite(Number(borrow?.freeFloat))?Number(borrow.freeFloat):null,free_float:Number.isFinite(Number(borrow?.freeFloat))?Number(borrow.freeFloat):null,shortDataState:shortState,shortDataSource:borrow?.source||null,shortDataUpdatedAt:borrow?.updatedAt||null,freeFloatSource:borrow?.freeFloat!=null?(borrow?.source||'chartexchange-direct-html'):null,freeFloatUpdatedAt:borrow?.freeFloat!=null?(borrow?.updatedAt||null):null,changePct:change,exchange:refs[t]?.exchange_name||refs[t]?.primary_exchange||null,primaryExchange:refs[t]?.primary_exchange||null,flag:flag(refs[t]),updatedAt:new Date().toISOString()});
  }
  return rows;
}

function coreValid(r){return ['current','splitOpen','rsi','ma5','ma20','ema20','ema50','cci','changePct'].every(k=>Number.isFinite(Number(r?.[k])));}

export async function runHourlyBuild({manual=false,force=true}={}){
  const store=getDataStore();
  if(!manual){
    const settings=await getSiteSettings().catch(()=>({auto_update_enabled:true}));
    if(settings.auto_update_enabled!==true)return {ok:true,skipped:true,reason:'automatic-updates-disabled'};
  }
  if(!manual && !force){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const wd=parts.find(x=>x.type==='weekday')?.value||'';
    const hr=Number(parts.find(x=>x.type==='hour')?.value||0);
    if(['Sat','Sun'].includes(wd)||hr<4||hr>=20)return {ok:true,skipped:true,reason:'outside-new-york-business-window'};
  }
  const old=await store.get('scanner-cache-v1',{type:'json',consistency:'strong'});
  const lock=await store.get('scanner-hourly-lock-v2',{type:'json',consistency:'strong'});
  if(!force && lock?.startedAt && Date.now()-new Date(lock.startedAt).getTime()<14*60*1000)return {ok:true,skipped:true};
  const jobId=crypto.randomUUID(), startedAt=new Date().toISOString();
  await store.setJSON('scanner-hourly-lock-v2',{jobId,startedAt});
  await store.setJSON('scanner-hourly-refresh-v1',{version:8,state:'building',jobId,startedAt,manual,phase:'تجهيز قائمة Stock Split',totalBatches:1,completedBatches:0,totalTickers:0,completedTickers:0,failedTickers:[],error:null,publishedAt:null,updatedAt:startedAt});
  try{
    const universe=await getUniverse({refresh:true,maxAgeMs:60*60*1000});
    // Full refresh means every data lane is fetched again for this publication.
    // Do not reuse the previous borrow/current snapshot as the source of truth.
    const snap=await snapshot(universe.tickers||[]);
    const borrow=await readBorrowCache();
    const borrowRecords=borrow.records||{};
    // The public researcher shows one row per ticker: if a ticker has multiple
    // split events in the 100-day window, keep only its newest split event.
    const latestByTicker=new Map();
    for(const e of universe.events||[]){
      const ticker=String(e?.ticker||'').toUpperCase();
      if(!ticker)continue;
      const oldEvent=latestByTicker.get(ticker);
      if(!oldEvent || String(e.execution_date||'')>String(oldEvent.execution_date||'')) latestByTicker.set(ticker,e);
    }
    const entries=[...latestByTicker.entries()].map(([t,e])=>[t,[e]]);
    if(!entries.length)throw new Error('قائمة Stock Split فارغة بعد بناء القائمة.');
    await store.setJSON('scanner-hourly-refresh-v1',{version:8,state:'building',jobId,startedAt,manual,phase:`جاري تحديث ${entries.length} سهمًا`,totalBatches:1,completedBatches:0,totalTickers:entries.length,completedTickers:0,failedTickers:[],error:null,publishedAt:null,updatedAt:new Date().toISOString(),universeUpdatedAt:universe.updatedAt});
    const rows=[], failed=[]; let idx=0,done=0;
    const worker=async()=>{while(true){const i=idx++;if(i>=entries.length)return;const [t,events]=entries[i];let built=null,last=null;for(let a=1;a<=3;a++){try{built=await buildTicker(t,events,universe.references||{},snap,borrowRecords[t]);if(built.length>=events.length)break;}catch(e){last=e;}if(a<3)await sleep(700*a);}if(built?.length)rows.push(...built);if(!built||built.length<events.length){failed.push({ticker:t,error:String(last?.message||`missing ${events.length-(built?.length||0)} rows`)});}done++;if(done===1||done%5===0||done===entries.length){await store.setJSON('scanner-hourly-refresh-v1',{version:8,state:'building',jobId,startedAt,manual,phase:`البيانات اليومية ${done}/${entries.length}`,totalBatches:1,completedBatches:0,totalTickers:entries.length,completedTickers:done,failedTickers:failed.slice(0,50),error:null,publishedAt:null,updatedAt:new Date().toISOString(),universeUpdatedAt:universe.updatedAt});}}};
    await Promise.all(Array.from({length:Math.min(8,entries.length)},worker));
    const unique=new Map();for(const r of rows)unique.set(`${String(r.ticker).toUpperCase()}|${r.splitDate}`,r);
    let finalRows=[...unique.values()].sort((a,b)=>String(a.splitDate).localeCompare(String(b.splitDate))||a.ticker.localeCompare(b.ticker));
    // Re-read the latest independent lanes immediately before publication. This prevents
    // a long hourly build from publishing an older short/borrow or current-price snapshot.
    const latestBorrow=await readBorrowCache();
    const latestBorrowRecords=latestBorrow?.records||{};
    const latestCurrent=await store.get('scanner-massive-current-v1',{type:'json',consistency:'strong'}).catch(()=>null);
    const currentMap=latestCurrent?.records||{};
    finalRows=finalRows.map(r=>{
      const t=String(r.ticker||'').toUpperCase();
      const b=latestBorrowRecords[t];
      const c=currentMap[t];
      let x=r;
      if(b){const bs=Number(b.shares),bf=Number(b.fee);x={...x,shortShares:Number.isFinite(bs)?bs:null,borrowFee:Number.isFinite(bf)?bf:null,freeFloat:Number.isFinite(Number(b.freeFloat??b.free_float))?Number(b.freeFloat??b.free_float):x.freeFloat,free_float:Number.isFinite(Number(b.freeFloat??b.free_float))?Number(b.freeFloat??b.free_float):x.freeFloat??x.free_float,freeFloatSource:b.freeFloat!=null?(b.source||'chartexchange-direct-html'):x.freeFloatSource,freeFloatUpdatedAt:b.freeFloat!=null?(b.updatedAt||null):x.freeFloatUpdatedAt,shortDataState:Number.isFinite(bs)&&Number.isFinite(bf)?'ready':'unavailable',shortDataSource:b.source||null,shortDataUpdatedAt:b.updatedAt||null};}
      if(c && Number.isFinite(Number(c.price)) && latestCurrent?.updatedAt && new Date(latestCurrent.updatedAt).getTime()>=new Date(startedAt).getTime()) x={...x,current:Number(c.price),changePct:Number.isFinite(Number(c.changePct))?Number(c.changePct):x.changePct,currentUpdatedAt:latestCurrent.updatedAt};
      return x;
    });
    const expected=entries.length;
    const validRows=finalRows.filter(coreValid);
    const invalid=finalRows.filter(r=>!coreValid(r));
    const validKeys=new Set(validRows.map(r=>`${String(r.ticker||'').toUpperCase()}|${r.splitDate||''}`));
    const expectedKeys=new Set(entries.map(([t,evs])=>`${String(t).toUpperCase()}|${evs[0]?.execution_date||''}`));
    const missingKeys=[...expectedKeys].filter(k=>!validKeys.has(k));
    const successfulRows=validRows.length;
    const requiredRows=Math.max(1,Math.ceil(expected*0.95));
    const successRate=expected?successfulRows/expected:0;
    console.info('[hourly-refresh] publication check', {expectedRows:expected,successfulRows,requiredRows,successRate,invalidRows:invalid.length,missingRows:missingKeys.length,failedTickers:failed.length});
    if(!successfulRows)throw new Error('لم يتم بناء أي سجل صالح من قائمة الأسهم.');
    if(successfulRows<requiredRows)throw new Error(`فشل التحديث: تم تحديث ${successfulRows} من ${expected} (${(successRate*100).toFixed(1)}%). الحد الأدنى للنشر 95%.`);
    finalRows=validRows;
    const publishedAt=new Date().toISOString();
    const versionKey=`scanner-cache-data-v2:${jobId}`;
    const ipoCache=await readIpoCache();
    const payload={version:8,ready:true,building:false,updatedAt:publishedAt,technicalUpdatedAt:publishedAt,massiveUpdatedAt:publishedAt,fullRefreshAt:publishedAt,splitsUpdatedAt:universe.updatedAt||null,windowDays:100,records:finalRows,expectedRows:entries.length,missingRows:missingKeys.length,missing:missingKeys.slice(0,100),failedTickers:failed.slice(0,50).map(x=>({ticker:x.ticker,error:x.error})),dataRefreshMode:'hourly-full-direct',sources:{daily:'massive-fresh',intraday4h:'massive-fresh',current:'massive-fresh',borrow:'chartexchange-direct-html-fresh',universe:'massive-fresh',ipos:'separate-daily-massive-cache'},ipos:ipoCache?.records||[],ipoUpdatedAt:ipoCache?.updatedAt||null,centralFile:true};
    await store.setJSON(versionKey,payload);
    await writeDataBundle(payload);
    try{
      await mirrorCentralSnapshot(payload);
      await store.setJSON('scanner-central-status-v1',{state:'ready',updatedAt:publishedAt,records:finalRows.length,ipoRecords:Array.isArray(payload.ipos)?payload.ipos.length:0,storage:'supabase'});
    }catch(e){
      console.error('[central-supabase] mirror failed; Netlify serving cache remains published',String(e?.message||e));
      await store.setJSON('scanner-central-status-v1',{state:'mirror-error',updatedAt:publishedAt,error:String(e?.message||e),records:finalRows.length,storage:'supabase'}).catch(()=>{});
    }
    await store.setJSON('scanner-cache-pointer-v2',{version:2,key:versionKey,updatedAt:publishedAt,records:finalRows.length});
    await store.setJSON('scanner-cache-v1',payload);
    await store.setJSON('scanner-cache-status',{state:'ready',jobId,startedAt:null,finishedAt:publishedAt,error:null,records:finalRows.length,tickers:entries.length,expectedRows:payload.expectedRows,missingRows:payload.missingRows,missing:payload.missing,successRate,requiredRows});
    await store.setJSON('scanner-hourly-refresh-v1',{version:8,state:'ready',jobId,startedAt:null,finishedAt:publishedAt,manual,phase:'اكتمل التحديث ونُشر الكاش الجديد',totalBatches:1,completedBatches:1,totalTickers:entries.length,completedTickers:entries.length,failedTickers:failed.slice(0,50),error:null,publishedAt,updatedAt:publishedAt,universeUpdatedAt:universe.updatedAt,successRate,requiredRows,missingRows:missingKeys.length,rowsWithBorrow:finalRows.filter(r=>r.shortDataState==='ready').length});
    return {ok:true,records:finalRows.length,tickers:entries.length,failed:failed.length,publishedAt};
  }catch(e){
    const message=String(e?.message||e||'Hourly build failed');
    await store.setJSON('scanner-cache-status',{state:'error',jobId,startedAt:null,finishedAt:new Date().toISOString(),error:message});
    await store.setJSON('scanner-hourly-refresh-v1',{version:8,state:'error',jobId,startedAt:null,finishedAt:new Date().toISOString(),phase:'فشل التحديث وتم الإبقاء على آخر كاش مكتمل',error:message,updatedAt:new Date().toISOString()});
    throw e;
  }finally{const l=await store.get('scanner-hourly-lock-v2',{type:'json',consistency:'strong'}).catch(()=>null);if(l?.jobId===jobId)await store.delete('scanner-hourly-lock-v2').catch(()=>{});}
}

export async function readPublishedCache(){
  const bundled=await readDataBundle();
  if(bundled?.ready&&Array.isArray(bundled.records))return bundled;
  const store=getDataStore();
  const p=await store.get('scanner-cache-pointer-v2',{type:'json',consistency:'strong'});
  if(p?.key){const d=await store.get(p.key,{type:'json',consistency:'strong'});if(d?.ready&&Array.isArray(d.records))return d;}
  return await store.get('scanner-cache-v1',{type:'json',consistency:'strong'});
}
