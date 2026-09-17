import { getDataStore } from "../../lib.js";
import { currentUser } from "../../lib.js";

const BASE="https://api.massive.com";
const KEY=()=>String(process.env.MASSIVE_API_KEY||"").trim();

async function getSnapshot(){
  const key=KEY(); if(!key) throw new Error("MASSIVE_API_KEY is not configured.");
  const r=await fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false&apiKey=${encodeURIComponent(key)}`,{headers:{accept:"application/json"}});
  const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
  if(!r.ok) throw new Error(`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`);
  return d;
}

export async function runMassiveCurrentUpdate(){
  const store=getDataStore();
  const lock=await store.get("scanner-massive-current-lock",{type:"json",consistency:"strong"}).catch(()=>null);
  if(lock?.startedAt && Date.now()-new Date(lock.startedAt).getTime()<10*60*1000) return {ok:true,alreadyRunning:true};
  const startedAt=new Date().toISOString();
  await store.setJSON("scanner-massive-current-lock",{startedAt});
  await store.setJSON("scanner-massive-current-status",{state:"building",startedAt,finishedAt:null,error:null});
  try{
    const snap=await getSnapshot(), map={};
    const updatedAt=new Date().toISOString();
    for(const x of snap.tickers||[]){
      const t=String(x.ticker||"").toUpperCase();
      const trade=Number(x.lastTrade?.p),day=Number(x.day?.c),min=Number(x.min?.c);
      const price=Number.isFinite(trade)&&trade>0?trade:(Number.isFinite(day)&&day>0?day:(Number.isFinite(min)&&min>0?min:null));
      if(!t||!Number.isFinite(price)||price<=0) continue;
      const prev=Number(x.prevDay?.c), changePct=Number(x.todaysChangePerc);
      map[t]={price,prev:Number.isFinite(prev)?prev:null,changePct:Number.isFinite(changePct)?changePct:null,updatedAt};
    }
    const pointer=await store.get("scanner-cache-pointer-v2",{type:"json",consistency:"strong"}).catch(()=>null);
    const cache=pointer?.key?await store.get(pointer.key,{type:"json",consistency:"strong"}).catch(()=>null):null;
    const fallback=cache?.ready?cache:await store.get("scanner-cache-v1",{type:"json",consistency:"strong"}).catch(()=>null);
    const records=Array.isArray(fallback?.records)?fallback.records.map(row=>{
      const live=map[String(row.ticker||"").toUpperCase()];
      return live?{...row,current:live.price,changePct:live.changePct,currentUpdatedAt:updatedAt}:row;
    }):[];
    await store.setJSON("scanner-massive-current-v1",{version:1,updatedAt,records:map});
    if(records.length&&fallback?.ready){
      const versionKey=`scanner-cache-data-v2:massive-${updatedAt.replace(/[^0-9]/g,"")}`;
      const published={...fallback,updatedAt,currentUpdatedAt:updatedAt,records};
      await store.setJSON(versionKey,published);
      await store.setJSON("scanner-cache-pointer-v2",{version:2,key:versionKey,updatedAt,records:records.length});
      await store.setJSON("scanner-cache-v1",published);
    }else{
      const { runHourlyBuild }=await import("./scanner-hourly-core.mjs");
      await runHourlyBuild({manual:true,force:true});
    }
    const finalCache=await store.get("scanner-cache-v1",{type:"json",consistency:"strong"}).catch(()=>null);
    const scannerRecords=Array.isArray(finalCache?.records)?finalCache.records.length:records.length;
    await store.setJSON("scanner-massive-current-status",{state:"ready",startedAt:null,finishedAt:updatedAt,error:null,marketTickers:Object.keys(map).length,scannerRecords});
    return {ok:true,updatedAt,marketTickers:Object.keys(map).length,scannerRecords};
  }catch(e){
    const message=String(e?.message||e||"Unknown Massive current update error");
    console.error("massive current worker failed",e);
    await store.setJSON("scanner-massive-current-status",{state:"error",startedAt:null,finishedAt:new Date().toISOString(),error:message});
    throw e;
  }finally{try{await store.delete("scanner-massive-current-lock");}catch{}}
}

export default async function(request){
  const c=await currentUser(request);
  if(!c?.user?.admin||c.maintenance||c.blocked)return new Response("Unauthorized",{status:403});
  try{const x=await runMassiveCurrentUpdate();return new Response(JSON.stringify(x),{status:202,headers:{"content-type":"application/json"}});}
  catch(e){return new Response(JSON.stringify({error:String(e?.message||e)}),{status:500,headers:{"content-type":"application/json"}});}
}
export const config={background:true};
