import { getDataStore } from '../../lib.js';

// Ertikaz model v1
// Daily: RSI < 30.
// Cached daily/split/short fields come from the central scanner cache.
// 4H: base formation -> 5 real trading sessions -> resistance -> support retest -> liquidity sweep.
// The model is deterministic and rule-based; it does not infer intent and does not use future data
// beyond the point at which each condition is evaluated.
const MASSIVE='https://api.massive.com';
const RESULT_KEY='scanner-models-ertikaz-v1';
const STATUS_KEY='scanner-models-ertikaz-status-v1';
const HISTORY_KEY='scanner-models-ertikaz-history-v1';
const CONFIG_KEY='scanner-models-ertikaz-config-v1';
const CONCURRENCY=5;
const DEFAULT_LOOKBACK_DAYS=140;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const apiKey=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const cleanTicker=x=>String(x||'').trim().toUpperCase();
const todayET=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));
function etDate(ts){
  const n=Number(ts); if(!Number.isFinite(n))return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(n));
}
function parseDate(s){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||''));if(!m)return null;return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));}
function calendarDays(from,to){const a=parseDate(from),b=parseDate(to);return a&&b?Math.floor((b-a)/86400000):null;}
function sessionsBetween(dates,from,to){return [...new Set(dates.filter(d=>d>=from&&d<=to))].sort();}
async function massive(path){
  const k=apiKey(); if(!k)throw new Error('MASSIVE_API_KEY غير مهيأ.');
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
function normalize4h(b){
  const t=Number(b?.t),o=Number(b?.o),h=Number(b?.h),l=Number(b?.l),c=Number(b?.c),v=Number(b?.v||0);
  if(!Number.isFinite(t)||![o,h,l,c].every(Number.isFinite)||h<=0||l<=0||c<=0)return null;
  const date=etDate(t); if(!date)return null;
  return {t,date,open:o,high:h,low:l,close:c,volume:Number.isFinite(v)?v:null};
}
async function fetch4H(ticker,from,to){
  const direct=(await massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/4/hour/${from}/${to}?adjusted=true&sort=asc&limit=50000`)).results||[];
  const valid=direct.map(normalize4h).filter(Boolean);
  if(valid.length)return valid;
  // Fallback for providers/plans that do not expose native 4H aggregates.
  const one=(await massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=50000`)).results||[];
  const rows=one.map(normalize4h).filter(Boolean);
  const buckets=new Map();
  for(const b of rows){
    const dt=new Date(b.t), hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(dt));
    const bucket=Math.floor(Math.max(0,hour-4)/4)*4+4;
    const key=`${b.date}|${bucket}`; const old=buckets.get(key);
    if(!old)buckets.set(key,{...b}); else {old.high=Math.max(old.high,b.high);old.low=Math.min(old.low,b.low);old.close=b.close;old.t=b.t;}
  }
  return [...buckets.values()].sort((a,b)=>a.t-b.t);
}
async function loadHistory(t){return await getDataStore().get(`${HISTORY_KEY}:${t}`,{type:'json',consistency:'strong'}).catch(()=>null);}
async function saveHistory(t,value){await getDataStore().setJSON(`${HISTORY_KEY}:${t}`,value);}
async function getCache(){
  const store=getDataStore();
  const pointer=await store.get('scanner-cache-pointer-v2',{type:'json',consistency:'strong'}).catch(()=>null);
  if(pointer?.key){const d=await store.get(pointer.key,{type:'json',consistency:'strong'}).catch(()=>null);if(d?.ready&&Array.isArray(d.records))return d;}
  return await store.get('scanner-cache-v1',{type:'json',consistency:'strong'}).catch(()=>null)||{};
}
function rsiDaily(row){const n=Number(row?.rsi);return Number.isFinite(n)?n:null;}
function shortAvailable(row){const n=Number(row?.shortShares);return Number.isFinite(n)?n:null;}

