import { getDataStore } from '../../lib.js';

// Wyckoff engine v2: batch collection + batch analysis. The UI only reads cached results.
const MASSIVE='https://api.massive.com';
const HISTORY_KEY='scanner-models-wyckoff-history-v2';
const RESULT_KEY='scanner-models-wyckoff-v2';
const STATUS_KEY='scanner-models-wyckoff-status-v2';
const WINDOW=100;
const CONCURRENCY=5;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const apiKey=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const cleanTicker=x=>String(x||'').trim().toUpperCase();
const todayET=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function afterHoursEnded(){
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(new Date());
  const g=t=>p.find(x=>x.type===t)?.value||''; const m=Number(g('hour'))*60+Number(g('minute'));
  return !['Sat','Sun'].includes(g('weekday')) && m>=1200;
}
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
const barDate=b=>Number.isFinite(Number(b?.t))?new Date(Number(b.t)).toISOString().slice(0,10):String(b?.date||'');
function normalizeBar(b){const o=Number(b?.o),h=Number(b?.h),l=Number(b?.l),c=Number(b?.c),v=Number(b?.v);if(!barDate(b)||![o,h,l,c,v].every(Number.isFinite)||h<=0||l<=0||c<=0)return null;return{date:barDate(b),open:o,high:h,low:l,close:c,volume:v};}
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function sma(a,n){return a.length<n?null:avg(a.slice(-n));}
function stdev(a){if(a.length<2)return 0;const m=avg(a);return Math.sqrt(avg(a.map(x=>(x-m)**2))||0);}
function slope(a){if(a.length<3)return 0;const n=a.length,mx=(n-1)/2,my=avg(a);let num=0,den=0;for(let i=0;i<n;i++){num+=(i-mx)*(a[i]-my);den+=(i-mx)**2;}return den?num/den:0;}
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,Number(x)||0));
function range(bars){const hi=Math.max(...bars.map(x=>x.high)),lo=Math.min(...bars.map(x=>x.low)),mid=(hi+lo)/2;return{hi,lo,mid,width:mid?((hi-lo)/mid)*100:0};}
function loc(b){return (b.close-b.low)/Math.max(.0001,b.high-b.low);}
function swings(bars){
  const out=[]; for(let i=2;i<bars.length-2;i++){const b=bars[i], left=bars.slice(i-2,i),right=bars.slice(i+1,i+3);if(b.high>Math.max(...left.map(x=>x.high),...right.map(x=>x.high)))out.push({type:'high',i,date:b.date,price:b.high});if(b.low<Math.min(...left.map(x=>x.low),...right.map(x=>x.low)))out.push({type:'low',i,date:b.date,price:b.low});}
  return out;
}
function vsa(bars,i){
  const b=bars[i], prior=bars.slice(Math.max(0,i-20),i); if(!b||prior.length<8)return null;
  const avSpread=avg(prior.map(x=>x.high-x.low))||1,avVol=avg(prior.map(x=>x.volume))||1,spread=b.high-b.low;
  const effort=b.volume/avVol,result=spread/avSpread,cl=loc(b);
  return {effort:Number(effort.toFixed(2)),result:Number(result.toFixed(2)),closeLocation:Number(cl.toFixed(2)),wide:result>=1.35,narrow:result<=.75,highVolume:effort>=1.5,lowVolume:effort<=.7,effortResult:(effort>=1.4&&result<=.8)?'high-effort-low-result':(effort>=1.4&&result>=1.35?'high-effort-high-result':null)};
}
function detectEvents(bars,structure){
  const events=[], start=Math.max(5,bars.length-45), avVol=avg(bars.slice(-30).map(x=>x.volume))||1;
  for(let i=start;i<bars.length;i++){
    const b=bars[i], before=bars.slice(Math.max(0,i-20),i); if(before.length<5)continue;
    const r=range(before), v=vsa(bars,i); if(!v)continue;
    if(b.low<r.lo*.995&&b.close>r.lo&&loc(b)>.65&&v.highVolume)events.push({type:'spring-like',date:b.date,description:'كسر هابط للنطاق ثم استعادة مع جهد/نتيجة داعمة',confidence:clamp(60+v.effort*8+(loc(b)-.65)*80)});
    if(b.high>r.hi*1.005&&b.close<r.hi&&loc(b)<.35&&v.highVolume)events.push({type:'utad-like',date:b.date,description:'اختراق صاعد للنطاق ثم فشل داخله مع جهد/نتيجة داعمة',confidence:clamp(60+v.effort*8+(.35-loc(b))*80)});
    const priorHigh=Math.max(...before.map(x=>x.high)),priorLow=Math.min(...before.map(x=>x.low));
    if(b.close>priorHigh*1.002&&v.highVolume&&loc(b)>.6)events.push({type:'sos-like',date:b.date,description:'Sign of Strength: خروج صاعد مدعوم بالجهد والنتيجة',confidence:clamp(55+v.effort*10+loc(b)*25)});
    if(b.close<priorLow*.998&&v.highVolume&&loc(b)<.4)events.push({type:'sow-like',date:b.date,description:'Sign of Weakness: خروج هابط مدعوم بالجهد والنتيجة',confidence:clamp(55+v.effort*10+(1-loc(b))*25)});
    if(v.effortResult==='high-effort-low-result')events.push({type:'effort-vs-result',date:b.date,description:'جهد مرتفع مع نتيجة سعرية محدودة — علامة تستحق الاختبار',confidence:clamp(55+(v.effort*10))});
  }
  const seen=new Set();return events.filter(e=>{const k=e.type+e.date;if(seen.has(k))return false;seen.add(k);return true;}).slice(-20);
}
function pfCauseEffect(bars){
  const r=range(bars.slice(-60)), box=Math.max(.01,r.width/100*r.mid/3); const boxes=Math.max(1,Math.round((r.hi-r.lo)/box));
  const targetUp=r.hi+boxes*box,targetDown=r.lo-boxes*box;
  return {method:'box-count-proxy',rangeHigh:r.hi,rangeLow:r.lo,boxSize:Number(box.toFixed(4)),count:boxes,upObjective:Number(targetUp.toFixed(2)),downObjective:Number(targetDown.toFixed(2)),note:'تقدير Cause/Effect تقريبي؛ ليس عدّ P&F كلاسيكيًا كاملاً.'};
}
function relativeStrength(bars){
  const closes=bars.map(x=>x.close),ret=n=>n<closes.length?closes.at(-1)/closes.at(-1-n)-1:null;return{ret20:ret(20),ret60:ret(60),trend20:slope(closes.slice(-20)),trend60:slope(closes.slice(-60))};
}
function phaseState(bars,events){
  const r=range(bars.slice(-60)), c=bars.at(-1), ma20=sma(bars.map(x=>x.close),20), recent=bars.slice(-20), recentRange=range(recent), position=(c.close-r.lo)/Math.max(.0001,r.hi-r.lo);
  const spring=events.some(e=>e.type==='spring-like'),ut=events.some(e=>e.type==='utad-like'),sos=events.some(e=>e.type==='sos-like'),sow=events.some(e=>e.type==='sow-like');
  if(spring)return {phase:'C',label:'Phase C — اختبار/تأثير Spring محتمل'};
  if(ut)return {phase:'C',label:'Phase C — اختبار/تأثير UT/UTAD محتمل'};
  if(sos&&position>.5)return {phase:'D',label:'Phase D — SOS / انتقال نحو Markup'};
  if(sow&&position<.5)return {phase:'D',label:'Phase D — SOW / انتقال نحو Markdown'};
  if(recentRange.width<r.width*.75&&Math.abs(slope(recent.map(x=>x.close)))/Math.max(.01,c.close)<.003)return {phase:'B',label:'Phase B — بناء السبب داخل النطاق'};
  if(position>.65&&c.close>ma20)return {phase:'E',label:'Phase E — اتجاه صاعد/Markup محتمل'};
  if(position<.35&&c.close<ma20)return {phase:'E',label:'Phase E — اتجاه هابط/Markdown محتمل'};
  return {phase:'A/B',label:'Phase A/B — تكوين نطاق/تغير سلوك'};
}
function analyze(ticker,bars){
  const b=bars.slice(-WINDOW);if(b.length<60)return{ticker,stage:'غير كافٍ',stageLabel:'بيانات غير كافية',stageFit:0,barsCount:b.length,lastDate:b.at(-1)?.date||null,events:[],manipulationLike:null};
  const closes=b.map(x=>x.close),vols=b.map(x=>x.volume),ma20=sma(closes,20),ma50=sma(closes,50),r60=range(b.slice(-60)),r20=range(b.slice(-20)),prior=b.slice(-60,-20),priorSlope=slope(prior.map(x=>x.close)),s20=slope(closes.slice(-20)),s60=slope(closes.slice(-60));
  const events=detectEvents(b,{r60}),phase=phaseState(b,events),rs=relativeStrength(b),pf=pfCauseEffect(b),recentVsa=b.slice(-15).map((_,j)=>vsa(b,b.length-15+j)).filter(Boolean);
  const spring=events.some(e=>e.type==='spring-like'),utad=events.some(e=>e.type==='utad-like'),sos=events.some(e=>e.type==='sos-like'),sow=events.some(e=>e.type==='sow-like');
  const rangeTight=r20.width<r60.width*.78, up=s20>0&&s60>0&&closes.at(-1)>ma20&&ma20>ma50, down=s20<0&&s60<0&&closes.at(-1)<ma20&&ma20<ma50;
  const scores={
    accumulation:[priorSlope<0,rangeTight,Math.abs(s20)<Math.abs(priorSlope)*.8,spring,sos,phase.phase==='B'||phase.phase==='C',recentVsa.some(x=>x.effortResult==='high-effort-low-result')].filter(Boolean).length,
    distribution:[priorSlope>0,rangeTight,Math.abs(s20)<Math.abs(priorSlope)*.8,utad,sow,phase.phase==='B'||phase.phase==='C',recentVsa.some(x=>x.effortResult==='high-effort-low-result')].filter(Boolean).length,
    markup:[up,ma20>ma50,s60>0,closes.at(-1)>r60.mid,closes.slice(-10).at(-1)>closes.slice(-10)[0],sos,rs.ret60!==null&&rs.ret60>0].filter(Boolean).length,
    markdown:[down,ma20<ma50,s60<0,closes.at(-1)<r60.mid,closes.slice(-10).at(-1)<closes.slice(-10)[0],sow,rs.ret60!==null&&rs.ret60<0].filter(Boolean).length
  };
  const stage=Object.entries(scores).sort((a,z)=>z[1]-a[1])[0][0];
  const max=7, stageFit=Math.round(scores[stage]/max*100);
  const manipulationLike=stage==='accumulation'&&spring?'Spring/Shakeout-like (سلوك سعري محتمل)':stage==='distribution'&&utad?'UT/UTAD-like (سلوك سعري محتمل)':null;
  const componentSummary={
    vsa:{name:'VSA',evidence:recentVsa.slice(-5)},
    swing:{name:'Swing-by-Swing',evidence:swings(b).slice(-10)},
    phase:{name:'Phase A-E',evidence:phase},
    events:{name:'Spring/UTAD + Tests',evidence:events.filter(e=>['spring-like','utad-like'].includes(e.type))},
    pointAndFigure:{name:'Cause/Effect',evidence:pf},
    relativeStrength:{name:'Relative Strength',evidence:rs},
    choch:{name:'Change of Character',evidence:(up&&priorSlope<=0)?'bullish':(down&&priorSlope>=0)?'bearish':'none'},
    effortResult:{name:'Effort vs Result',evidence:recentVsa.filter(x=>x.effortResult).slice(-6)}
  };
  const chart=b.map((x,i)=>({date:x.date,close:Number(x.close.toFixed(4)),volume:x.volume,stage:i<b.length-60?'context':stage}));
  return{version:2,ticker,stage,stageLabel:{markdown:'هبوط — Markdown',accumulation:'تجميع — Accumulation',markup:'صعود — Markup',distribution:'تصريف — Distribution'}[stage],stageFit,stageScores:scores,phase,manipulationLike,events,components:componentSummary,chart,pointAndFigure:pf,lastClose:closes.at(-1),ma20,ma50,lastDate:b.at(-1).date,barsCount:b.length,updatedAt:new Date().toISOString()};
}
async function getCache(){return await getDataStore().get('scanner-cache-v1',{type:'json',consistency:'strong'})||{};}
async function loadHistory(t){return await getDataStore().get(`${HISTORY_KEY}:${t}`,{type:'json',consistency:'strong'})||null;}
async function saveHistory(t,v){await getDataStore().setJSON(`${HISTORY_KEY}:${t}`,v);}
export async function collectWyckoffData({includeHistories=false}={}){
  const store=getDataStore(),today=todayET(),cache=await getCache();const tickers=[...new Set((cache.records||[]).map(x=>cleanTicker(x?.ticker)).filter(Boolean))];
  if(!tickers.length)return{ok:false,error:'لا توجد أسهم في scanner-cache-v1.'};
  let index=0,processed=0,initialized=0,updated=0,unchanged=0,failed=0;const histories={};
  await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:today,startedAt:new Date().toISOString(),total:tickers.length,processed:0,initialized:0,updated:0,unchanged:0,failed:0});
  const worker=async()=>{while(true){const i=index++;if(i>=tickers.length)return;const t=tickers[i];try{const old=await loadHistory(t);let bars=Array.isArray(old?.bars)?old.bars:[];if(!old?.initialized){const from=new Date(Date.now()-220*86400000).toISOString().slice(0,10);const d=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=5000`)).results||[];bars=d.map(normalizeBar).filter(Boolean).slice(-WINDOW);initialized++;}else{const d=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${today}/${today}?adjusted=true&sort=asc&limit=10`)).results||[];const fresh=d.map(normalizeBar).filter(Boolean);if(fresh.length){const map=new Map(bars.map(x=>[x.date,x]));for(const x of fresh)map.set(x.date,x);bars=[...map.values()].sort((a,z)=>a.date.localeCompare(z.date)).slice(-WINDOW);updated++;}else unchanged++;}await saveHistory(t,{version:2,ticker:t,initialized:true,bars,updatedAt:new Date().toISOString(),lastSession:bars.at(-1)?.date||null});histories[t]={ticker:t,bars,lastSession:bars.at(-1)?.date||null};}catch(e){failed++;histories[t]={ticker:t,bars:[],error:String(e?.message||e)};}processed++;if(processed%10===0||processed===tickers.length)await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:today,total:tickers.length,processed,initialized,updated,unchanged,failed});}};
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,tickers.length)},worker));
  return{ok:true,date:today,total:tickers.length,processed,initialized,updated,unchanged,failed,...(includeHistories?{histories}:{})};
}
export async function runWyckoff({force=false}={}){
  if(!force&&!afterHoursEnded())return{ok:false,skipped:true,reason:'التحليل التلقائي ينتظر نهاية After Hours.'};
  const today=todayET(),store=getDataStore(),existing=await store.get(RESULT_KEY,{type:'json',consistency:'strong'});if(!force&&existing?.date===today)return{ok:true,skipped:true,date:today,total:Number(existing.universeTickers||0)};
  const collected=await collectWyckoffData({includeHistories:true});if(!collected.ok)return collected;const results=[];const hs=collected.histories||{};const tickers=Object.keys(hs);
  await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:tickers.length,processed:0,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});
  let done=0;for(const t of tickers){const h=hs[t];results.push(h.error?{version:2,ticker:t,stage:'غير متوفر',stageFit:0,error:h.error,barsCount:0,events:[]} : analyze(t,h.bars));done++;if(done%10===0||done===tickers.length)await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:tickers.length,processed:done,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});}
  const payload={version:2,ready:true,date:today,updatedAt:new Date().toISOString(),windowSessions:WINDOW,records:results.sort((a,b)=>a.ticker.localeCompare(b.ticker)),universeTickers:tickers.length,source:'massive-daily-incremental-wyckoff-v2',components:['VSA','Swing-by-Swing','Phase A-E','Spring/UTAD','Point & Figure Cause/Effect proxy','Relative Strength','Change of Character','Effort vs Result'],chartCached:true};
  await store.setJSON(RESULT_KEY,payload);await store.setJSON(STATUS_KEY,{state:'ready',mode:'analysis',date:today,completedAt:payload.updatedAt,total:tickers.length,processed:results.length,historyKey:HISTORY_KEY+' per ticker'});return{ok:true,date:today,total:tickers.length,processed:results.length,updatedAt:payload.updatedAt,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}};
}
export async function readWyckoff(){return await getDataStore().get(RESULT_KEY,{type:'json',consistency:'strong'})||null;}
export async function readWyckoffStatus(){return await getDataStore().get(STATUS_KEY,{type:'json',consistency:'strong'})||null;}
