import { getDataStore } from '../../lib.js';

const MASSIVE='https://api.massive.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const key=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const iso=d=>d.toISOString().slice(0,10);
const BAD_TYPES=new Set(['ETF','ETN','ETV','ETC','FUND','MUTUALFUND','WARRANT','RIGHT','BOND','NOTE','DEBENTURE','INDEX','STRUCTURED']);
const ALLOWED_EXCHANGES=new Set(['XNAS','XNYS','XASE']);
const EXCHANGE_NAMES={XNAS:'NASDAQ',XNYS:'NYSE',XASE:'NYSE American'};
function normalizeExchange(value){const v=String(value||'').trim().toUpperCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ');if(['XNAS','NASDAQ','NASDAQ GLOBAL SELECT MARKET','NASDAQ GLOBAL MARKET','NASDAQ CAPITAL MARKET'].includes(v))return 'XNAS';if(['XNYS','NYSE','NEW YORK STOCK EXCHANGE'].includes(v))return 'XNYS';if(['XASE','AMEX','NYSE AMERICAN','NYSEAMERICAN','NYSE ARCA','NYSE ARCA EXCHANGE','ARCA'].includes(v))return 'XASE';return '';}

async function massive(path){
  const k=key();
  if(!k) throw new Error('MASSIVE_API_KEY غير مهيأ.');
  const sep=path.includes('?')?'&':'?';
  let last='';
  for(let i=0;i<4;i++){
    const r=await fetch(`${MASSIVE}${path}${sep}apiKey=${encodeURIComponent(k)}`,{headers:{accept:'application/json'}});
    const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
    if(r.ok) return d;
    last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
    if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}
    throw new Error(last);
  }
  throw new Error(last||'Massive request failed.');
}

function eligibleRef(x,ticker){
  const type=String(x?.type||'').toUpperCase().trim();
  const name=String(x?.name||'').toUpperCase();
  const primary=normalizeExchange(x?.primary_exchange||x?.exchange||x?.exchange_name);
  if(!ticker || !ALLOWED_EXCHANGES.has(primary)) return false;
  if(BAD_TYPES.has(type)) return false;
  if(/\b(ETF|ETN|WARRANT|RIGHTS?|BOND|NOTE|DEBENTURE|FUND)\b/.test(name)) return false;
  return true;
}