export function detectErtikazSequence(bars,splitDate){
  const b=bars.filter(x=>x.date>=splitDate).sort((a,z)=>a.t-z.t);
  if(b.length<20)return {base:null,resistance:null,support:null,liquidity:null};
  const dates=[...new Set(b.map(x=>x.date))].sort();
  let base=null;
  // A base is a confirmed 4H swing low: it must be no higher than the 3 bars
  // before and after it, and must subsequently hold for five real trading sessions.
  for(let i=3;i<b.length-3;i++){
    const candidate=b[i];
    if(candidate.date<splitDate)continue;
    const left=b.slice(i-3,i).every(x=>x.low>=candidate.low);
    const right=b.slice(i+1,i+4).every(x=>x.low>=candidate.low);
    if(!left||!right)continue;
    const holdDates=dates.filter(d=>d>candidate.date).slice(0,5);
    if(holdDates.length<5)continue;
    const holdBars=b.filter(x=>x.date>candidate.date&&x.date<=holdDates.at(-1));
    if(!holdBars.length||holdBars.some(x=>x.low<candidate.low))continue;
    base={price:candidate.low,date:candidate.date,index:i,holdThrough:holdDates.at(-1),holdSessions:holdDates.length};
    break;
  }
  if(!base)return {base:null,resistance:null,support:null,liquidity:null};
  const resistanceLow=base.price*1.15,resistanceHigh=base.price*1.25;
  const afterHold=b.filter(x=>x.date>base.holdThrough);
  const rbar=afterHold.find(x=>x.high>=resistanceLow&&x.high<=resistanceHigh);
  if(!rbar)return {base,resistance:null,support:null,liquidity:null};
  const resistance={price:Math.max(rbar.high,resistanceLow),date:rbar.date,high:rbar.high,zoneLow:resistanceLow,zoneHigh:resistanceHigh};
  // Support retest must happen after resistance and may touch the base or sit up to 5% above it.
  const supportLow=base.price,supportHigh=base.price*1.05;
  const sbar=afterHold.filter(x=>x.t>rbar.t).find(x=>x.low>=supportLow&&x.low<=supportHigh);
  if(!sbar)return {base,resistance,support:null,liquidity:null};
  const support={price:sbar.low,date:sbar.date,zoneLow:supportLow,zoneHigh:supportHigh};
  // Liquidity sweep must occur after support retest, penetrate no more than 7% below base,
  // and recover above support in the same trading session or the immediately following session.
  const afterSupport=b.filter(x=>x.t>sbar.t);
  const uniqueDates=[...new Set(b.map(x=>x.date))].sort();
  let liquidity=null;
  for(const q of afterSupport){
    if(q.low<base.price*0.93-1e-9||q.low>=base.price)continue;
    const idx=uniqueDates.indexOf(q.date); if(idx<0)continue;
    const allowed=new Set(uniqueDates.slice(idx,idx+2));
    const recovery=afterSupport.find(x=>allowed.has(x.date)&&x.t>=q.t&&x.close>support.price);
    if(recovery){liquidity={sweepDate:q.date,sweepLow:q.low,recoveryDate:recovery.date,recoveryClose:recovery.close,maxSweepPct:((q.low/base.price)-1)*100};break;}
  }
  return {base,resistance,support,liquidity};
}

