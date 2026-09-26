import { getDataStore } from "../../lib.js";
import { currentUser } from "../../lib.js";

const BASE="https://api.massive.com";
const KEY=()=>String(process.env.MASSIVE_API_KEY||"").trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function etParts(date=new Date()){
  return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
}
function marketSession(date=new Date()){
  const p=etParts(date), mins=Number(p.hour)*60+Number(p.minute);
  if(mins>=240&&mins<570)return 'pre';
  if(mins>=570&&mins<960)return 'regular';
  if(mins>=960&&mins<1200)return 'after';
  return 'closed';
}
function timestampMs(value){
  const n=Number(value); if(!Number.isFinite(n)||n<=0)return null;
  if(n>1e17)return n/1e6;      // nanoseconds
  if(n>1e14)return n/1e3;      // microseconds
  if(n>1e11)return n;          // milliseconds
  return n*1000;               // seconds
}
function tradeSession(ts,now=new Date()){
  const ms=timestampMs(ts); if(!ms)return null;
  const d=new Date(ms); if(Number.isNaN(d.getTime()))return null;
  const a=etParts(d), b=etParts(now);
  if(a.year!==b.year||a.month!==b.month||a.day!==b.day)return null;
  const mins=Number(a.hour)*60+Number(a.minute);
  if(mins>=240&&mins<570)return 'pre';
  if(mins>=570&&mins<960)return 'regular';
  if(mins>=960&&mins<1200)return 'after';
  return null;
}
async function getSnapshot(tickers){
  const key=KEY(); if(!key) throw new Error("MASSIVE_API_KEY is not configured.");
  const wanted=[...new Set(tickers.map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];
  if(!wanted.length)return {tickers:[]};
  const CHUNK=60, merged=new Map();
  const base=`/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false&extended=true`;
  for(let start=0;start<wanted.length;start+=CHUNK){
    const chunk=wanted.slice(start,start+CHUNK);
    const path=`${base}&tickers=${encodeURIComponent(chunk.join(','))}`;
    let last='';
    for(let i=0;i<4;i++){
      const r=await fetch(`${BASE}${path}&apiKey=${encodeURIComponent(key)}`,{headers:{accept:"application/json"}});
      const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
      if(r.ok){
        for(const row of Array.isArray(d?.tickers)?d.tickers:[]){
          const t=String(row?.ticker||'').toUpperCase();
          if(t&&chunk.includes(t))merged.set(t,row);
        }
        break;
      }
      last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
      if((r.status===429||r.status>=500)&&i<3){await sleep(500*(i+1));continue;}
      throw new Error(last);
    }
  }
  return {tickers:[...merged.values()]};
}

function choosePrice(x,session,now){
  const prevClose=Number(x?.prevDay?.c);
  const dayClose=Number(x?.day?.c);
  const officialClose=session==='regular' ? (Number.isFinite(dayClose)&&dayClose>0?dayClose:(Number.isFinite(prevClose)&&prevClose>0?prevClose:null)) : (Number.isFinite(dayClose)&&dayClose>0?dayClose:(Number.isFinite(prevClose)&&prevClose>0?prevClose:null));
  const lastTrade=Number.isFinite(Number(x?.lastTrade?.p))&&Number(x.lastTrade.p)>0?Number(x.lastTrade.p):null;
  const lastTradeSess=tradeSession(x?.lastTrade?.t,now);
  const afterPrice=Number(x?.afterHours?.p);
  const prePrice=Number(x?.preMarket?.p);
  const minutePrice=Number(x?.min?.c);
  const minuteSess=tradeSession(x?.min?.t,now);
  const regularPrice=officialClose;
  const valid=v=>Number.isFinite(v)&&v>0?v:null;
  const after=valid(afterPrice);
  const pre=valid(prePrice);
  const regular=valid(regularPrice)||valid(dayClose)||valid(prevClose);
  let price=null,source=null;
  // Session-specific live price only. Never fall back to another session.
  if(session==='regular'){
    if(lastTradeSess==='regular'&&lastTrade!=null){price=lastTrade;source='regular';}
    else if(Number.isFinite(minutePrice)&&minutePrice>0&&minuteSess==='regular'){price=minutePrice;source='regular';}
  }else if(session==='after'){
    if(lastTradeSess==='after'&&lastTrade!=null){price=lastTrade;source='afterHours';}
    else if(Number.isFinite(minutePrice)&&minutePrice>0&&minuteSess==='after'){price=minutePrice;source='afterHours';}
    else if(after!=null){price=after;source='afterHours';}
  }else if(session==='pre'){
    if(lastTradeSess==='pre'&&lastTrade!=null){price=lastTrade;source='preMarket';}
    else if(Number.isFinite(minutePrice)&&minutePrice>0&&minuteSess==='pre'){price=minutePrice;source='preMarket';}
    else if(pre!=null){price=pre;source='preMarket';}
  }else if(regular!=null){
    price=regular;source='regularClose';
  }
  if(!Number.isFinite(price)||price<=0)return null;
  const changeRaw=Number(x?.todaysChangePerc);
  return {extendedPrice:price,price,current:price,currentPrice:price,regularPrice:regular,preMarket:pre,afterHours:after,priceSession:session,priceSource:source,tradeAt:timestampMs(x?.lastTrade?.t)?new Date(timestampMs(x.lastTrade.t)).toISOString():null,prevClose:Number.isFinite(prevClose)&&prevClose>0?prevClose:null,changePct:Number.isFinite(changeRaw)?changeRaw:(Number.isFinite(prevClose)&&prevClose>0?(price-prevClose)/prevClose*100:null)};
}

export async function runMassiveCurrentUpdate(){
  const store=getDataStore();
  const lock=await store.get("scanner-massive-current-lock",{type:"json",consistency:"strong"}).catch(()=>null);
  if(lock?.startedAt&&Date.now()-new Date(lock.startedAt).getTime()<90*1000)return {ok:true,alreadyRunning:true};
  const startedAt=new Date().toISOString();
  await store.setJSON("scanner-massive-current-lock",{startedAt});
  await store.setJSON("scanner-massive-current-status",{state:"building",startedAt,finishedAt:null,error:null});
  try{
    const universe=await store.get('scanner-universe-v2',{type:'json',consistency:'strong'}).catch(()=>null);
    const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))];
    if(!tickers.length)throw new Error('لا توجد قائمة أسهم معتمدة لتحديث الأسعار الحالية.');
    const now=new Date(), session=marketSession(now), snap=await getSnapshot(tickers), map={};
    for(const x of snap.tickers||[]){
      const t=String(x?.ticker||'').toUpperCase(); if(!t)continue;
      const row=choosePrice(x,session,now); if(row)map[t]={...row,updatedAt:now.toISOString(),quoteState:'fresh'};
    }
    const previous=await store.get('scanner-current-price-v1',{type:'json',consistency:'strong'}).catch(()=>null);
    const previousRecords=previous?.records&&typeof previous.records==='object'?previous.records:{};
    for(const t of tickers){
      if(map[t])continue;
      const old=previousRecords[t], oldPrice=Number(old?.extendedPrice);
      const oldAt=old?.updatedAt?new Date(old.updatedAt):null;
      const nowEt=etParts(now), oldEt=oldAt?etParts(oldAt):null;
      const sameEtDate=Boolean(oldEt&&nowEt&&oldEt.year===nowEt.year&&oldEt.month===nowEt.month&&oldEt.day===nowEt.day);
      if(Number.isFinite(oldPrice)&&oldPrice>0&&String(old?.priceSession||'')===session&&sameEtDate){
        map[t]={...old,quoteState:'carried-forward',staleSince:old?.staleSince||now.toISOString()};
      }
    }
    const payload={version:3,updatedAt:now.toISOString(),session,records:map,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,missingTickers:tickers.filter(t=>!map[t]).length};
    await store.setJSON('scanner-massive-current-v1',payload);
    await store.setJSON('scanner-current-price-v1',payload);
    await store.setJSON('scanner-current-price-status',{state:'ready',updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,error:null});
    // Keep the persistent scanner snapshot's current field fresh as well. This is
    // not the customer-facing edge response; the lightweight current endpoint
    // below is used for sub-minute UI refreshes.
    const pointer=await store.get("scanner-cache-pointer-v2",{type:"json",consistency:"strong"}).catch(()=>null);
    const cache=pointer?.key?await store.get(pointer.key,{type:"json",consistency:"strong"}).catch(()=>null):await store.get("scanner-cache-v1",{type:"json",consistency:"strong"}).catch(()=>null);
    if(cache?.ready&&Array.isArray(cache.records)){
      const records=cache.records.map(row=>{const live=map[String(row?.ticker||'').toUpperCase()];return live?{...row,current:live.price,currentPrice:live.price,preMarketPrice:live.preMarket,afterHoursPrice:live.afterHours,priceSession:live.priceSession,priceSource:live.priceSource,currentUpdatedAt:live.updatedAt,changePct:live.changePct}:row;});
      const merged={...cache,records,currentUpdatedAt:now.toISOString(),massiveCurrentUpdatedAt:now.toISOString()};
      await store.setJSON('scanner-cache-v1',merged);
    }
    const result={ok:true,updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length};
    return result;
  }catch(e){
    const message=String(e?.message||e||"Unknown Massive current update error");
    console.error("massive current worker failed",e);
    await store.setJSON("scanner-massive-current-status",{state:"error",startedAt:null,finishedAt:new Date().toISOString(),error:message});
    await store.setJSON("scanner-current-price-status",{state:"error",updatedAt:new Date().toISOString(),error:message});
    throw e;
  }finally{try{await store.delete("scanner-massive-current-lock");}catch{}}
}

export default async function(request){
  const c=await currentUser(request);
  if(!c?.user?.admin||c.maintenance||c.blocked)return new Response("Unauthorized",{status:403});
  try{
    // This function is deployed as a Netlify background function. Start the
    // durable job and return immediately so the admin button never waits for
    // the full Massive scan. Status is polled from Supabase by the UI.
    void runMassiveCurrentUpdate().catch(error=>console.error('[massive-current-background]',error));
    return new Response(JSON.stringify({ok:true,started:true,status:'building'}),{status:202,headers:{"content-type":"application/json"}});
  }catch(e){return new Response(JSON.stringify({error:String(e?.message||e)}),{status:500,headers:{"content-type":"application/json"}});}
}
export const config={background:true};