export async function refreshUniverse(){
  const store=getDataStore();
  const startedAt=new Date().toISOString();
  await store.setJSON('scanner-universe-status-v2',{state:'building',startedAt,finishedAt:null,error:null,events:0,tickers:0});
  try{
    const previous=await store.get('scanner-universe-v2',{type:'json',consistency:'strong'}).catch(()=>null);
    const previousTickers=[...new Set((previous?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
    const to=new Date(), from=new Date(to.getTime()-100*86400000);
    let next=`/stocks/v1/splits?execution_date.gte=${iso(from)}&execution_date.lte=${iso(to)}&sort=execution_date.asc&limit=5000`;
    const raw=[];
    while(next){
      const d=await massive(next);
      if(Array.isArray(d.results)) raw.push(...d.results);
      if(!d.next_url) break;
      const u=new URL(d.next_url); u.searchParams.delete('apiKey'); next=u.pathname+u.search;
    }
    const splitEvents=raw.map(x=>({ticker:String(x?.ticker||'').trim().toUpperCase(),execution_date:String(x?.execution_date||''),adjustment_type:String(x?.adjustment_type||x?.split_type||'split'),exchange:normalizeExchange(x?.primary_exchange||x?.exchange||x?.exchange_name)||null,split_from:x?.split_from??null,split_to:x?.split_to??null})).filter(x=>x.ticker&&/^\d{4}-\d{2}-\d{2}$/.test(x.execution_date));
    const tickers=[...new Set(splitEvents.map(x=>x.ticker))].sort();
    if(!tickers.length) throw new Error('Massive لم تُرجع أي Stock Split خلال آخر 100 يوم.');

    const refs={}; let idx=0; let good=0;
    const worker=async()=>{while(true){const i=idx++;if(i>=tickers.length)return;const t=tickers[i];try{const d=await massive(`/v3/reference/tickers/${encodeURIComponent(t)}`);const x=d?.results||{};if(eligibleRef(x,t)){const primary=normalizeExchange(x?.primary_exchange||x?.exchange||x?.exchange_name);refs[t]={ticker:t,primary_exchange:primary,type:x.type||null,exchange_name:EXCHANGE_NAMES[primary]||primary,country:x.country||x.address?.country||x.country_code||x.address?.country_code||null};good++;}}catch(e){console.warn('universe reference failed',t,e?.message||e);}}};
    await Promise.all(Array.from({length:Math.min(8,tickers.length)},worker));
    const events=splitEvents.filter(x=>refs[x.ticker]);
    const eligible=[...new Set(events.map(x=>x.ticker))].sort();
    if(!eligible.length) throw new Error(`وجدت ${tickers.length} أحداث تقسيم لكن لم ينجح تحقق أي سهم ضمن NASDAQ أو NYSE أو NYSE American.`);

    // Supabase holds one authoritative universe row. Every refresh synchronizes
    // that row: new tickers are added, existing tickers are refreshed, and tickers
    // outside the rolling 100-day window disappear from the row.
    const previousSet=new Set(previousTickers), currentSet=new Set(eligible);
    const addedTickers=eligible.filter(t=>!previousSet.has(t));
    const removedTickers=previousTickers.filter(t=>!currentSet.has(t));
    const updatedTickers=eligible.filter(t=>previousSet.has(t));
    const updatedAt=new Date().toISOString();
    const payload={version:4,source:'massive-stock-splits',updatedAt,windowDays:100,syncMode:'add-update-remove',events,tickers:eligible,references:Object.fromEntries(eligible.map(t=>[t,refs[t]])),referenceCount:good,previousCount:previousTickers.length,addedCount:addedTickers.length,updatedCount:updatedTickers.length,removedCount:removedTickers.length,addedTickers,removedTickers};

    // Publish the authoritative universe row first. Only after it succeeds do we
    // clean obsolete per-ticker short checkpoints for symbols that left the 100-day window.
    await store.setJSON('scanner-universe-v2',payload);
    if(removedTickers.length){
      await Promise.all(removedTickers.map(t=>store.delete(`scanner-short-record:${t}`).catch(()=>{})));
    }
    await store.setJSON('scanner-splits-v1',payload);
    await store.setJSON('scanner-borrow-universe-v1',{version:3,source:'scanner-universe-v2',updatedAt,tickers:eligible,references:payload.references});
    await store.setJSON('scanner-universe-status-v2',{state:'ready',startedAt:null,finishedAt:updatedAt,error:null,events:events.length,tickers:eligible.length,updatedAt,addedCount:addedTickers.length,updatedCount:updatedTickers.length,removedCount:removedTickers.length,addedTickers,removedTickers});
    await store.setJSON('scanner-splits-status',{state:'ready',startedAt:null,finishedAt:updatedAt,error:null,events:events.length,tickers:eligible.length,updatedAt,addedCount:addedTickers.length,updatedCount:updatedTickers.length,removedCount:removedTickers.length});
    console.info('[universe-refresh] synchronized Supabase universe',{events:events.length,eligible:eligible.length,added:addedTickers.length,updated:updatedTickers.length,removed:removedTickers.length});
    return payload;
  }catch(e){
    const message=String(e?.message||e||'Universe refresh failed');
    await store.setJSON('scanner-universe-status-v2',{state:'error',startedAt:null,finishedAt:new Date().toISOString(),error:message});
    throw e;
  }
}

export async function getUniverse({refresh=false,maxAgeMs=6*60*60*1000}={}){
  const store=getDataStore();
  let cached=await store.get('scanner-universe-v2',{type:'json',consistency:'strong'});
  const fresh=cached?.updatedAt && Date.now()-new Date(cached.updatedAt).getTime()<maxAgeMs && Array.isArray(cached.tickers)&&cached.tickers.length;
  if(cached?.tickers?.length && !refresh && fresh) return cached;
  try{return await refreshUniverse();}catch(e){
    if(cached?.tickers?.length) return {...cached,stale:true,staleReason:String(e?.message||e)};
    // Last-resort recovery from the customer-visible cache. This means a missing
    // universe can never be caused by a transient Massive failure after a cache exists.
    const cache=await store.get('scanner-cache-v1',{type:'json',consistency:'strong'});
    const rows=Array.isArray(cache?.records)?cache.records:[];
    const tickers=[...new Set(rows.map(r=>String(r?.ticker||'').toUpperCase()).filter(Boolean))].sort();
    if(tickers.length){
      const events=tickers.map(t=>({ticker:t,execution_date:String(rows.find(r=>String(r?.ticker||'').toUpperCase()===t)?.splitDate||''),adjustment_type:String(rows.find(r=>String(r?.ticker||'').toUpperCase()===t)?.adjustment_type||'split')})).filter(x=>x.execution_date);
      const fallback={version:2,source:'scanner-cache-fallback',updatedAt:cache.updatedAt||new Date().toISOString(),windowDays:100,tickers,events,references:Object.fromEntries(tickers.map(t=>{const row=rows.find(r=>String(r?.ticker||'').toUpperCase()===t);const ex=String(row?.primaryExchange||row?.primary_exchange||'').toUpperCase();return [t,{ticker:t,primary_exchange:ex||null,exchange_name:ex==='XNAS'?'NASDAQ':ex==='XNYS'?'NYSE':ex==='XASE'?'NYSE American':ex||null}]}))};
      await store.setJSON('scanner-universe-v2',fallback);
      return {...fallback,stale:true,staleReason:String(e?.message||e)};
    }
    throw new Error(`لا توجد قائمة أسهم محفوظة ويمكن إعادة بنائها الآن: ${String(e?.message||e)}`);
  }
}
