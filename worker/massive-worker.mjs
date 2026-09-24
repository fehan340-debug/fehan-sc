import { store } from './store.mjs';
import { runHourlyBuild, publishPreparedTechnical } from '../netlify/functions/scanner-hourly-core.mjs';
import { runAlertSweep } from '../netlify/functions/alerts.mjs';
const BASE='https://api.massive.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const finite=v=>Number.isFinite(Number(v))?Number(v):null;
async function automaticUpdatesEnabled(){
  if(String(process.env.FORCE_MASSIVE_RUN||'').toLowerCase()==='true')return true;
  const url=String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
  const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_KEY||'').trim();
  const table=String(process.env.SUPABASE_SITE_SETTINGS_TABLE||'app_site_settings_store').trim();
  if(!url||!key)return true;
  try{
    const r=await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=value&key=eq.site-settings&limit=1`,{headers:{apikey:key,Authorization:`Bearer ${key}`,'content-type':'application/json'}});
    if(!r.ok)return true;
    const rows=await r.json().catch(()=>[]); const d=rows?.[0]?.value;
    return d?.auto_update_enabled!==undefined?Boolean(d.auto_update_enabled):(d?.autoUpdateEnabled!==false);
  }catch{return true;}
}


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
function timestampMs(value){const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;if(n>1e17)return n/1e6;if(n>1e14)return n/1e3;if(n>1e11)return n;return n*1000;}
function tradeSession(ts,now=new Date()){
  const ms=timestampMs(ts);if(!ms)return null;const d=new Date(ms);
  const a=etParts(d);
  const mins=Number(a.hour)*60+Number(a.minute);if(mins>=240&&mins<570)return 'pre';if(mins>=570&&mins<960)return 'regular';if(mins>=960||mins<240)return 'after';
}
function choosePrice(x,session,now){
  const prev=finite(x?.prevDay?.c),day=finite(x?.day?.c);
  const official=session==='regular'?(prev>0?prev:null):(day>0?day:(prev>0?prev:null));
  const last=finite(x?.lastTrade?.p),lastSess=tradeSession(x?.lastTrade?.t,now),minute=finite(x?.min?.c),minuteSess=tradeSession(x?.min?.t,now),pre=finite(x?.preMarket?.p),after=finite(x?.afterHours?.p);
  const regular=official>0?official:(day>0?day:prev>0?prev:null);let price=null,source=null;
  // Session-specific live price: never substitute a different session's price.
  // In pre/after hours, use the newest trade/minute print from that same session,
  // then Massive's current extended-hours field for that session.
  if(session==='regular'){
    if(last>0&&lastSess==='regular'){price=last;source='regular';}
    else if(regular>0){price=regular;source='regularClose';}
  }else if(session==='after'){
    if(last>0&&lastSess==='after'){price=last;source='afterHours';}
    else if(minute>0&&minuteSess==='after'){price=minute;source='afterHours';}
    else if(after>0){price=after;source='afterHours';}
 }else if(session==='pre'){
  price = last || minute || pre || regular || prev || 0;
  source = 'preMarket';
}else{
    if(regular>0){price=regular;source='regularClose';}
  }
  if(!(price>0))return null;
  const ch=finite(x?.todaysChangePerc);
  return {price,regularPrice:regular,preMarket:pre>0?pre:null,afterHours:after>0?after:null,minutePrice:minute>0?minute:null,priceSession:session,priceSource:source,tradeAt:timestampMs(x?.lastTrade?.t)?new Date(timestampMs(x.lastTrade.t)).toISOString():null,prevClose:prev>0?prev:null,changePct:ch??(prev>0?(price-prev)/prev*100:null)};
}
async function snapshot(tickers){
  const key=String(process.env.MASSIVE_API_KEY||'').trim();if(!key)throw new Error('MASSIVE_API_KEY is not configured.');
  const list=[...new Set(tickers.map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];if(!list.length)return {tickers:[]};
  const url=`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false&extended=true&tickers=${encodeURIComponent(list.join(','))}`;
  let last='';
  for(let i=0;i<4;i++){
    try{
      const r=await fetch(`${url}&apiKey=${encodeURIComponent(key)}`,{headers:{accept:'application/json'}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{};}catch{}
      if(r.ok)return d;last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
      if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}throw new Error(last);
    }catch(e){if(i>=3)throw e;if(String(e?.message||'').startsWith('Massive HTTP'))throw e;last=String(e?.message||e);await sleep(700*(i+1));}
  }
  throw new Error(last||'Massive snapshot failed.');
}

async function indicator(ticker,name,window){
  const key=String(process.env.MASSIVE_API_KEY||'').trim();
  if(!key)throw new Error('MASSIVE_API_KEY is not configured.');
  const path=`/v1/indicators/${name}/${encodeURIComponent(ticker)}?timespan=day&adjusted=true&window=${window}&series_type=close&order=desc&limit=1`;
  let last='';
  for(let i=0;i<4;i++){
    try{
      const r=await fetch(`${BASE}${path}&apiKey=${encodeURIComponent(key)}`,{headers:{accept:'application/json'}});
      const text=await r.text();let d={};try{d=text?JSON.parse(text):{};}catch{}
      if(r.ok){
        const v=d?.results?.values?.[0];
        const value=finite(v?.value);
        return value!==null?{value,timestamp:v?.timestamp||null,source:`massive-${name}`} : null;
      }
      last=`Massive ${name.toUpperCase()} HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
      if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}
      return null;
    }catch(e){
      last=String(e?.message||e);
      if(i<3){await sleep(700*(i+1));continue;}
    }
  }
  console.warn(`[massive-indicator] ${ticker} ${name} failed: ${last}`);
  return null;
}

