import { getDataStore, getSiteSettings } from '../../lib.js';

// Wyckoff engine v5: 35 daily sessions = 25 context + 10 recent sessions.
// The recent-session weight is configurable from the Admin panel.
// The model is a rule-based approximation of Wyckoff price/volume logic,
// not a statistical probability model and not a claim of trader intent.
const MASSIVE='https://api.massive.com';
const HISTORY_KEY='scanner-models-wyckoff-history-v2';
const RESULT_KEY='scanner-models-wyckoff-v2';
const STATUS_KEY='scanner-models-wyckoff-status-v2';
const CONFIG_KEY='scanner-models-wyckoff-config-v1';
const WINDOW=35, CONTEXT=25, RECENT=10, DEFAULT_RECENT_WEIGHT=.60, CONCURRENCY=5;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const apiKey=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const cleanTicker=x=>String(x||'').trim().toUpperCase();
const todayET=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function afterHoursEnded(){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(new Date());const g=t=>p.find(x=>x.type===t)?.value||'';const m=Number(g('hour'))*60+Number(g('minute'));return !['Sat','Sun'].includes(g('weekday'))&&m>=1200;}
async function massive(path){const k=apiKey();if(!k)throw new Error('MASSIVE_API_KEY غير مهيأ.');const sep=path.includes('?')?'&':'?';let last='';for(let i=0;i<4;i++){const r=await fetch(`${MASSIVE}${path}${sep}apiKey=${encodeURIComponent(k)}`,{headers:{accept:'application/json'}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{};}catch{}if(r.ok)return d;last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}throw new Error(last);}throw new Error(last||'Massive request failed.');}
const barDate=b=>Number.isFinite(Number(b?.t))?new Date(Number(b.t)).toISOString().slice(0,10):String(b?.date||'');
function normalizeBar(b){const o=Number(b?.o),h=Number(b?.h),l=Number(b?.l),c=Number(b?.c),v=Number(b?.v);if(!barDate(b)||![o,h,l,c,v].every(Number.isFinite)||h<=0||l<=0||c<=0)return null;return{date:barDate(b),open:o,high:h,low:l,close:c,volume:v};}
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function sma(a,n){return a.length<n?null:avg(a.slice(-n));}
function stdev(a){if(a.length<2)return 0;const m=avg(a);return Math.sqrt(avg(a.map(x=>(x-m)**2))||0);}
function slope(a){if(a.length<3)return 0;const n=a.length,mx=(n-1)/2,my=avg(a);let num=0,den=0;for(let i=0;i<n;i++){num+=(i-mx)*(a[i]-my);den+=(i-mx)**2;}return den?num/den:0;}
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,Number(x)||0));
function range(bars){if(!bars.length)return{hi:null,lo:null,mid:null,width:0};const hi=Math.max(...bars.map(x=>x.high)),lo=Math.min(...bars.map(x=>x.low)),mid=(hi+lo)/2;return{hi,lo,mid,width:mid?((hi-lo)/mid)*100:0};}
function loc(b){return(b.close-b.low)/Math.max(.0001,b.high-b.low);}
function pct(a,b){return b?((a/b)-1)*100:0;}
function vsa(bars,i){const b=bars[i],prior=bars.slice(Math.max(0,i-20),i);if(!b||prior.length<8)return null;const avSpread=avg(prior.map(x=>x.high-x.low))||1,avVol=avg(prior.map(x=>x.volume))||1,spread=b.high-b.low,effort=b.volume/avVol,result=spread/avSpread,cl=loc(b);return{effort,result,closeLocation:cl,wide:result>=1.35,narrow:result<=.75,highVolume:effort>=1.5,lowVolume:effort<=.75,effortResult:effort>=1.4&&result<=.8?'high-effort-low-result':effort>=1.4&&result>=1.35?'high-effort-high-result':null};}
function localRange(bars,start,end){return range(bars.slice(Math.max(0,start),Math.max(start,end)));}
function findLastIndex(events,type){for(let i=events.length-1;i>=0;i--)if(events[i].type===type)return events[i].i;return -1;}
function detectEvents(bars){
  const events=[];
  const add=(type,i,confidence,description,side)=>events.push({type,i,date:bars[i]?.date,confidence:Math.round(clamp(confidence)),description,side});
  for(let i=5;i<bars.length;i++){
    const b=bars[i],v=vsa(bars,i);if(!v)continue;
    const prior=bars.slice(Math.max(0,i-12),i),r=range(prior);if(!r.lo||!r.hi)continue;
    const priorVol=avg(prior.map(x=>x.volume))||1,spread=b.high-b.low;
    const nearLow=b.low<=r.lo*1.01,nearHigh=b.high>=r.hi*.99;
    // Selling Climax / Buying Climax: abnormal effort + wide spread at an extreme,
    // followed by a close that shows some absorption rather than a straight close at the extreme.
    if(nearLow&&v.highVolume&&v.wide&&loc(b)>=.35&&b.close<b.open)add('SC',i,55+v.effort*10+loc(b)*15,'Selling Climax-like bar: high effort, wide spread and absorption near a local low','accumulation');
    if(nearHigh&&v.highVolume&&v.wide&&loc(b)<=.65&&b.close>b.open)add('BC',i,55+v.effort*10+(1-loc(b))*15,'Buying Climax-like bar: high effort, wide spread and rejection near a local high','distribution');
    // Spring / UTAD: penetration of the recent range followed by recovery/rejection inside it.
    if(b.low<r.lo*.995&&b.close>r.lo&&loc(b)>.65)add('Spring',i,60+v.effort*8+loc(b)*20,'Spring-like penetration below support followed by recovery into the range','accumulation');
    if(b.high>r.hi*1.005&&b.close<r.hi&&loc(b)<.35)add('UTAD',i,60+v.effort*8+(1-loc(b))*20,'UT/UTAD-like penetration above resistance followed by rejection into the range','distribution');
    // Strength/weakness bars: a genuine close outside the range, with effort/result alignment.
    if(b.close>r.hi*1.003&&v.wide&&loc(b)>.65&&b.volume>priorVol*1.2)add('SOS',i,58+v.effort*8+loc(b)*22,'Sign of Strength: wide bullish result above the recent range','accumulation');
    if(b.close<r.lo*.997&&v.wide&&loc(b)<.35&&b.volume>priorVol*1.2)add('SOW',i,58+v.effort*8+(1-loc(b))*22,'Sign of Weakness: wide bearish result below the recent range','distribution');
    if(v.effortResult==='high-effort-low-result')add('EffortResult',i,62+v.effort*8,'High effort with limited price result — possible absorption/exhaustion evidence','neutral');
  }
  // Automatic reactions/rallies, tests, LPS/LPSY are sequence events: they only count when
  // they occur after the corresponding climax or strength/weakness event.
  const sc=findLastIndex(events,'SC'),bc=findLastIndex(events,'BC'),spring=findLastIndex(events,'Spring'),utad=findLastIndex(events,'UTAD'),sos=findLastIndex(events,'SOS'),sow=findLastIndex(events,'SOW');
  if(sc>=0){const s=bars[sc];for(let i=sc+1;i<Math.min(bars.length,sc+7);i++){const b=bars[i];if(b.close>s.close+(s.high-s.low)*.6){add('AR',i,68,'Automatic Rally-like reaction after SC','accumulation');break;}}for(let i=sc+3;i<Math.min(bars.length,sc+13);i++){const b=bars[i],base=bars.slice(Math.max(0,i-10),i),v=vsa(bars,i);if(base.length&&b.low<=s.low*1.03&&b.low>=s.low*.97&&v?.lowVolume&&v.narrow){add('ST',i,72,'Secondary Test-like retest of the SC area on reduced effort','accumulation');break;}}}
  if(bc>=0){const s=bars[bc];for(let i=bc+1;i<Math.min(bars.length,bc+7);i++){const b=bars[i];if(b.close<s.close-(s.high-s.low)*.6){add('AR',i,68,'Automatic Reaction-like decline after BC','distribution');break;}}for(let i=bc+3;i<Math.min(bars.length,bc+13);i++){const b=bars[i],v=vsa(bars,i);if(b.high>=s.high*.97&&b.high<=s.high*1.03&&v?.lowVolume&&v.narrow){add('ST',i,72,'Secondary Test-like retest of the BC area on reduced effort','distribution');break;}}}
  if(spring>=0&&spring<bars.length-1){for(let i=spring+1;i<Math.min(bars.length,spring+5);i++){const v=vsa(bars,i);if(bars[i].low>bars[spring].low&&v?.lowVolume&&bars[i].close>bars[i].open){add('Test',i,74,'Test-like follow-through after Spring with reduced supply','accumulation');break;}}}
  if(utad>=0&&utad<bars.length-1){for(let i=utad+1;i<Math.min(bars.length,utad+5);i++){const v=vsa(bars,i);if(bars[i].high<bars[utad].high&&v?.lowVolume&&bars[i].close<bars[i].open){add('Test',i,74,'Test-like follow-through after UT/UTAD with reduced demand','distribution');break;}}}
  if(sos>=0){for(let i=sos+1;i<Math.min(bars.length,sos+6);i++){const v=vsa(bars,i),b=bars[i];if(v?.lowVolume&&b.low>bars[sos].high*.985&&b.close>bars[sos].high*.995){add('LPS',i,70,'Last Point of Support-like pullback after SOS with reduced supply','accumulation');break;}}}
  if(sow>=0){for(let i=sow+1;i<Math.min(bars.length,sow+6);i++){const v=vsa(bars,i),b=bars[i];if(v?.lowVolume&&b.high<bars[sow].low*1.015&&b.close<bars[sow].low*1.005){add('LPSY',i,70,'Last Point of Supply-like rally after SOW with reduced demand','distribution');break;}}}
  const uniq=new Map();for(const e of events){const k=`${e.type}:${e.date}`;if(!uniq.has(k)||e.confidence>uniq.get(k).confidence)uniq.set(k,e);}return[...uniq.values()].sort((a,b)=>a.i-b.i).slice(-24);
}
function pfCauseEffect(bars){const r=range(bars),box=Math.max(.0001,(r.hi-r.lo)/12),count=Math.max(1,Math.round((r.hi-r.lo)/box));return{method:'range-count-proxy',rangeHigh:r.hi,rangeLow:r.lo,boxSize:Number(box.toFixed(4)),count,upObjective:Number((r.hi+count*box).toFixed(2)),downObjective:Number((r.lo-count*box).toFixed(2)),note:'تقدير Cause/Effect مبني على نطاق 35 جلسة؛ ليس عدّ P&F كلاسيكيًا كاملاً.'};}
function relativeStrength(bars){const closes=bars.map(x=>x.close),ret=n=>n<closes.length?closes.at(-1)/closes.at(-1-n)-1:null;return{ret20:ret(20),ret25:ret(25),trend20:slope(closes.slice(-20)),trend35:slope(closes)};}
function phaseState(bars,events){
  const last=bars.at(-1),r=range(bars),recent=bars.slice(-10),recentRange=range(recent),pos=(last.close-r.lo)/Math.max(.0001,r.hi-r.lo);
  const has=t=>events.some(e=>e.type===t),spring=has('Spring'),utad=has('UTAD'),sos=has('SOS'),sow=has('SOW'),sc=has('SC'),bc=has('BC'),test=has('Test'),lps=has('LPS'),lpsy=has('LPSY');
  if(spring||utad)return{phase:'C',label:spring?'Phase C — Spring/Test محتمل':'Phase C — UT/UTAD/Test محتمل'};
  if((sos&&lps)||(sow&&lpsy))return{phase:'D',label:sos?'Phase D — SOS/LPS':'Phase D — SOW/LPSY'};
  if((sc&&test)||(bc&&test))return{phase:'A',label:sc?'Phase A — SC/AR/ST محتمل':'Phase A — BC/AR/ST محتمل'};
  if(recentRange.width<r.width*.72&&Math.abs(slope(recent.map(x=>x.close)))/Math.max(.01,last.close)<.004)return{phase:'B',label:'Phase B — بناء السبب داخل النطاق'};
  if(pos>.72&&last.close>sma(bars.map(x=>x.close),20))return{phase:'E',label:'Phase E — اتجاه صاعد بعد الخروج من النطاق'};
  if(pos<.28&&last.close<sma(bars.map(x=>x.close),20))return{phase:'E',label:'Phase E — اتجاه هابط بعد الخروج من النطاق'};
  return{phase:'A/B',label:'Phase A/B — تغير سلوك أو نطاق غير مكتمل'};
}
function weightedEvidence(items,contextWeight,recentWeight){return items.reduce((sum,x)=>sum+(x.context?contextWeight:recentWeight),0);}
function analyze(ticker,bars,config){
  const b=bars.slice(-WINDOW);if(b.length<WINDOW)return{version:5,ticker,stage:'غير كافٍ',stageLabel:'بيانات غير كافية',stageFit:0,barsCount:b.length,lastDate:b.at(-1)?.date||null,events:[],manipulationLike:null};
  const context=b.slice(0,CONTEXT),recent=b.slice(-RECENT),allCloses=b.map(x=>x.close),r=range(b),rContext=range(context),rRecent=range(recent);
  const contextSlope=slope(context.map(x=>x.close))/Math.max(.0001,avg(context.map(x=>x.close))||1),recentSlope=slope(recent.map(x=>x.close))/Math.max(.0001,avg(recent.map(x=>x.close))||1),weightedSlope=config.contextWeight*contextSlope+config.recentWeight*recentSlope;
  const events=detectEvents(b),phase=phaseState(b,events),rs=relativeStrength(b),pf=pfCauseEffect(b);
  const eventWindow=e=>e.i<CONTEXT?'context':'recent';
  const has=(type,side=null)=>events.some(e=>e.type===type&&(!side||e.side===side));
  const evidence={
    accumulation:[
      {ok:contextSlope<0,context:true,label:'سياق سابق هابط'},
      {ok:rRecent.width<rContext.width*.82,context:false,label:'تضييق/توازن حديث'},
      {ok:recentSlope>=contextSlope*.15,context:false,label:'تحسن الميل الحديث'},
      {ok:has('SC','accumulation'),context:eventWindow(events.find(e=>e.type==='SC'&&e.side==='accumulation')||{})==='context',label:'SC-like'},
      {ok:has('AR','accumulation'),context:eventWindow(events.find(e=>e.type==='AR'&&e.side==='accumulation')||{})==='context',label:'AR-like'},
      {ok:has('ST','accumulation'),context:eventWindow(events.find(e=>e.type==='ST'&&e.side==='accumulation')||{})==='context',label:'ST-like'},
      {ok:has('Spring','accumulation'),context:false,label:'Spring-like'},
      {ok:has('Test','accumulation'),context:false,label:'Spring Test-like'},
      {ok:has('SOS','accumulation'),context:false,label:'SOS-like'},
      {ok:has('LPS','accumulation'),context:false,label:'LPS-like'},
      {ok:has('effort-vs-result','accumulation'),context:false,label:'Effort/Result absorption'}
    ],
    distribution:[
      {ok:contextSlope>0,context:true,label:'سياق سابق صاعد'},
      {ok:rRecent.width<rContext.width*.82,context:false,label:'تضييق/توازن حديث'},
      {ok:recentSlope<=contextSlope*.85,context:false,label:'تدهور الميل الحديث'},
      {ok:has('BC','distribution'),context:eventWindow(events.find(e=>e.type==='BC'&&e.side==='distribution')||{})==='context',label:'BC-like'},
      {ok:has('AR','distribution'),context:eventWindow(events.find(e=>e.type==='AR'&&e.side==='distribution')||{})==='context',label:'AR-like'},
      {ok:has('ST','distribution'),context:eventWindow(events.find(e=>e.type==='ST'&&e.side==='distribution')||{})==='context',label:'ST-like'},
      {ok:has('UTAD','distribution'),context:false,label:'UT/UTAD-like'},
      {ok:has('Test','distribution'),context:false,label:'UTAD Test-like'},
      {ok:has('SOW','distribution'),context:false,label:'SOW-like'},
      {ok:has('LPSY','distribution'),context:false,label:'LPSY-like'},
      {ok:has('effort-vs-result','distribution'),context:false,label:'Effort/Result absorption'}
    ],
    markup:[
      {ok:contextSlope>0,context:true,label:'سياق سابق صاعد'},
      {ok:recentSlope>0,context:false,label:'ميل حديث صاعد'},
      {ok:weightedSlope>0,context:false,label:'الميل الموزون صاعد'},
      {ok:allCloses.at(-1)>r.mid,context:false,label:'السعر فوق منتصف النطاق'},
      {ok:allCloses.at(-1)>recent[0].close,context:false,label:'السعر أعلى من بداية آخر 10'},
      {ok:has('SOS','accumulation'),context:false,label:'SOS-like'},
      {ok:has('LPS','accumulation'),context:false,label:'LPS-like'},
      {ok:rs.ret20!==null&&rs.ret20>0,context:false,label:'عائد 20 جلسة موجب'}
    ],
    markdown:[
      {ok:contextSlope<0,context:true,label:'سياق سابق هابط'},
      {ok:recentSlope<0,context:false,label:'ميل حديث هابط'},
      {ok:weightedSlope<0,context:false,label:'الميل الموزون هابط'},
      {ok:allCloses.at(-1)<r.mid,context:false,label:'السعر تحت منتصف النطاق'},
      {ok:allCloses.at(-1)<recent[0].close,context:false,label:'السعر أدنى من بداية آخر 10'},
      {ok:has('SOW','distribution'),context:false,label:'SOW-like'},
      {ok:has('LPSY','distribution'),context:false,label:'LPSY-like'},
      {ok:rs.ret20!==null&&rs.ret20<0,context:false,label:'عائد 20 جلسة سالب'}
    ]
  };
  const scores={};for(const [stage,list] of Object.entries(evidence)){const applicable=list.filter(x=>x.ok);scores[stage]=applicable.reduce((s,x)=>s+(x.context?config.contextWeight:config.recentWeight),0);}
  const maxScores=Object.fromEntries(Object.entries(evidence).map(([stage,list])=>[stage,list.reduce((s,x)=>s+(x.context?config.contextWeight:config.recentWeight),0)]));
  const ranked=Object.entries(scores).sort((a,z)=>z[1]-a[1]);const stage=ranked[0]?.[0]||'markdown';
  const denominator=Math.max(1,maxScores[stage]);const stageFit=Math.round(clamp(scores[stage]/denominator*100));
  const manipulationLike=stage==='accumulation'&&has('Spring','accumulation')?'Spring/Shakeout-like (سلوك سعري محتمل)':stage==='distribution'&&has('UTAD','distribution')?'UT/UTAD-like (سلوك سعري محتمل)':null;
  const components={
    priceStructure:{name:'Price Structure',evidence:{contextSlope,recentSlope,weightedSlope,rangeWidth:r.width,positionInRange:(allCloses.at(-1)-r.lo)/Math.max(.0001,r.hi-r.lo)}},
    vsa:{name:'VSA / Effort vs Result',evidence:b.slice(-10).map((_,j)=>vsa(b,b.length-10+j)).filter(Boolean).slice(-5)},
    events:{name:'Wyckoff Events',evidence:events},
    phase:{name:'Phase A-E',evidence:phase},
    pointAndFigure:{name:'Cause/Effect proxy',evidence:pf},
    relativeStrength:{name:'Relative Strength',evidence:rs},
    sequence:{name:'Event Sequence',evidence:{accumulation:['SC','AR','ST','Spring','Test','SOS','LPS'],distribution:['BC','AR','ST','UTAD','Test','SOW','LPSY']}},
    evidenceByStage:evidence
  };
  const chart=b.map((x,i)=>({date:x.date,close:Number(x.close.toFixed(4)),volume:x.volume,window:i<CONTEXT?'context':'recent',stage}));
  return{version:5,ticker,stage,stageLabel:{markdown:'هبوط — Markdown',accumulation:'تجميع — Accumulation',markup:'صعود — Markup',distribution:'تصريف — Distribution'}[stage],stageFit,stageScores:scores,stageMaxScores:maxScores,weights:{contextSessions:CONTEXT,recentSessions:RECENT,contextWeight:config.contextWeight,recentWeight:config.recentWeight,recentWeightPercent:config.recentWeightPercent,contextWeightPercent:config.contextWeightPercent},weightedSlope,changeShift:recentSlope-contextSlope,phase,manipulationLike,events,components,chart,pointAndFigure:pf,lastClose:allCloses.at(-1),ma20:sma(allCloses,20),ma25:sma(allCloses,25),lastDate:b.at(-1).date,barsCount:b.length,updatedAt:new Date().toISOString()};
}
async function getWyckoffConfig(){const raw=await getDataStore().get(CONFIG_KEY,{type:'json',consistency:'strong'}).catch(()=>null);const n=Number(raw?.recentWeightPercent);const recentWeightPercent=Number.isFinite(n)?Math.max(0,Math.min(100,n)):DEFAULT_RECENT_WEIGHT*100;return{windowSessions:WINDOW,contextSessions:CONTEXT,recentSessions:RECENT,recentWeightPercent,contextWeightPercent:100-recentWeightPercent,recentWeight:recentWeightPercent/100,contextWeight:(100-recentWeightPercent)/100};}
async function getCache(){return await getDataStore().get('scanner-cache-v1',{type:'json',consistency:'strong'})||{};}
async function loadHistory(t){return await getDataStore().get(`${HISTORY_KEY}:${t}`,{type:'json',consistency:'strong'})||null;}
async function saveHistory(t,v){await getDataStore().setJSON(`${HISTORY_KEY}:${t}`,v);}
export async function collectWyckoffData({includeHistories=false}={}){const store=getDataStore(),today=todayET(),cache=await getCache();const tickers=[...new Set((cache.records||[]).map(x=>cleanTicker(x?.ticker)).filter(Boolean))];if(!tickers.length)return{ok:false,error:'لا توجد أسهم في scanner-cache-v1.'};let index=0,processed=0,initialized=0,updated=0,unchanged=0,failed=0;const histories={};await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:today,startedAt:new Date().toISOString(),total:tickers.length,processed:0,initialized:0,updated:0,unchanged:0,failed:0});const worker=async()=>{while(true){const i=index++;if(i>=tickers.length)return;const t=tickers[i];try{const old=await loadHistory(t);let bars=Array.isArray(old?.bars)?old.bars:[];if(!old?.initialized){const from=new Date(Date.now()-220*86400000).toISOString().slice(0,10);const d=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=5000`)).results||[];bars=d.map(normalizeBar).filter(Boolean).slice(-WINDOW);initialized++;}else{const d=(await massive(`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${today}/${today}?adjusted=true&sort=asc&limit=10`)).results||[];const fresh=d.map(normalizeBar).filter(Boolean);if(fresh.length){const map=new Map(bars.map(x=>[x.date,x]));for(const x of fresh)map.set(x.date,x);bars=[...map.values()].sort((a,z)=>a.date.localeCompare(z.date)).slice(-WINDOW);updated++;}else unchanged++;}await saveHistory(t,{version:5,ticker:t,initialized:true,bars,updatedAt:new Date().toISOString(),lastSession:bars.at(-1)?.date||null});histories[t]={ticker:t,bars,lastSession:bars.at(-1)?.date||null};}catch(e){failed++;histories[t]={ticker:t,bars:[],error:String(e?.message||e)};}processed++;if(processed%10===0||processed===tickers.length)await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',date:today,total:tickers.length,processed,initialized,updated,unchanged,failed});}};await Promise.all(Array.from({length:Math.min(CONCURRENCY,tickers.length)},worker));return{ok:true,date:today,total:tickers.length,processed,initialized,updated,unchanged,failed,...(includeHistories?{histories}:{})};}
export async function runWyckoff({force=false}={}){if(!force){const settings=await getSiteSettings();if(settings.auto_update_enabled===false||settings.wyckoffAutoUpdateEnabled===false)return{ok:true,skipped:true,reason:'wyckoff-automatic-updates-disabled'};}return{ok:true,skipped:true,reason:'wyckoff-automatic-updates-disabled'};if(!force&&!afterHoursEnded())return{ok:false,skipped:true,reason:'التحليل التلقائي ينتظر نهاية After Hours.'};const today=todayET(),store=getDataStore(),config=await getWyckoffConfig(),existing=await store.get(RESULT_KEY,{type:'json',consistency:'strong'});if(!force&&existing?.date===today)return{ok:true,skipped:true,date:today,total:Number(existing.universeTickers||0)};const collected=await collectWyckoffData({includeHistories:true});if(!collected.ok)return collected;const results=[];const hs=collected.histories||{};const tickers=Object.keys(hs);await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:tickers.length,processed:0,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed},weights:{recentWeightPercent:config.recentWeightPercent,contextWeightPercent:config.contextWeightPercent,windowSessions:WINDOW,recentSessions:RECENT,contextSessions:CONTEXT}});let done=0;for(const t of tickers){const h=hs[t];results.push(h.error?{version:5,ticker:t,stage:'غير متوفر',stageFit:0,error:h.error,barsCount:0,events:[]} : analyze(t,h.bars,config));done++;if(done%10===0||done===tickers.length)await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:tickers.length,processed:done,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed},weights:{recentWeightPercent:config.recentWeightPercent,contextWeightPercent:config.contextWeightPercent,windowSessions:WINDOW,recentSessions:RECENT,contextSessions:CONTEXT}});}const payload={version:5,ready:true,date:today,updatedAt:new Date().toISOString(),windowSessions:WINDOW,contextSessions:CONTEXT,recentSessions:RECENT,recentWeightPercent:config.recentWeightPercent,contextWeightPercent:config.contextWeightPercent,records:results.sort((a,b)=>a.ticker.localeCompare(b.ticker)),universeTickers:tickers.length,source:'massive-daily-incremental-wyckoff-v5-rule-based-35-10',components:['Price Structure','VSA / Effort vs Result','SC/BC','AR','ST','Spring/Test','UT/UTAD/Test','SOS/SOW','LPS/LPSY','Phase A-E','Cause/Effect proxy','Relative Strength','Event Sequence'],chartCached:true};await store.setJSON(RESULT_KEY,payload);await store.setJSON(STATUS_KEY,{state:'ready',mode:'analysis',date:today,completedAt:payload.updatedAt,total:tickers.length,processed:results.length,historyKey:HISTORY_KEY+' per ticker',weights:{recentWeightPercent:config.recentWeightPercent,contextWeightPercent:config.contextWeightPercent,windowSessions:WINDOW,recentSessions:RECENT,contextSessions:CONTEXT}});return{ok:true,date:today,total:tickers.length,processed:results.length,updatedAt:payload.updatedAt,collection:{initialized:collected.initialized,updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}};}
export async function readWyckoffConfig(){return await getWyckoffConfig();}
export async function saveWyckoffConfig(recentWeightPercent){const n=Number(recentWeightPercent);if(!Number.isFinite(n)||n<0||n>100)throw new Error('وزن آخر 10 شموع يجب أن يكون بين 0 و100%.');await getDataStore().setJSON(CONFIG_KEY,{recentWeightPercent:n,updatedAt:new Date().toISOString()});return await getWyckoffConfig();}
export async function readWyckoff(){return await getDataStore().get(RESULT_KEY,{type:'json',consistency:'strong'})||null;}
export async function readWyckoffStatus(){return await getDataStore().get(STATUS_KEY,{type:'json',consistency:'strong'})||null;}