export function evaluateErtikazRules(ticker,row,bars,nowDate){
  const rsi=rsiDaily(row), short=shortAvailable(row), splitDate=String(row?.splitDate||'');
  const elapsed=calendarDays(splitDate,nowDate);
  const seq=splitDate?detectErtikazSequence(bars,splitDate):{base:null,resistance:null,support:null,liquidity:null};
  const checks=[
    {key:'rsi',label:'RSI يومي أقل من 30',passed:rsi!==null&&rsi<30,value:rsi===null?null:Number(rsi.toFixed(2)),detail:rsi===null?'RSI غير متاح':`RSI اليومي ${rsi.toFixed(2)} ${rsi<30?'أقل من 30':'ليس أقل من 30'}`},
    {key:'shortAvailable',label:'Short Available ≤ 10,000',passed:short!==null&&short<=10000,value:short,detail:short===null?'Short Available غير متاح':`${short.toLocaleString()} سهم متاح`},
    {key:'splitDays',label:'أيام منذ التقسيم 20 / 30 / 50',passed:elapsed!==null&&elapsed>=20,value:elapsed,detail:elapsed===null?'تاريخ التقسيم غير متاح':`${elapsed} يومًا منذ ${splitDate}` ,milestones:{20:elapsed!==null&&elapsed>=20,30:elapsed!==null&&elapsed>=30,50:elapsed!==null&&elapsed>=50}},
    {key:'baseHold',label:'المحافظة على القاع 5 جلسات تداول فعلية',passed:Boolean(seq.base),value:seq.base?.price??null,detail:seq.base?`قاع ${seq.base.price.toFixed(4)} — ثبت حتى ${seq.base.holdThrough} (${seq.base.holdSessions} جلسات)`: 'لم يثبت قاع لمدة 5 جلسات متتالية'},
    {key:'resistance',label:'اختبار المقاومة +15% إلى +25% من القاع',passed:Boolean(seq.resistance),value:seq.resistance?.high??null,detail:seq.resistance?`اختبار ${seq.resistance.high.toFixed(4)} — المنطقة ${seq.resistance.zoneLow.toFixed(4)} إلى ${seq.resistance.zoneHigh.toFixed(4)}`:'لم يحدث اختبار مقاومة ضمن المنطقة المحددة'},
    {key:'supportRetest',label:'العودة لاختبار الدعم دون كسر القاع وبحد أقصى +5%',passed:Boolean(seq.support),value:seq.support?.price??null,detail:seq.support?`إعادة اختبار ${seq.support.price.toFixed(4)} بعد المقاومة`:'لم تحدث إعادة اختبار للدعم بعد المقاومة'},
    {key:'liquiditySweep',label:'سحب سيولة ≤7% تحت القاع والعودة خلال جلسة أو أقل',passed:Boolean(seq.liquidity),value:seq.liquidity?.sweepLow??null,detail:seq.liquidity?`سحب إلى ${seq.liquidity.sweepLow.toFixed(4)} ثم عودة ${seq.liquidity.recoveryClose.toFixed(4)} في ${seq.liquidity.recoveryDate}`:'لم يتحقق سحب السيولة بالتسلسل المطلوب'}
  ];
  const all=checks.every(x=>x.passed);
  const name=String(row?.name||row?.companyName||row?.company_name||'');
  return {version:1,ticker,name,model:'ارتكاز',qualified:all,statusLabel:all?'ارتكاز مكتمل':'ارتكاز — شروط غير مكتملة',splitDate,elapsedDays:elapsed,rsiDaily:rsi,shortAvailable:short,base:seq.base,resistance:seq.resistance,supportRetest:seq.support,liquiditySweep:seq.liquidity,checks,passedCount:checks.filter(x=>x.passed).length,totalChecks:checks.length,last4hDate:bars.at(-1)?.date||null,bars4hCount:bars.length,updatedAt:new Date().toISOString()};
}