async function fetchIndicators(tickers){
  const out={}; let idx=0;
  const worker=async()=>{
    while(true){
      const i=idx++; if(i>=tickers.length)return;
      const t=tickers[i];
      const names=[['rsi',14],['sma5',5],['sma20',20],['ema20',20],['ema50',50]];
      const values=await Promise.all(names.map(([name,window])=>indicator(t,name.startsWith('sma')?'sma':name,window)));
      const row={};
      for(let j=0;j<names.length;j++){
        const [name]=names[j],v=values[j];
        if(v?.value!==null&&v?.value!==undefined)row[name]=v.value;
        if(v?.timestamp)row[`${name}At`]=v.timestamp;
      }
      if(Object.keys(row).length)out[t]={...row,source:'massive-indicators',updatedAt:new Date().toISOString()};
    }
  };
  await Promise.all(Array.from({length:Math.min(10,tickers.length)},worker));
  return out;
}

async function main(){
  if(!(await automaticUpdatesEnabled())){console.log(JSON.stringify({ok:true,skipped:true,reason:"automatic-updates-disabled"}));return;}

  // Pipeline contract:
  // 1) At :00/:05/:10/... publish the completed technical+price snapshot
  //    prepared by the previous cycle.
  // 2) Only after that publication, fetch a fresh Massive snapshot and build
  //    the next technical snapshot for the following five-minute publication.
  const publication=await publishPreparedTechnical().catch(e=>({ok:false,error:String(e?.message||e)}));
  if(publication?.error)console.warn('[massive-pipeline] previous prepared publication failed; building the next snapshot anyway.',publication.error);

  const now=new Date(),session=marketSession(now);
  const universe=await store.get('scanner-universe-v2',{type:'json',consistency:'strong'});
  const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
  if(!tickers.length)throw new Error('لا توجد قائمة أسهم معتمدة لتحديث Massive. نفّذ التحديث اليومي لقائمة Stock Split أولاً.');

  const snap=await snapshot(tickers),map={};
  for(const x of snap.tickers||[]){
    const t=String(x?.ticker||'').toUpperCase();
    if(!t)continue;
    const row=choosePrice(x,session,now);
    if(row)map[t]={...row,updatedAt:now.toISOString()};
  }
  // Server-side Massive indicators are fetched in the SAME five-minute lane
  // as the snapshot. They are passed into the technical builder as one
  // prepared snapshot so the customer never sees a half-updated cycle.
  const indicators=await fetchIndicators(tickers);
  for(const [t,ind] of Object.entries(indicators)){
    if(map[t])map[t]={...map[t],indicators:ind};
  }
  const snapMap=new Map(Object.entries(map));

  // Technical indicators are calculated in the SAME Massive five-minute
  // pipeline. The daily Stock Split/IPO universe is not refreshed here.
  const prepared=await runHourlyBuild({manual:true,force:true,snapOverride:snapMap,deferPublish:true});

  await store.setJSON('scanner-massive-current-v1',{version:3,updatedAt:now.toISOString(),session,records:map,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,indicatorTickers:Object.keys(indicators).length,technicalPreparedAt:prepared?.preparedAt||null,nextPublication:'next-five-minute-cycle'});
  await store.setJSON('scanner-current-price-v1',{version:3,updatedAt:now.toISOString(),session,records:map,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length});
  await store.setJSON('scanner-current-price-status',{state:'ready',updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,error:null});
  await store.setJSON('scanner-massive-current-status',{state:'ready',startedAt:now.toISOString(),finishedAt:new Date().toISOString(),updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,indicatorTickers:Object.keys(indicators).length,error:null,technicalPreparedAt:prepared?.preparedAt||null,publication:publication?.publishedAt||null});
  await store.setJSON('cache_status',{...(await store.get('cache_status')||{}),last_massive_update:now.toISOString(),updated_at:now.toISOString(),massive_updated_at:now.toISOString(),massive_session:session,technical_prepared_at:prepared?.preparedAt||null,technical_publication_at:publication?.publishedAt||null});
  console.log(JSON.stringify({ok:true,session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,indicatorTickers:Object.keys(indicators).length,preparedAt:prepared?.preparedAt||null,publishedPrevious:publication?.published||false,publishedAt:publication?.publishedAt||null}));
await runAlertSweep().catch(e => console.error('[alerts] sweep failed:', e));
}
main().catch(async e=>{console.error(e);await store.setJSON('scanner-current-price-status',{state:'error',updatedAt:new Date().toISOString(),error:String(e?.message||e)}).catch(()=>{});process.exitCode=1;});
