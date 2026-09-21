import { store } from './store.mjs';

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
  const ms=timestampMs(ts);if(!ms)return null;const d=new Date(ms);if(Number.isNaN(d.getTime()))return null;
  const a=etParts(d),b=etParts(now);if(a.year!==b.year||a.month!==b.month||a.day!==b.day)return null;
  const mins=Number(a.hour)*60+Number(a.minute);if(mins>=240&&mins<570)return 'pre';if(mins>=570&&mins<960)return 'regular';if(mins>=960&&mins<1200)return 'after';return null;
}
function choosePrice(x,session,now){
  const prev=finite(x?.prevDay?.c),day=finite(x?.day?.c);
  const official=session==='regular'?(prev>0?prev:null):(day>0?day:(prev>0?prev:null));
  const last=finite(x?.lastTrade?.p),lastSess=tradeSession(x?.lastTrade?.t,now),pre=finite(x?.preMarket?.p),after=finite(x?.afterHours?.p);
  const regular=official>0?official:(day>0?day:prev>0?prev:null);let price=null,source=null;
  if(session==='regular'){
    if(last>0&&lastSess==='regular'){price=last;source='regular';}
    else if(regular>0){price=regular;source='regularClose';}
    else if(after>0){price=after;source='afterHours';}
    else if(pre>0){price=pre;source='preMarket';}
  }else if(session==='after'){
    if(after>0){price=after;source='afterHours';}else if(pre>0){price=pre;source='preMarket';}else if(regular>0){price=regular;source='regularClose';}
  }else if(session==='pre'){
    if(pre>0){price=pre;source='preMarket';}else if(after>0){price=after;source='afterHours';}else if(regular>0){price=regular;source='regularClose';}
  }else{
    if(after>0){price=after;source='afterHours';}else if(pre>0){price=pre;source='preMarket';}else if(regular>0){price=regular;source='regularClose';}
  }
  if(!(price>0))return null;
  const ch=finite(x?.todaysChangePerc);
  return {price,regularPrice:regular,preMarket:pre>0?pre:null,afterHours:after>0?after:null,priceSession:session,priceSource:source,tradeAt:timestampMs(x?.lastTrade?.t)?new Date(timestampMs(x.lastTrade.t)).toISOString():null,prevClose:prev>0?prev:null,changePct:ch??(prev>0?(price-prev)/prev*100:null)};
}
async function snapshot(tickers){
  const key=String(process.env.MASSIVE_API_KEY||'').trim();if(!key)throw new Error('MASSIVE_API_KEY is not configured.');
  const list=[...new Set(tickers.map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];if(!list.length)return {tickers:[]};
  const url=`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false&tickers=${encodeURIComponent(list.join(','))}`;
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

async function main(){
  if(!(await automaticUpdatesEnabled())){console.log(JSON.stringify({ok:true,skipped:true,reason:"automatic-updates-disabled"}));return;}
  const now=new Date(),session=marketSession(now);
  const universe=await store.get('scanner-universe-v2');
  const tickers=[...new Set((universe?.tickers||[]).map(x=>String(x).toUpperCase()).filter(Boolean))].sort();
  if(!tickers.length)throw new Error('لا توجد قائمة أسهم معتمدة لتحديث Massive.');
  const snap=await snapshot(tickers),map={};
  for(const x of snap.tickers||[]){const t=String(x?.ticker||'').toUpperCase();if(!t)continue;const row=choosePrice(x,session,now);if(row)map[t]={...row,updatedAt:now.toISOString()};}
  const payload={version:2,updatedAt:now.toISOString(),session,records:map,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length};
  await store.setJSON('scanner-massive-current-v1',payload);
  await store.setJSON('scanner-current-price-v1',payload);
  await store.setJSON('scanner-current-price-status',{state:'ready',updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,error:null});
  await store.setJSON('scanner-massive-current-status',{state:'ready',startedAt:now.toISOString(),finishedAt:now.toISOString(),updatedAt:now.toISOString(),session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length,error:null});
  const pointer=await store.get('scanner-cache-pointer-v2');
  const cache=(pointer?.key?await store.get(pointer.key):null)||await store.get('scanner-cache-v1');
  if(cache?.ready&&Array.isArray(cache.records)){
    const records=cache.records.map(row=>{const live=map[String(row?.ticker||'').toUpperCase()];return live?{...row,current:live.price,currentPrice:live.price,preMarketPrice:live.preMarket,afterHoursPrice:live.afterHours,priceSession:live.priceSession,priceSource:live.priceSource,currentUpdatedAt:live.updatedAt,changePct:live.changePct}:row;});
    const merged={...cache,records,currentUpdatedAt:now.toISOString(),massiveCurrentUpdatedAt:now.toISOString()};
    await store.setJSON('scanner-cache-v1',merged);await store.setJSON('scanner-central-cache-v1',merged);
  }
  await store.setJSON('cache_status',{...(await store.get('cache_status')||{}),last_massive_update:now.toISOString(),updated_at:now.toISOString(),massive_updated_at:now.toISOString(),massive_session:session});
  console.log(JSON.stringify({ok:true,session,requestedTickers:tickers.length,updatedTickers:Object.keys(map).length}));
}
main().catch(async e=>{console.error(e);await store.setJSON('scanner-current-price-status',{state:'error',updatedAt:new Date().toISOString(),error:String(e?.message||e)}).catch(()=>{});process.exitCode=1;});