export async function getErtikazConfig(){const raw=await getDataStore().get(CONFIG_KEY,{type:'json',consistency:'strong'}).catch(()=>null);return{version:1,lookbackDays:Number.isFinite(Number(raw?.lookbackDays))?clamp(Number(raw.lookbackDays),60,365):DEFAULT_LOOKBACK_DAYS};}
export async function saveErtikazConfig(lookbackDays){const n=Number(lookbackDays);if(!Number.isFinite(n)||n<60||n>365)throw new Error('فترة بيانات 4 ساعات يجب أن تكون بين 60 و365 يومًا.');await getDataStore().setJSON(CONFIG_KEY,{version:1,lookbackDays:n,updatedAt:new Date().toISOString()});return getErtikazConfig();}
export async function collectErtikazData({force=false}={}){
  const store=getDataStore(),cache=await getCache(),now=todayET(),config=await getErtikazConfig();
  const rows=Array.isArray(cache?.records)?cache.records:[];
  const tickers=[...new Set(rows.map(x=>cleanTicker(x?.ticker)).filter(Boolean))];
  if(!tickers.length)return{ok:false,error:'لا توجد أسهم في الكاش المركزي.'};
  let index=0,processed=0,updated=0,unchanged=0,failed=0; const histories={};
  await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:now,total:tickers.length,processed:0,updated:0,unchanged:0,failed:0});
  const byTicker=new Map(rows.map(x=>[cleanTicker(x?.ticker),x]));
  const worker=async()=>{while(true){const i=index++;if(i>=tickers.length)return;const t=tickers[i];const row=byTicker.get(t)||{};try{
    const splitDate=String(row?.splitDate||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(splitDate))throw new Error('تاريخ التقسيم غير متاح');
    const old=await loadHistory(t); let bars=Array.isArray(old?.bars)?old.bars:[];
    const from=old?.initialized&&Array.isArray(old?.bars)&&old.bars.length>=20?(old?.lastDate||nowMinusDays(7)):splitDate;
    if(old?.initialized){
      const fresh=await fetch4H(t,from,now); const map=new Map(bars.map(x=>[x.t,x])); for(const x of fresh)map.set(x.t,x); bars=[...map.values()].sort((a,z)=>a.t-z.t); updated++; if(!fresh.length)unchanged++;
    }else{
      bars=await fetch4H(t,splitDate,now); updated++;
    }
    const cutoff=nowMinusDays(config.lookbackDays); bars=bars.filter(x=>x.date>=splitDate&&x.date>=cutoff);
    await saveHistory(t,{version:1,ticker:t,splitDate,initialized:true,bars,updatedAt:new Date().toISOString(),lastDate:bars.at(-1)?.date||null});
    histories[t]={ticker:t,row,bars};
  }catch(e){failed++;histories[t]={ticker:t,row,bars:[],error:String(e?.message||e)};}processed++;if(processed%10===0||processed===tickers.length)await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:now,total:tickers.length,processed,updated,unchanged,failed});}};
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,tickers.length)},worker)); return{ok:true,date:now,total:tickers.length,processed,updated,unchanged,failed,histories};
}
function nowMinusDays(days){return new Date(Date.now()-days*86400000).toISOString().slice(0,10);}
export async function runErtikaz({force=false}={}){
  const today=todayET(),store=getDataStore();
  if(!force){const existing=await store.get(RESULT_KEY,{type:'json',consistency:'strong'}).catch(()=>null);if(existing?.date===today)return{ok:true,skipped:true,date:today,total:Number(existing.universeTickers||0)};}
  const collected=await collectErtikazData({force}); if(!collected.ok)return collected;
  const results=[];let done=0; await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:collected.total,processed:0});
  for(const t of Object.keys(collected.histories||{})){
    const h=collected.histories[t];
    results.push(h.error?{version:1,ticker:t,model:'ارتكاز',qualified:false,statusLabel:'ارتكاز — بيانات غير مكتملة',passedCount:0,totalChecks:7,error:h.error,checks:[]} : evaluateErtikazRules(t,h.row,h.bars,today));
    done++;if(done%10===0||done===collected.total)await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:collected.total,processed:done,collection:{updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});
  }
  const payload={version:1,ready:true,date:today,updatedAt:new Date().toISOString(),universeTickers:results.length,qualifiedCount:results.filter(x=>x.qualified).length,records:results.sort((a,b)=>a.ticker.localeCompare(b.ticker)),source:'central-cache-daily-rsi-short-plus-massive-4h-sequence',components:['Daily RSI','Short Available','Calendar days since split','4H base hold 5 trading sessions','4H resistance +15% to +25%','4H support retest <=5% above base','4H liquidity sweep <=7% below base with recovery <=1 session']};
  await store.setJSON(RESULT_KEY,payload);await store.setJSON(STATUS_KEY,{state:'ready',mode:'analysis',date:today,completedAt:payload.updatedAt,total:results.length,processed:results.length,qualifiedCount:payload.qualifiedCount,collection:{updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});
  return{ok:true,date:today,total:results.length,processed:results.length,qualified:payload.qualifiedCount,updatedAt:payload.updatedAt};
}
export async function readErtikaz(){return await getDataStore().get(RESULT_KEY,{type:'json',consistency:'strong'}).catch(()=>null);}
export async function readErtikazStatus(){return await getDataStore().get(STATUS_KEY,{type:'json',consistency:'strong'}).catch(()=>null);}
