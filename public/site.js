

const MBASE="";

// ==================== المظهر ====================
function applyTheme(theme){
  const t=theme==="dark"?"dark":"light";
  document.body.dataset.theme=t;
  localStorage.setItem("scanner_theme",t);
  const toggle=document.getElementById("themeToggle"); if(toggle)toggle.checked=t==="dark";
}
function initTheme(){applyTheme(localStorage.getItem("scanner_theme")==="dark"?"dark":"light");}
initTheme();
let sessionReady=false;
let sessionKnown=localStorage.getItem("scanner_session_hint")==="1";
let maintenanceActive=false;
function readDeviceCookie(){const m=document.cookie.match(/(?:^|; )scanner_device_id=([^;]+)/);return m?decodeURIComponent(m[1]):"";}
function deviceId(){let k="scanner_device_id";let cookie=readDeviceCookie();let v=cookie||localStorage.getItem(k);if(!v){v=crypto.randomUUID?crypto.randomUUID():(Date.now()+"-"+Math.random());}try{localStorage.setItem(k,v);}catch{}return v}
async function deviceFingerprint(){
  const nav=navigator, scr=screen;
  const raw=[
    nav.platform||"",
    scr.width||0,scr.height||0,scr.availWidth||0,scr.availHeight||0,
    scr.colorDepth||0,window.devicePixelRatio||1,
    Intl.DateTimeFormat().resolvedOptions().timeZone||"",
    nav.language||"",
    nav.hardwareConcurrency||0,nav.deviceMemory||0,nav.maxTouchPoints||0
  ].join("|");
  try{
    if(globalThis.crypto?.subtle){
      const bytes=new TextEncoder().encode(raw),hash=await crypto.subtle.digest("SHA-256",bytes);
      return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,"0")).join("");
    }
  }catch{}
  return raw;
}
async function apiFetch(url,opt={}){
  const fp=await deviceFingerprint();
  opt.headers=Object.assign({"X-Device-ID":deviceId(),"X-Device-Fingerprint":fp},opt.headers||{});
  const fullUrl=new URL(url,window.location.origin).toString();
  opt.credentials="same-origin";
  if(url.includes("/.netlify/functions/")) opt.cache="no-store";
  return fetch(fullUrl,opt);
}
async function responseJSON(r){
  const raw=await r.text();
  let data={};
  try{data=raw?JSON.parse(raw):{}}catch(e){
    const body=raw.slice(0,220).replace(/\s+/g," ");
    if(r.status===401 && /<\s*!doctype|<html/i.test(raw)) throw Error("انتهت جلسة حماية الموقع في Netlify. حدّث الصفحة ثم أعد تسجيل الدخول؛ بيانات حساب الباحث نفسها لم تتغير.");
    throw Error(`الخادم لم يرجع بيانات صحيحة (HTTP ${r.status}). ${body||"لم تصل استجابة صالحة من الخادم."}`);
  }
  return data;
}
let stopped=false,paused=false,running=false,results=0,scanned=0,scanAbortController=null;
let favoriteItems=[],favoriteRefreshTimer=null,favoriteRefreshing=false;
let alertSettings={}, alertTickerCurrent="", telegramState={linked:false,link:null};
async function loadAlertSettings(){try{const d=await getJSON('/.netlify/functions/alerts?action=settings');alertSettings=d.settings||{};telegramState=d.telegram||{linked:false,link:null};renderTelegramLinkState();}catch(e){console.warn('alerts settings',e.message);}}
function renderTelegramLinkState(){const status=$('telegramAlertStatus'),btn=$('telegramAlertLink'),modalBtn=$('telegramAlertLinkModal');if(telegramState?.linked){if(status)status.textContent='تم ربط حسابك بتليجرام.';[btn,modalBtn].forEach(x=>{if(x)x.style.display='none';});}else{if(status)status.textContent='يرجى ربط حسابك بتليجرام لتلقي التنبيهات فوراً على جوالك';[btn,modalBtn].forEach(x=>{if(x){x.style.display=telegramState?.link?'inline-flex':'none';if(telegramState?.link)x.href=telegramState.link;}});}}
function updateAlertDropInput(){const mode=$('alertDropMode')?.value||'percent',input=$('alertDropValue');if(!input)return;input.placeholder=mode==='price'?'مثال: 4.20':'مثال: 5';input.step=mode==='price'?'0.01':'1';const suffix=$('alertDropSuffix');if(suffix)suffix.textContent=mode==='price'?'$':'%';}
function openAlertModal(f){
  alertTickerCurrent=f.ticker; const a=alertSettings[f.ticker]||{};
  $('alertTicker').textContent=f.ticker; $('alertDropEnabled').checked=Boolean(a.drop?.enabled); $('alertDropMode').value=a.drop?.mode||'percent'; $('alertDropValue').value=a.drop?.value??'';
  $('alertShortEnabled').checked=Boolean(a.short?.enabled); $('alertShortValue').value=a.short?.value??'';
  $('alertRsiEnabled').checked=Boolean(a.rsi?.enabled); $('alertRsiDirection').value=a.rsi?.direction||'below'; $('alertRsiValue').value=a.rsi?.value??'';
  updateAlertDropInput(); $('alertMsg').textContent=''; $('alertModal').classList.add('show');
}
async function saveAlertSettings(){
  const num=id=>{const v=String($(id)?.value??'').trim();return v===''?null:Number(v);};
  const payload={ticker:alertTickerCurrent,splitDate:(favoriteItems.find(x=>x.ticker===alertTickerCurrent)||{}).splitDate||'',enabled:true,drop:{enabled:$('alertDropEnabled').checked,mode:$('alertDropMode').value,value:num('alertDropValue')},short:{enabled:$('alertShortEnabled').checked,value:num('alertShortValue')},rsi:{enabled:$('alertRsiEnabled').checked,value:num('alertRsiValue'),direction:$('alertRsiDirection').value}};
  if(!payload.drop.enabled&&!payload.short.enabled&&!payload.rsi.enabled)payload.enabled=false;
  const btn=$('alertSave');if(btn)btn.disabled=true;$('alertMsg').textContent='جاري حفظ التنبيه...';
  try{
    const r=await apiFetch('/.netlify/functions/alerts?action=settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await responseJSON(r);if(!r.ok)throw Error(d.error||'تعذر حفظ التنبيه.');
    alertSettings=d.settings||{};telegramState=d.telegram||telegramState;renderFavorites();renderTelegramLinkState();$('alertMsg').textContent=telegramState?.linked?'تم حفظ وتفعيل التنبيه.':'تم حفظ وتفعيل التنبيه. يرجى ربط حسابك بتليجرام لتلقي التنبيهات فوراً على جوالك.';
  }catch(e){$('alertMsg').textContent=e.message||'تعذر حفظ التنبيه.';}
  finally{if(btn)btn.disabled=false;}
}
async function disableAlert(){try{const r=await apiFetch('/.netlify/functions/alerts?action=settings',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:alertTickerCurrent})});const d=await responseJSON(r);if(!r.ok)throw Error(d.error||'تعذر إلغاء التنبيه.');alertSettings=d.settings||{};$('alertModal').classList.remove('show');renderFavorites();}catch(e){$('alertMsg').textContent=e.message||'تعذر إلغاء التنبيه.';}}
function alertCriteriaText(a){
  const out=[];
  if(a?.drop?.enabled){
    out.push(a.drop.mode==='price'
      ? `السعر ≤ $${Number(a.drop.value).toFixed(2)}`
      : `هبوط ${Number(a.drop.value).toFixed(2)}% أو أكثر`);
  }
  if(a?.short?.enabled) out.push(`الشورت ≤ ${Number(a.short.value).toLocaleString('en-US')}`);
  if(a?.rsi?.enabled) out.push(`RSI ${a.rsi.direction==='above'?'≥':'≤'} ${Number(a.rsi.value).toFixed(1)}`);
  return out;
}
function renderActiveNotifications(settings){
  const list=$('activeNotificationList');
  const count=$('activeNotificationCount');
  if(!list)return;
  const items=Object.values(settings||{}).filter(a=>a?.enabled);
  if(count)count.textContent=items.length.toLocaleString('ar-SA');
  list.innerHTML=items.length?items.map(a=>{
    const criteria=alertCriteriaText(a);
    return `<div class="notificationItem activeNotificationItem"><div class="notificationItemMain"><b>${escapeHtml(a.ticker||'—')}</b><div class="small">${criteria.length?criteria.map(escapeHtml).join(' · '):'التنبيه مفعّل'}</div></div><span class="notificationActiveBadge">مفعّل</span></div>`;
  }).join(''):'<div class="small">لا توجد تنبيهات مفعلة حاليًا.</div>';
}
function renderNotificationHistory(items){
  const list=$('notificationList');
  const count=$('triggeredNotificationCount');
  if(!list)return;
  if(count)count.textContent=(items||[]).length.toLocaleString('ar-SA');
  list.innerHTML=(items||[]).length?items.map(x=>`<div class="notificationItem"><div class="notificationItemMain"><b>${escapeHtml(x.title||x.ticker||'تنبيه')}</b><div class="small">${escapeHtml(x.message||'')}</div></div><div class="small notificationTime">${x.createdAt?new Date(x.createdAt).toLocaleString('ar-SA'):'—'}</div></div>`).join(''):'<div class="small">لم يتم إطلاق أي تنبيه حتى الآن.</div>';
}
async function loadNotificationHistory(){
  try{
    const d=await getJSON('/.netlify/functions/alerts?action=history');
    const items=d.items||[];
    $('notificationBadge')?.classList.toggle('hidden',!items.length);
    if($('notificationBadge'))$('notificationBadge').textContent=Math.min(items.length,99);
    renderNotificationHistory(items);
    return items;
  }catch(e){
    console.warn('alert history',e.message);
    const list=$('notificationList');
    if(list)list.innerHTML='<div class="small">تعذر تحميل سجل التنبيهات الآن.</div>';
    return [];
  }
}
async function loadActiveNotifications(){
  try{
    const d=await getJSON('/.netlify/functions/alerts?action=settings');
    alertSettings=d.settings||{};
    telegramState=d.telegram||telegramState;
    renderTelegramLinkState();
    renderActiveNotifications(alertSettings);
    return alertSettings;
  }catch(e){
    console.warn('active alerts',e.message);
    const list=$('activeNotificationList');
    if(list)list.innerHTML='<div class="small">تعذر تحميل التنبيهات المفعلة الآن.</div>';
    return {};
  }
}
async function openNotificationBell(){
  const panel=$('notificationPanel');
  const setup=$('telegramFirstSetup');
  const active=$('activeNotificationList');
  const list=$('notificationList');
  if(!panel)return;
  panel.classList.add('show');
  if(active)active.innerHTML='<div class="small">جاري تحميل التنبيهات المفعلة...</div>';
  if(list)list.innerHTML='<div class="small">جاري تحميل سجل التنبيهات...</div>';
  try{
    const d=await getJSON('/.netlify/functions/alerts?action=telegram-link',1);
    telegramState=d.telegram||{linked:false,link:null};
    renderTelegramLinkState();
    if(setup){
      if(telegramState.linked){setup.style.display='none';}
      else{setup.style.display='block';const link=$('telegramFirstSetupLink');if(link){link.href=telegramState.link||'#';link.style.display=telegramState.link?'inline-flex':'none';}}
    }
  }catch(e){
    console.warn('telegram link',e.message);
    if(setup)setup.style.display='none';
  }
  await Promise.allSettled([loadActiveNotifications(),loadNotificationHistory()]);
  // Never leave the panel in a perpetual loading state.
  if(active && /جاري تحميل/.test(active.textContent||''))active.innerHTML='<div class="small">تعذر تحميل التنبيهات المفعلة الآن. حاول مرة أخرى.</div>';
  if(list && /جاري تحميل/.test(list.textContent||''))list.innerHTML='<div class="small">تعذر تحميل سجل التنبيهات الآن. حاول مرة أخرى.</div>';
}

const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iso=d=>d.toISOString().slice(0,10);
const fmt=(n,d=2)=>Number.isFinite(Number(n))?Number(n).toFixed(d):"—";
function setStatus(x,c=""){ $("status").className="status "+c; $("status").innerHTML=x; }
async function getJSON(url,retries=3,signal){
  for(let attempt=0;attempt<=retries;attempt++){
    const controller=new AbortController();
    const onAbort=()=>controller.abort();
    if(signal?.aborted)throw Error('تم إلغاء الطلب.');
    signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const r=await apiFetch(url,{signal:controller.signal}); const t=await r.text(); let d={}; try{d=t?JSON.parse(t):{}}catch{throw Error("الخادم أعاد استجابة غير JSON (HTTP "+r.status+"). "+t.slice(0,180))}
      if(r.ok&&!d.error)return d;
      if((r.status===429||r.status>=500)&&attempt<retries){await sleep(Math.min(8000,1000*Math.pow(2,attempt)));continue}
      if(r.status===401)throw Error(d.error||"انتهت الجلسة أو الحماية الخارجية للموقع. أعد تحميل الصفحة ثم سجّل الدخول من جديد.");
      throw Error("HTTP "+r.status+" "+(d.error||d.message||"API error"));
    }catch(e){
      if(e?.name==='AbortError' && attempt<retries){if(attempt<retries)continue;}
      if(attempt<retries && (e?.name==='AbortError'||/timeout|المهلة/i.test(String(e?.message||''))))continue;
      throw e;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
}
function massive(path){return "/.netlify/functions/massive?path="+encodeURIComponent(path)}
function chart(path){return "/.netlify/functions/chartexchange?path="+encodeURIComponent(path)}
function massiveFromUrl(u){try{let x=new URL(u);return massive(x.pathname+x.search)}catch{return null}}

let scannerCache=null, scannerCacheUpdatedAt=null, scannerIPOs=[], scannerIpoUpdatedAt=null, scannerIpoSearchDone=false, scannerTechnicalUpdatedAt=null, scannerShortUpdatedAt=null;
async function loadScannerCache(options={}){
  // The scanner is an in-memory snapshot: after the first successful preload,
  // filtering/search must never make a network request. Background refreshes
  // can call this with force:true when a new snapshot is explicitly needed.
  if(!options.force && Array.isArray(scannerCache) && scannerCache.length && scannerCacheUpdatedAt){
    return {ok:true,ready:true,records:scannerCache,ipos:scannerIPOs,updatedAt:scannerCacheUpdatedAt,ipoUpdatedAt:scannerIpoUpdatedAt,technicalUpdatedAt:scannerTechnicalUpdatedAt,shortUpdatedAt:scannerShortUpdatedAt};
  }
  const wait=Boolean(options.wait), maxAttempts=Math.max(1,Math.min(60,Number(options.maxAttempts)||60));
  let triggered=false;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const r=await apiFetch('/.netlify/functions/scanner-cache');
    const d=await responseJSON(r);
    if(!r.ok)throw Error(d.error||'تعذر تحميل بيانات الباحث.');
    if(d.ready){const incoming=Array.isArray(d.records)?d.records:[];if(incoming.length||!Array.isArray(scannerCache)||!scannerCache.length){scannerCache=incoming.map(x=>({...x,freeFloat:Number.isFinite(Number(x?.freeFloat))?Number(x.freeFloat):(Number.isFinite(Number(x?.free_float))?Number(x.free_float):null),free_float:Number.isFinite(Number(x?.freeFloat))?Number(x.freeFloat):(Number.isFinite(Number(x?.free_float))?Number(x.free_float):null)}));scannerIPOs=Array.isArray(d.ipos)?d.ipos:[];scannerIpoUpdatedAt=d.ipoUpdatedAt||scannerIpoUpdatedAt;scannerCacheUpdatedAt=d.updatedAt||scannerCacheUpdatedAt;scannerTechnicalUpdatedAt=d.technicalUpdatedAt||d.fullRefreshAt||d.updatedAt||scannerTechnicalUpdatedAt;scannerShortUpdatedAt=d.shortUpdatedAt||d.borrowUpdatedAt||scannerShortUpdatedAt;updateDataFreshness();}return {...d,records:scannerCache||[]};}
    scannerCache=[];scannerCacheUpdatedAt=null;
    if(!triggered){
      triggered=true;
      // The cache endpoint starts the protected background build server-side.
      // Do not call scanner-cache-worker directly from the browser.
      if(d.message) d.message = 'سيتم تشغيل تجهيز البيانات في الخلفية.';
    }
    if(!wait||attempt===maxAttempts)return d;
    setStatus(d.buildError?`تعذر تشغيل تجهيز بيانات الباحث: ${escapeHtml(d.buildError)}`:`جاري تجهيز بيانات الباحث لأول مرة… ${attempt}/${maxAttempts}`);
    await sleep(3000);
  }
  return {ready:false,records:[]};
}
function freshnessLabel(v){
  if(!v)return 'غير متوفر';
  const t=new Date(v).getTime(); if(!Number.isFinite(t))return 'غير متوفر';
  const diff=Math.max(0,Date.now()-t), mins=Math.floor(diff/60000), hrs=Math.floor(mins/60), days=Math.floor(hrs/24);
  const ago=days?`قبل ${days} يوم`:hrs?`قبل ${hrs} ساعة`:mins?`قبل ${mins} دقيقة`:'الآن';
  const exact=new Date(v).toLocaleString('ar-SA');
  return `${ago} (${exact})`;
}
function updateDataFreshness(){const el=$("dataFreshness");if(el)el.textContent=`البيانات الفنية: ${freshnessLabel(scannerTechnicalUpdatedAt)}  |  بيانات الشورت: ${freshnessLabel(scannerShortUpdatedAt)}`;const ipo=$("ipoStatus");if(ipo&&!scannerIpoSearchDone)ipo.textContent=`آخر تحديث لقائمة الاكتتابات: ${scannerIpoUpdatedAt?new Date(scannerIpoUpdatedAt).toLocaleString('ar-SA'):'غير متوفر'}.`;}
setInterval(updateDataFreshness,60000);
function cacheAgeText(){if(!scannerCacheUpdatedAt)return '';const d=Math.max(0,Date.now()-new Date(scannerCacheUpdatedAt).getTime());const h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000);return h?`آخر تحديث قبل ${h} س`:m?`آخر تحديث قبل ${m} د`:'تم التحديث الآن';}
function cacheFind(f){if(!Array.isArray(scannerCache))return null;return scannerCache.find(x=>x.ticker===f.ticker&&x.splitDate===(f.splitDate||''))||scannerCache.find(x=>x.ticker===f.ticker)||null;}
let cacheRefreshBusy=false;
async function refreshScannerCacheInBackground(){
  if(cacheRefreshBusy||document.hidden)return;
  cacheRefreshBusy=true;
  try{await loadScannerCache({force:true,maxAttempts:2});renderFavorites();}catch{}finally{cacheRefreshBusy=false;}
}
setInterval(refreshScannerCacheInBackground,120000);

// Stocks Starter: one full-market snapshot per scan for current prices.
let marketSnapshot=null;
function browserMarketSession(){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const h=Number(parts.find(x=>x.type==='hour')?.value||0),m=Number(parts.find(x=>x.type==='minute')?.value||0),mins=h*60+m;
  if(mins>=240&&mins<570)return 'pre';
  if(mins>=570&&mins<960)return 'regular';
  if(mins>=960&&mins<1200)return 'after';
  return 'closed';
}
function chooseBrowserLivePrice(x,session){
  const pre=Number(x?.preMarket?.p),after=Number(x?.afterHours?.p),last=Number(x?.lastTrade?.p),day=Number(x?.day?.c),prev=Number(x?.prevDay?.c),min=Number(x?.min?.c);
  const valid=v=>Number.isFinite(v)&&v>0?v:null;
  const lastValid=valid(last),preValid=valid(pre),afterValid=valid(after),dayValid=valid(day),prevValid=valid(prev),minValid=valid(min);
  const sessionOfTs=ts=>{const n=Number(ts);if(!Number.isFinite(n)||n<=0)return null;const d=new Date(n>1e14?n/1e3:n>1e11?n:n*1000);const q=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);const h=Number(q.find(x=>x.type==='hour')?.value||0),m=Number(q.find(x=>x.type==='minute')?.value||0),mins=h*60+m;if(mins>=240&&mins<570)return 'pre';if(mins>=570&&mins<960)return 'regular';if(mins>=960&&mins<1200)return 'after';return null;};
  const lastSession=sessionOfTs(x?.lastTrade?.t),minSession=sessionOfTs(x?.min?.t);
  if(session==='pre') return (lastSession==='pre'&&lastValid) || (minSession==='pre'&&minValid) || preValid || null;
  if(session==='regular') return (lastSession==='regular'&&lastValid) || dayValid || prevValid || null;
  if(session==='after') return (lastSession==='after'&&lastValid) || (minSession==='after'&&minValid) || afterValid || null;
  return null;
}
async function getMarketSnapshot(signal){
  if(marketSnapshot) return marketSnapshot;
  const d=await getJSON(massive("/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false&extended=true"),3,signal);
  const map=new Map(),session=browserMarketSession();
  for(const x of (d.tickers||[])){
    const price=chooseBrowserLivePrice(x,session);
    if(x.ticker && Number.isFinite(price)&&price>0) map.set(String(x.ticker).toUpperCase(),{price,raw:x,session});
  }
  marketSnapshot=map;
  return map;
}
function resetMarketSnapshot(){marketSnapshot=null}
function rsiWilder(closes,p=14){if(closes.length<p+1)return NaN;let g=0,l=0;for(let i=1;i<=p;i++){let c=closes[i]-closes[i-1];g+=Math.max(c,0);l+=Math.max(-c,0)}let ag=g/p,al=l/p;for(let i=p+1;i<closes.length;i++){let c=closes[i]-closes[i-1];ag=(ag*(p-1)+Math.max(c,0))/p;al=(al*(p-1)+Math.max(-c,0))/p}if(al===0)return 100;return 100-100/(1+ag/al)}
async function getBars(t,from,to,key,signal){let path=`/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`;return (await getJSON(massive(path),3,signal)).results||[]}
function dateFromBar(b){return Number.isFinite(Number(b?.t))?new Date(Number(b.t)).toISOString().slice(0,10):null}

async function getTickerInfo(t,key,signal){
  const path=`/v3/reference/tickers/${encodeURIComponent(t)}`;
  const d=await getJSON(massive(path),3,signal);
  return d.results||{};
}
function countryFlag(info){
  const c=String(info?.country||info?.address?.country||info?.country_code||info?.address?.country_code||"").trim().toUpperCase();
  const map={US:"🇺🇸",USA:"🇺🇸",CA:"🇨🇦",CAN:"🇨🇦",CN:"🇨🇳",CHN:"🇨🇳",HK:"🇭🇰",GB:"🇬🇧",UK:"🇬🇧",GBR:"🇬🇧",IL:"🇮🇱",ISR:"🇮🇱",AU:"🇦🇺",AUS:"🇦🇺",JP:"🇯🇵",JPN:"🇯🇵",KR:"🇰🇷",KOR:"🇰🇷",SG:"🇸🇬",SGP:"🇸🇬",IE:"🇮🇪",IRL:"🇮🇪",BR:"🇧🇷",BRA:"🇧🇷",CH:"🇨🇭",CHE:"🇨🇭",DE:"🇩🇪",DEU:"🇩🇪",FR:"🇫🇷",FRA:"🇫🇷",NL:"🇳🇱",NLD:"🇳🇱",IN:"🇮🇳",IND:"🇮🇳",TW:"🇹🇼",TWN:"🇹🇼"};
  return map[c]||"";
}
function annual52Week(bars){
  const rows=(Array.isArray(bars)?bars:[]).filter(b=>b&&b.t!=null&&b.h!=null&&b.l!=null).map(b=>({h:Number(b.h),l:Number(b.l),t:Number(b.t)})).filter(x=>Number.isFinite(x.h)&&Number.isFinite(x.l)&&Number.isFinite(x.t));
  if(!rows.length)return {high52:null,low52:null};
  return {high52:Math.max(...rows.map(x=>x.h)),low52:Math.min(...rows.map(x=>x.l))};
}
async function getSplits(days,key,signal){
  // Massive splits endpoint: fetch every split event in the requested window.
  // Exchange filtering is applied from the authoritative ticker reference so
  // NASDAQ, NYSE and NYSE American are all covered.
  const to=new Date(), from=new Date(to.getTime()-Math.min(100,Math.max(1,Number(days)||60))*86400000);
  let out=[], next=massive(`/stocks/v1/splits?execution_date.gte=${iso(from)}&execution_date.lte=${iso(to)}&sort=execution_date.asc&limit=5000`);
  while(next){
    const d=await getJSON(next,3,signal);
    out.push(...(Array.isArray(d.results)?d.results:[]));
    next=d.next_url?massiveFromUrl(d.next_url):null;
  }
  return out.filter(s=>s && s.ticker && s.execution_date);
}
function clampScannerDays(){const el=$("days");if(!el)return;let v=Math.floor(Number(el.value)||60);v=Math.max(1,Math.min(100,v));if(Number(el.value)!==v)el.value=String(v);return v;}
let scannerSettingsSaveTimer=null;
function scannerSettingsObject(){clampScannerDays();return {days:$('days')?.value||60,maxPrice:$('maxPrice')?.value||10,drop:$('drop')?.value||0,rsiMax:$('rsiMax')?.value||30,shortMax:$('shortMax')?.value||""};}
async function saveScannerSettingsRemote(){try{const o=scannerSettingsObject();localStorage.setItem("nasdaq_scanner_settings_v2",JSON.stringify(o));if(!sessionReady)return;await apiFetch("/.netlify/functions/auth?action=scanner-settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});}catch{}}
async function saveScannerSettings(){
  try{
    const o=scannerSettingsObject();
    localStorage.setItem("nasdaq_scanner_settings_v2",JSON.stringify(o));
    if(sessionReady){
      const r=await apiFetch("/.netlify/functions/auth?action=scanner-settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});
      if(!r.ok) throw Error("تعذر حفظ الفلتر على الحساب.");
    }
    const msg=$("scannerSettingsMsg");
    if(msg){msg.textContent="تم حفظ بيانات الفلتر. لن تتغير حتى تضغط حفظ من جديد.";msg.className="small ok";}
    return true;
  }catch(e){
    const msg=$("scannerSettingsMsg");
    if(msg){msg.textContent=e?.message||"تعذر حفظ بيانات الفلتر.";msg.className="small err";}
    return false;
  }
}
async function loadScannerSettings(){
  try{
    const local=JSON.parse(localStorage.getItem("nasdaq_scanner_settings_v2")||"{}");
    ["days","maxPrice","drop","rsiMax","shortMax"].forEach(id=>{if(local[id]!=null&&$(id))$(id).value=local[id]});
    clampScannerDays();
    if(sessionReady){
      const r=await apiFetch("/.netlify/functions/auth?action=scanner-settings");const d=await responseJSON(r);
      if(r.ok&&d.settings){const o=d.settings;["days","maxPrice","drop","rsiMax","shortMax"].forEach(id=>{if(o[id]!=null&&$(id))$(id).value=o[id]});clampScannerDays();localStorage.setItem("nasdaq_scanner_settings_v2",JSON.stringify(scannerSettingsObject()));}
    }
  }catch{}
}
function updateStats(){$("statScanned").textContent=scanned.toLocaleString();$("statMatches").textContent=results.toLocaleString();$("statUpdated").textContent=new Date().toLocaleString("ar-SA");$("exportCsv").disabled=results===0;}
function updateSearchDataTime(){const el=$("searchUpdatedAt");if(!el)return;const stamp=scannerCacheUpdatedAt?new Date(scannerCacheUpdatedAt):new Date();el.textContent=`آخر تحديث للبيانات: ${stamp.toLocaleString("ar-SA")}`;}
function csvCell(v){return '"'+String(v??"").replace(/"/g,'""')+'"'}
function exportResultsCsv(){
  const table=document.querySelector("#results")?.closest("table"); if(!table)return;
  const headers=["Ticker","Favorite","Split Open","Target","Current Price","Drop %","Split Date","RSI","Low","Low Date","IBKR Available Shares","IBKR Borrow Fee","Free Float"];
  const cells=[...document.querySelectorAll("#results tr")].map(tr=>[...tr.cells].map(td=>td.textContent.trim()));
  const rows=cells.map(r=>r.slice(0,10).concat(r.slice(12,15)));
  if(!rows.length)return;
  const csv="\ufeffsep=,\r\n"+[headers,...rows].map(r=>r.map(csvCell).join(",")).join("\r\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`nasdaq-scanner-${new Date().toISOString().slice(0,10)}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function isFavorite(ticker,splitDate){return favoriteItems.some(x=>x.ticker===ticker&&x.splitDate===splitDate)}
let favoriteWriteQueue=Promise.resolve();
function favoriteKey(x){return `${x.ticker}__${x.splitDate||''}`}
function sameFavoriteState(a,b){return JSON.stringify((a||[]).map(x=>({ticker:x.ticker,splitDate:x.splitDate||'',splitOpen:x.splitOpen??null})))===JSON.stringify((b||[]).map(x=>({ticker:x.ticker,splitDate:x.splitDate||'',splitOpen:x.splitOpen??null})));}
function toggleFavorite(item){
  const key=favoriteKey(item), on=isFavorite(item.ticker,item.splitDate);
  if(on) favoriteItems=favoriteItems.filter(x=>favoriteKey(x)!==key);
  else favoriteItems=[item,...favoriteItems.filter(x=>favoriteKey(x)!==key)];
  updateFavoriteButtons();renderFavorites();
  const snapshot=favoriteItems.map(x=>({...x}));
  favoriteWriteQueue=favoriteWriteQueue.then(async()=>{
    const r=await apiFetch('/.netlify/functions/auth?action=favorites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:snapshot})});
    const d=await responseJSON(r);if(!r.ok)throw Error(d.error||'تعذر تحديث المفضلة.');
    if(sameFavoriteState(favoriteItems,snapshot)){favoriteItems=d.favorites||snapshot;renderFavorites();updateFavoriteButtons();}
  }).catch(e=>{console.warn('favorites sync',e.message);loadFavorites();});
  return favoriteWriteQueue;
}
function updateFavoriteButtons(){document.querySelectorAll('.favToggle').forEach(b=>{const on=isFavorite(b.dataset.ticker,b.dataset.split);b.textContent=on?'★':'☆';b.classList.toggle('on',on);b.title=on?'إزالة من المفضلة':'إضافة إلى المفضلة';});}
function displayPrice(stock){
  const session=String(stock?.priceSession||"").toLowerCase();
  const pre=Number(stock?.preMarketPrice);
  const after=Number(stock?.afterHoursPrice);
  const current=Number(stock?.currentPrice ?? stock?.current);
  const finvizPre=Number(stock?.finvizPreMarketPrice);
  const finvizAfter=Number(stock?.finvizAfterHoursPrice);
  const finvizPrice=Number(stock?.finvizPrice);
  const close=Number(stock?.closePrice);
  if(session==="pre"&&Number.isFinite(pre)&&pre>0)return pre;
  if(session==="pre"&&Number.isFinite(finvizPre)&&finvizPre>0)return finvizPre;
  if(session==="after"&&Number.isFinite(after)&&after>0)return after;
  if(session==="after"&&Number.isFinite(finvizAfter)&&finvizAfter>0)return finvizAfter;
  if(Number.isFinite(current)&&current>0)return current;
  if(Number.isFinite(finvizPrice)&&finvizPrice>0)return finvizPrice;
  if(session==="pre"&&Number.isFinite(pre)&&pre>0)return pre;
  if(session==="after"&&Number.isFinite(after)&&after>0)return after;
  return Number.isFinite(close)&&close>0?close:null;
}
let currentPricesUpdatedAt=null,currentPriceSession="closed",currentPriceTimer=null;
async function loadCurrentPrices(){
  try{
    const r=await apiFetch('/.netlify/functions/scanner-current');
    const d=await responseJSON(r);
    if(!r.ok||!d.ok)return false;
    currentPricesUpdatedAt=d.updatedAt||null; currentPriceSession=d.session||'closed';
    const map=d.records||{};
    if(Array.isArray(scannerCache)){
      for(const row of scannerCache){
        const live=map[String(row?.ticker||'').toUpperCase()];
        if(!live)continue;
        row.current=live.price; row.currentPrice=live.price; row.preMarketPrice=live.preMarket; row.afterHoursPrice=live.afterHours; row.priceSession=live.priceSession; row.priceSource=live.priceSource; row.currentUpdatedAt=live.updatedAt; row.changePct=live.changePct;
      }
      updateVisibleCurrentPrices();
    }
    return true;
  }catch(e){console.warn('[current-price] refresh failed',e?.message||e);return false;}
}
function updateVisibleCurrentPrices(){
  document.querySelectorAll('#results tr[data-ticker]').forEach(tr=>{
    const x=cacheFind({ticker:tr.dataset.ticker,splitDate:tr.dataset.split||''}); if(!x)return;
    const price=displayPrice(x),open=Number(x.splitOpen);
    if(tr.cells[4])tr.cells[4].textContent=Number.isFinite(price)?'$'+fmt(price):'—';
    if(tr.cells[5])tr.cells[5].textContent=Number.isFinite(price)&&Number.isFinite(open)&&open>0?fmt((open-price)/open*100)+'%':'—';
  });
  if(currentPricesUpdatedAt){
    const el=$("currentPriceFreshness");
    if(el)el.textContent=`السعر الحالي: ${freshnessLabel(currentPricesUpdatedAt)} — ${currentPriceSession==="pre"?'بري ماركت':currentPriceSession==="regular"?'الماركت':currentPriceSession==="after"?'أفتر ماركت':'خارج الجلسة'}`;
  }
}
function startCurrentPriceRefresh(){
  clearInterval(currentPriceTimer);
  loadCurrentPrices();
  currentPriceTimer=setInterval(()=>{if(document.visibilityState==='visible'&&sessionReady)loadCurrentPrices();},15000);
}
function formatCompactShares(value){
  const n=Number(value); if(!Number.isFinite(n)||n<=0)return '—';
  if(n>=1e9)return `${Number((n/1e9).toFixed(1)).toLocaleString('en-US')}B`;
  if(n>=1e6)return `${Number((n/1e6).toFixed(1)).toLocaleString('en-US')}M`;
  if(n>=1e3)return `${Number((n/1e3).toFixed(1)).toLocaleString('en-US')}K`;
  return String(Math.round(n));
}
function addRow(r){
  const tr=document.createElement('tr');tr.dataset.ticker=r.ticker;tr.dataset.split=r.splitDate||'';
  tr.innerHTML=`<td><b>${r.flag?r.flag+' ':''}${escapeHtml(r.ticker)}</b></td><td class="favCell"><button class="favBtn favToggle" data-ticker="${escapeHtml(r.ticker)}" data-split="${escapeHtml(r.splitDate||'')}" title="إضافة إلى المفضلة">${isFavorite(r.ticker,r.splitDate)?'★':'☆'}</button></td><td>$${fmt(r.splitOpen)}</td><td>$${fmt(r.target)}</td><td>${Number.isFinite(displayPrice(r))?'$'+fmt(displayPrice(r)):'—'}</td><td>${fmt(r.drop)}%</td><td>${r.splitDate||'—'}</td><td>${fmt(r.rsi)}</td><td>$${fmt(r.low)}</td><td>${r.lowDate||'—'}</td><td>${Number.isFinite(Number(r.shortShares))?Number(r.shortShares).toLocaleString():'—'}</td><td>${Number.isFinite(Number(r.borrowFee))?fmt(r.borrowFee,2)+'%':'—'}</td><td>${formatCompactShares(r.freeFloat)}</td>`;
  tr.querySelector('.favToggle').onclick=()=>toggleFavorite({ticker:r.ticker,splitDate:r.splitDate,splitOpen:r.splitOpen});$('results').prepend(tr);results++;$('count').textContent=results;return tr;
}

async function getBars4H(t,from,to,key,signal){const path=`/v2/aggs/ticker/${encodeURIComponent(t)}/range/4/hour/${from}/${to}?adjusted=true&sort=asc&limit=50000`;const rows=(await getJSON(massive(path),3,signal)).results||[];return rows.filter(b=>Number(b?.l)>0&&Number(b?.h)>0&&Number(b?.c)>0);}
function daysSinceDate(dateStr){
  if(!dateStr)return null;
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr); if(!m)return null;
  const d=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1])));
  const now=new Date(),today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  return Math.max(0,Math.floor((today-d)/86400000));
}
function tradingDaysSinceDate(bars,dateStr){
  if(!dateStr||!Array.isArray(bars))return null;
  const dates=new Set(bars.map(dateFromBar).filter(Boolean));
  return [...dates].filter(d=>d>dateStr).length;
}
function lowest4H(bars,splitDate){
  const rows=(Array.isArray(bars)?bars:[]).filter(b=>b&&b.l!=null&&b.t!=null).map(b=>({low:Number(b.l),t:Number(b.t)})).filter(x=>Number.isFinite(x.low)&&x.low>0&&Number.isFinite(x.t)).filter(x=>!splitDate||new Date(x.t).toISOString().slice(0,10)>=splitDate).sort((a,b)=>a.t-b.t);
  if(!rows.length)return {low4h:null,low4hTime:null};
  const hit=rows.reduce((a,b)=>b.low<a.low?b:a),d=new Date(hit.t);
  return {low4h:hit.low,low4hTime:d.toLocaleDateString("en-GB",{timeZone:"Asia/Riyadh",year:"numeric",month:"2-digit",day:"2-digit"})};
}
async function enrich4H(t,splitDate,row,offset=10,signal){
  try{
    if(stopped)return;
    const x=lowest4H(await getBars4H(t,splitDate,iso(new Date()),"server",signal),splitDate);
    if(stopped)return;
    row.cells[offset].textContent=x.low4h!=null?`$${fmt(x.low4h)}`:"—";
    row.cells[offset+1].textContent=x.low4hTime||"—";
    if(x.low4hTime){
      const daily=await getBars(t,x.low4hTime.split("/").reverse().join("-"),iso(new Date()),"server",signal);
      const td=tradingDaysSinceDate(daily,x.low4hTime.split("/").reverse().join("-"));
      row.cells[offset+2].textContent=td!=null?`${td} يوم تداول`:"—";
    }else row.cells[offset+2].textContent="—";
  }catch(e){console.warn("4H unavailable",t,e.message)}
}
async function checkOne(t,splitDate,key,dropPct,rsiMax,maxPrice,shortMax,snapshot,signal){
 try{
   if(stopped)return null;
   const end=new Date(),snapPrice=Number(snapshot?.get(t)?.price);
   if(Number.isFinite(snapPrice)&&snapPrice>0&&snapPrice>maxPrice)return null;
   const lookbackStart=new Date(end.getTime()-120*86400000);
   const bars=await getBars(t,iso(lookbackStart),iso(end),key,signal); if(!bars.length)return null;
   const splitIndex=bars.findIndex(b=>dateFromBar(b)===splitDate); if(splitIndex<0)return null;
   const splitOpen=Number(bars[splitIndex].o),current=(Number.isFinite(snapPrice)&&snapPrice>0)?snapPrice:Number(bars[bars.length-1].c);
   if(!Number.isFinite(splitOpen)||!Number.isFinite(current)||current>maxPrice)return null;
   const target=splitOpen*(1-dropPct/100); if(current>target)return null;
   const rsi=rsiWilder(bars.map(x=>Number(x.c)),14); if(!Number.isFinite(rsi)||rsi>=rsiMax)return null;
   const info=await getTickerInfo(t,key,signal); if(!["XNAS","XNYS","XASE"].includes(String(info.primary_exchange||"")))return null;
   const postSplitBars=bars.slice(splitIndex); let low=Infinity,lowIndex=-1;
   for(let i=0;i<postSplitBars.length;i++){const v=Number(postSplitBars[i].l);if(Number.isFinite(v)&&v<low){low=v;lowIndex=i}}
   if(!Number.isFinite(low)||lowIndex<0)return null;
   const lowDate=dateFromBar(postSplitBars[lowIndex]),sinceLow=postSplitBars.length-1-lowIndex;
   return {hit:true,ticker:t,splitDate,splitOpen,target,current,drop:(splitOpen-current)/splitOpen*100,rsi,low,lowDate,sinceLow,flag:countryFlag(info)};
 }catch(e){return {error:e.message}}
}
function getBorrowFromCache(stock){return {shares:stock?.shortShares!=null?Number(stock.shortShares):null,fee:stock?.borrowFee!=null?Number(stock.borrowFee):null,freeFloat:stock?.freeFloat!=null?Number(stock.freeFloat):null};}
async function run(){
 if(running)return; running=true;stopped=false;paused=false;scanAbortController=new AbortController();const signal=scanAbortController.signal;results=0;scanned=0;$("results").innerHTML="";$("count").textContent="0";$("start").disabled=true;$("pause").disabled=false;$("resume").disabled=true;$("stop").disabled=false;$("stop").textContent="■ إيقاف نهائي";updateStats();
 try{
   const days=clampScannerDays(),drop=Number($("drop").value)||0,rsiMax=Number($("rsiMax").value)||30,maxPrice=Number($("maxPrice").value)||10; const shortRaw=$("shortMax").value.trim(); const shortMax=shortRaw===""?null:Math.max(0,Number(shortRaw));
   setStatus("جاري البحث...");
   const cache=await loadScannerCache({wait:true,maxAttempts:180});
   if(!cache.ready||!scannerCache.length){setStatus(cache.buildError?`فشل تجهيز بيانات الباحث: ${escapeHtml(cache.buildError)}`:"بيانات الباحث قيد التجهيز لأول مرة. انتظر اكتمال الكاش ثم اضغط بحث مرة أخرى.","err");return;}
   // IMPORTANT: search runs only against the already-preloaded snapshot.
   // Current-price refresh happens independently in the background; it must
   // never delay a user's search click.
   const cutoff=new Date(Date.now()-days*86400000).toISOString().slice(0,10);
   const selectedExchange=$("splitExchange")?.value||"ALL";
   const candidates=scannerCache.filter(x=>(selectedExchange==='ALL'||x.primaryExchange===selectedExchange||x.exchange===selectedExchange)&&x.splitDate>=cutoff&&Number.isFinite(Number(x.current))&&Number.isFinite(Number(x.splitOpen))&&Number(x.current)<=maxPrice&&Number(x.current)<=Number(x.splitOpen)*(1-drop/100)&&Number.isFinite(Number(x.rsi))&&Number(x.rsi)<=rsiMax&&(shortMax==null||(Number.isFinite(Number(x.shortShares))&&Number(x.shortShares)<=shortMax)));
   setStatus("جاري البحث...");
   for(let i=0;i<candidates.length&&!stopped;i++){while(paused&&!stopped)await sleep(250);if(stopped)break;const x=candidates[i];setStatus("جاري البحث...");addRow({...x,target:Number(x.splitOpen)*(1-drop/100),drop:(Number(x.splitOpen)-Number(x.current))/Number(x.splitOpen)*100});scanned++;updateStats();if(i%25===0)await sleep(0);}
   updateSearchDataTime();
   if(stopped)setStatus(`تم الإيقاف. النتائج: <b>${results}</b>.`);else setStatus(`تم العثور على ${results} نتيجة.`,"ok");
 }catch(e){if(e?.name!=="AbortError"&&!stopped)setStatus("خطأ: "+e.message,"err")} finally{running=false;scanAbortController=null;$("start").disabled=false;$("stop").disabled=true;$("stop").textContent="■ إيقاف";$("pause").disabled=true;$("resume").disabled=true;}
}
$("start").onclick=run;
$("pause").onclick=()=>{if(!running||stopped)return;paused=true;$("pause").disabled=true;$("resume").disabled=false;setStatus(`⏸ البحث متوقف مؤقتًا — النتائج الحالية: <b>${results}</b>.`);};
$("resume").onclick=()=>{if(!running||stopped)return;paused=false;$("pause").disabled=false;$("resume").disabled=true;setStatus(`▶ تم استئناف البحث — النتائج الحالية: <b>${results}</b>.`);};
$("stop").onclick=()=>{if(!running)return;stopped=true;paused=false;if(scanAbortController)scanAbortController.abort();$("stop").disabled=true;$("pause").disabled=true;$("resume").disabled=true;$("stop").textContent="⏹ جارٍ الإيقاف...";setStatus(`جارٍ إيقاف البحث... النتائج الحالية: <b>${results}</b>.`);};

async function loadFavorites(){try{const r=await apiFetch('/.netlify/functions/auth?action=favorites');const d=await responseJSON(r);if(!r.ok)throw Error(d.error||'تعذر تحميل المفضلة.');favoriteItems=d.favorites||[];renderFavorites();if(favoriteItems.length){$('favoritesStatus').textContent='جاري تحديث بيانات المفضلة…';await refreshFavoriteData(true);}}catch(e){if(sessionReady)$('favoritesStatus').textContent=e.message||'تعذر تحميل المفضلة.';}}
function renderFavorites(){const body=$('favoritesResults');if(!body)return;body.innerHTML='';$('favoritesCount').textContent=favoriteItems.length.toLocaleString();$('favoritesEmpty').style.display=favoriteItems.length?'none':'block';for(const f of favoriteItems){const tr=document.createElement('tr');tr.dataset.ticker=f.ticker;tr.dataset.split=f.splitDate||'';tr.innerHTML=`<td><div class="favTickerCell"><button class="favRemoveMini" title="إزالة من المفضلة">★</button><b>${escapeHtml(f.ticker)}</b></div></td><td><button class="alertBtn ${alertSettings[f.ticker]?.enabled?"on":""}" title="إعداد تنبيه السهم">🔔</button></td><td class="fv-price">—</td><td><button class="testBtn favTest">🧪 اختبار</button></td><td><button class="detailsBtn favDetails">عرض التفاصيل</button></td><td class="fv-short">—</td><td class="fv-fee">—</td><td class="fv-float">—</td><td class="fv-change">—</td>`;tr.querySelector('.favRemoveMini').onclick=()=>toggleFavorite({ticker:f.ticker,splitDate:f.splitDate});tr.querySelector('.alertBtn').onclick=()=>openAlertModal(f);tr.querySelector('.favTest').onclick=()=>runFavoriteTest(f,tr);tr.querySelector('.favDetails').onclick=()=>runFavoriteDetails(f,tr);body.appendChild(tr);}}
function emaSeries(values,period){if(!Array.isArray(values)||values.length<period)return [];const k=2/(period+1);let ema=values.slice(0,period).reduce((a,b)=>a+b,0)/period;const out=[ema];for(let i=period;i<values.length;i++){ema=(values[i]-ema)*k+ema;out.push(ema);}return out;}
function cciValue(bars,period=14){if(!Array.isArray(bars)||bars.length<period)return NaN;const tp=bars.map(b=>(Number(b.h)+Number(b.l)+Number(b.c))/3);const w=tp.slice(-period),mean=w.reduce((a,b)=>a+b,0)/period,dev=w.reduce((a,b)=>a+Math.abs(b-mean),0)/period;return dev===0?0:(tp[tp.length-1]-mean)/(0.015*dev);}
function completedDailyBars(bars){const today=new Date().toISOString().slice(0,10);return (bars||[]).filter(b=>dateFromBar(b)&&dateFromBar(b)<today);}
function dailyChange(current,raw,bars){const prev=Number(raw?.prevDay?.c);if(Number.isFinite(current)&&Number.isFinite(prev)&&prev!==0)return (current-prev)/prev*100;const done=completedDailyBars(bars);if(done.length<2)return NaN;const a=Number(done[done.length-1].c),b=Number(done[done.length-2].c);return Number.isFinite(a)&&Number.isFinite(b)&&b!==0?(a-b)/b*100:NaN;}
function showTestLoading(f){$("testTitle").textContent="اختبار السهم — "+f.ticker;$("testRows").innerHTML='<div class="testRow"><span class="testLabel">الحالة</span><span class="testValue">جاري تحميل التفاصيل…</span></div>';$("testNote").textContent="تم فتح النافذة فورًا، وجاري تجهيز البيانات…";$("testModal").classList.add("show");}
function showDetailsLoading(f){$("detailsTitle").textContent="تفاصيل السهم — "+f.ticker;$("detailsRows").innerHTML='<div class="testRow"><span class="testLabel">الحالة</span><span class="testValue">جاري تحميل التفاصيل…</span></div>';$("detailsNote").textContent="تم فتح النافذة فورًا، وجاري تجهيز البيانات…";$("detailsModal").classList.add("show");}
async function runFavoriteTest(f,tr){
 const btn=tr?.querySelector('.favTest');if(btn)btn.disabled=true;
 showTestLoading(f);
 try{
   // Test uses only the already-loaded scanner snapshot. Never make a new
   // browser request here: Netlify Access can return an HTML Login Redirect
   // (HTTP 401), and the test is supposed to be instant and cache-only.
   const x=cacheFind(f);
   if(!x) throw Error('بيانات هذا السهم غير موجودة في الكاش الحالي.');
   const current=Number(displayPrice(x));
   const splitOpen=Number(x.splitOpen);
   const target=Number.isFinite(splitOpen)?splitOpen*(1-Number($('drop').value||0)/100):NaN;
   const rows=[
    ['السعر الحالي',Number.isFinite(current)?'$'+fmt(current):'غير متاح'],
    ['MA 5 — يومي',Number.isFinite(Number(x.ma5))?'$'+fmt(x.ma5):'غير متاح'],
    ['MA 20 — يومي',Number.isFinite(Number(x.ma20))?'$'+fmt(x.ma20):'غير متاح'],
    ['EMA 20 — يومي',Number.isFinite(Number(x.ema20))?'$'+fmt(x.ema20):'غير متاح'],
    ['EMA 50 — يومي',Number.isFinite(Number(x.ema50))?'$'+fmt(x.ema50):'غير متاح'],
    ['CCI — يومي (14)',Number.isFinite(Number(x.cci))?fmt(x.cci):'غير متاح'],
    ['قاع 4H',Number.isFinite(Number(x.low4h))?'$'+fmt(x.low4h):'غير متاح'],
    ['تاريخ قاع 4H',x.low4hDate||'غير متاح'],
    ['مضى على قاع 4H',Number.isFinite(Number(x.low4hDays))?Number(x.low4hDays)+' يوم تداول':'غير متاح'],
    ['البعد عن قاع 4H',Number.isFinite(current)&&Number.isFinite(Number(x.low4h))&&Number(x.low4h)!==0?fmt((current-Number(x.low4h))/Number(x.low4h)*100)+'%':'غير متاح'],
    ['مضى على التقسيم',Number.isFinite(Number(x.sinceSplit))?Number(x.sinceSplit)+' يوم تداول':'غير متاح'],
    ['مضى على القاع اليومي',Number.isFinite(Number(x.sinceLow))?Number(x.sinceLow)+' يوم تداول':'غير متاح'],
    ['أعلى سعر 52 أسبوعًا',Number.isFinite(Number(x.high52))?'$'+fmt(x.high52):'غير متاح'],
    ['أدنى سعر 52 أسبوعًا',Number.isFinite(Number(x.low52))?'$'+fmt(x.low52):'غير متاح'],
    ['Free Float',Number.isFinite(Number(x.freeFloat))?Number(x.freeFloat).toLocaleString():'غير متاح'],
    ['IBKR Available Shares',Number.isFinite(Number(x.shortShares))?Number(x.shortShares).toLocaleString():'غير متاح'],
    ['IBKR Borrow Fee',Number.isFinite(Number(x.borrowFee))?fmt(x.borrowFee,2)+'%':'غير متاح'],
    ['تاريخ تحديث البيانات',x.updatedAt?new Date(x.updatedAt).toLocaleString('ar-SA'):'غير متاح']
   ];
   $('testTitle').textContent='اختبار السهم — '+x.ticker;
   $('testRows').innerHTML=rows.map(r=>`<div class="testRow"><span class="testLabel">${escapeHtml(r[0])}</span><span class="testValue">${escapeHtml(r[1])}</span></div>`).join('');
   $('testNote').textContent='تم عرض البيانات المحفوظة حاليًا.';
   $('testModal').classList.add('show');
 }catch(e){
   $('testRows').innerHTML='<div class="testRow"><span class="testLabel">خطأ</span><span class="testValue">'+escapeHtml(e.message||'تعذر الاختبار')+'</span></div>';
   $('testNote').textContent='تعذر إكمال الاختبار.';
 }finally{if(btn)btn.disabled=false;}
}

async function runFavoriteDetails(f,tr){
 const btn=tr?.querySelector('.favDetails');if(btn)btn.disabled=true;
 showDetailsLoading(f);
 try{await loadScannerCache();const x=cacheFind(f);if(!x)throw Error('بيانات هذا السهم غير موجودة في التخزين الحالي.');const dropPct=Number.isFinite(Number(x.splitOpen))&&Number.isFinite(Number(x.current))?(Number(x.splitOpen)-Number(x.current))/Number(x.splitOpen)*100:NaN;const rows=[['السهم',x.ticker],['افتتاح يوم التقسيم',Number.isFinite(Number(x.splitOpen))?'$'+fmt(x.splitOpen):'غير متاح'],['الهدف',Number.isFinite(Number(x.splitOpen))?'$'+fmt(Number(x.splitOpen)*(1-Number($('drop').value||0)/100)):'غير متاح'],['السعر الحالي',Number.isFinite(displayPrice(x))?'$'+fmt(displayPrice(x)):'غير متاح'],['نسبة الهبوط',Number.isFinite(dropPct)?fmt(dropPct)+'%':'غير متاح'],['تاريخ التقسيم',x.splitDate||'غير متاح'],['RSI (14)',Number.isFinite(Number(x.rsi))?fmt(x.rsi):'غير متاح'],['القاع',Number.isFinite(Number(x.low))?'$'+fmt(x.low):'غير متاح'],['تاريخ القاع',x.lowDate||'غير متاح'],['IBKR Available Shares',Number.isFinite(Number(x.shortShares))?Number(x.shortShares).toLocaleString():'غير متاح'],['IBKR Borrow Fee',Number.isFinite(Number(x.borrowFee))?fmt(x.borrowFee,2)+'%':'غير متاح'],['Free Float',formatCompactShares(x.freeFloat)==='—'?'غير متاح':formatCompactShares(x.freeFloat)]];$('detailsTitle').textContent='تفاصيل السهم — '+x.ticker;$('detailsRows').innerHTML=rows.map(r=>`<div class="testRow"><span class="testLabel">${escapeHtml(r[0])}</span><span class="testValue">${escapeHtml(r[1])}</span></div>`).join('');$('detailsNote').textContent='بيانات محدثة محفوظة في الموقع.';$('detailsModal').classList.add('show');}catch(e){$("detailsRows").innerHTML='<div class="testRow"><span class="testLabel">خطأ</span><span class="testValue">'+escapeHtml(e.message||'تعذر عرض التفاصيل')+'</span></div>';$("detailsNote").textContent='تعذر تحميل التفاصيل.';}finally{if(btn)btn.disabled=false;}
}
async function refreshFavoriteData(full=true){
  if(favoriteRefreshing||!favoriteItems.length)return; favoriteRefreshing=true;
  try{
    // Keep the current snapshot visible, then refresh the published cache and
    // the live-price lane. A failed live refresh must not turn existing values
    // into dashes.
    if(!Array.isArray(scannerCache)||!scannerCache.length)await loadScannerCache({force:true,maxAttempts:3});
    await loadCurrentPrices();
    if(full)await loadScannerCache({force:true,maxAttempts:3});
    await loadCurrentPrices();
    let done=0;
    for(const f of favoriteItems){const tr=[...document.querySelectorAll('#favoritesResults tr')].find(x=>x.dataset.ticker===f.ticker&&x.dataset.split===(f.splitDate||''));if(!tr)continue;const x=cacheFind(f);if(!x)continue;const oldPrice=tr.querySelector('.fv-price').textContent,oldChange=tr.querySelector('.fv-change').textContent,oldShort=tr.querySelector('.fv-short').textContent,oldFee=tr.querySelector('.fv-fee').textContent,oldFloat=tr.querySelector('.fv-float').textContent;const price=displayPrice(x);if(Number.isFinite(price))tr.querySelector('.fv-price').textContent='$'+fmt(price);if(Number.isFinite(Number(x.changePct)))tr.querySelector('.fv-change').textContent=(Number(x.changePct)>=0?'+':'')+fmt(x.changePct)+'%';if(Number.isFinite(Number(x.shortShares)))tr.querySelector('.fv-short').textContent=Number(x.shortShares).toLocaleString();if(Number.isFinite(Number(x.borrowFee)))tr.querySelector('.fv-fee').textContent=fmt(x.borrowFee,2)+'%';const ff=formatCompactShares(x.freeFloat);if(ff!=='—')tr.querySelector('.fv-float').textContent=ff;done++;}
    $('favoritesStatus').textContent=`تم تحديث ${done} سهم${done===1?'':'ًا'} — ${cacheAgeText()}`;
  }catch(e){$('favoritesStatus').textContent='تعذر تحديث المفضلة: '+(e.message||'خطأ');} finally{favoriteRefreshing=false;}
}
function startFavoriteAutoRefresh(){clearInterval(favoriteRefreshTimer);refreshFavoriteData(true);favoriteRefreshTimer=setInterval(()=>{if($('sec-favorites')?.classList.contains('active'))refreshFavoriteData(true)},120000);}
function stopFavoriteAutoRefresh(){clearInterval(favoriteRefreshTimer);favoriteRefreshTimer=null;}

async function loadIPOs(){
  scannerIpoSearchDone=true;
  const days=Math.max(1,Math.min(30,Number($('ipoDays').value)||7)); const ex=$('ipoExchange').value;
  $('ipoRefresh').disabled=true; $('ipoStatus').textContent='جاري البحث في بيانات الاكتتابات الجاهزة...'; $('ipoResults').innerHTML='';
  try{
    // IPO data is already embedded in the local scanner snapshot. Never issue a
    // Supabase/IPO API request just because the user changed the filter.
    if(!Array.isArray(scannerCache)||!scannerCacheUpdatedAt) await loadScannerCache({wait:true});
    const source=Array.isArray(scannerIPOs)?scannerIPOs:[];
    const today=new Date(); today.setHours(0,0,0,0);
    const end=new Date(today.getTime()+days*86400000);
    const rows=source.filter(x=>{
      const dt=new Date(String(x.listing_date||'')+'T00:00:00');
      if(!Number.isFinite(dt.getTime()))return false;
      return dt>=today&&dt<=end&&(ex==='ALL'||x.primary_exchange===ex);
    }).sort((a,b)=>String(a.listing_date).localeCompare(String(b.listing_date)));
    if(!rows.length){$('ipoStatus').textContent=`لا توجد اكتتابات مؤكدة خلال ${days} أيام. آخر تحديث لقائمة الاكتتابات: ${scannerIpoUpdatedAt?new Date(scannerIpoUpdatedAt).toLocaleString('ar-SA'):'غير متوفر'}.`;return;}
    $('ipoResults').innerHTML=rows.map(x=>`<tr><td><b>${escapeHtml(x.ticker||'—')}</b></td><td>${escapeHtml(x.issuer_name||x.security_description||'—')}</td><td>${escapeHtml(x.listing_date||'—')}</td><td>${Number(x.max_shares_offered||x.min_shares_offered||0)?Number(x.max_shares_offered||x.min_shares_offered).toLocaleString():'—'}</td><td>${x.lowest_offer_price!=null||x.highest_offer_price!=null?`$${fmt(x.lowest_offer_price)} — $${fmt(x.highest_offer_price)}`:'—'}</td><td>${x.total_offer_size!=null?Number(x.total_offer_size).toLocaleString():'—'}</td></tr>`).join('');
    $('ipoStatus').textContent=`تم العثور على ${rows.length} اكتتاب${rows.length===1?'':'ات'}. آخر تحديث لقائمة الاكتتابات: ${scannerIpoUpdatedAt?new Date(scannerIpoUpdatedAt).toLocaleString('ar-SA'):'غير متوفر'}.`;
  }catch(e){$('ipoStatus').textContent='تعذر البحث في بيانات الاكتتابات: '+(e.message||'خطأ غير معروف');}
  finally{$('ipoRefresh').disabled=false;}
}
$("ipoRefresh").onclick=loadIPOs;
function calculateAverage(){
  const oldPrice=Number($("oldPrice").value), oldQty=Number($("oldQty").value), newPrice=Number($("newPrice").value), newQty=Number($("newQty").value);
  if(![oldPrice,oldQty,newPrice,newQty].every(Number.isFinite)||oldPrice<0||oldQty<0||newPrice<0||newQty<0){$("totalQty").textContent="—";$("totalCost").textContent="—";$("avgPrice").textContent="—";return;}
  const totalQty=oldQty+newQty,totalCost=oldPrice*oldQty+newPrice*newQty,avg=totalQty?totalCost/totalQty:0;
  $("totalQty").textContent=totalQty.toLocaleString();$("totalCost").textContent="$"+totalCost.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4});$("avgPrice").textContent=avg.toLocaleString("en-US",{minimumFractionDigits:4,maximumFractionDigits:6});
}
["oldPrice","oldQty","newPrice","newQty"].forEach(id=>$(id).addEventListener("input",calculateAverage));
calculateAverage();
loadScannerSettings();$("exportCsv").onclick=exportResultsCsv;

function renderBankDetails(bank){const rows=[['اسم الحساب',bank.name,false],['البنك',bank.bank,false],['رقم الحساب',bank.account,true],['رقم الآيبان',bank.iban,true]];$("publicBankDetails").innerHTML=rows.map(([l,v,canCopy])=>`<div class="bankRow"><span class="bankLabel">${escapeHtml(l)}</span><span class="bankValue">${escapeHtml(v||"—")}${v&&canCopy?` <button type="button" class="copyBank" data-copy="${escapeHtml(v)}">نسخ</button>`:""}</span></div>`).join("");document.querySelectorAll('.copyBank').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);}catch{const ta=document.createElement('textarea');ta.value=b.dataset.copy;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}const old=b.textContent;b.textContent='تم النسخ ✓';setTimeout(()=>b.textContent=old,1200);});}

function applySubscriptionRequestState(enabled){
  const btn=$("requestBtn"), box=$("requestBox"), status=$("subscriptionRequestStatus");
  const on=enabled!==false;
  if(btn){btn.disabled=!on;btn.classList.toggle("hidden",!on);btn.setAttribute("aria-disabled",String(!on));}
  if(box && !on) box.classList.add("hidden");
  if(status) status.textContent=on?"":"طلبات الاشتراك متوقفة حاليًا.";
}
function applyMaintenanceState(site){
  const active=site&&site.siteMode&&site.siteMode!=="normal";
  maintenanceActive=Boolean(active);
  const b=$("maintenanceBanner"); if(!b)return;
  if(active){
    const mode=site.siteMode==="development"?"الموقع تحت التطوير":"الموقع تحت الصيانة";
    $("maintenanceTitle").textContent=mode;
    $("maintenanceText").textContent=site.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا.";
    b.classList.remove("hidden");
  }else b.classList.add("hidden");
}
async function loadPublicPricing(){
  try{
    const r=await apiFetch("/.netlify/functions/auth?action=pricing"),d=await responseJSON(r);
    if(r.ok&&d.pricing){
      window.sitePricing=d.pricing;applyMaintenanceState(d.pricing);applySubscriptionRequestState(d.pricing.subscriptionRequestsEnabled);renderPlanSelects(d.pricing);
      renderBankDetails(d.pricing.bank||{});updateTelegramLinks(d.pricing.telegram||"");
    }
  }catch{}
}
function updateRequestAmount(){
  const p=(window.sitePricing?.plans||[]).find(x=>x.id===$("reqPlan")?.value);
  if($("reqAmount"))$("reqAmount").value=p?.price??"";
}
function updateRenewAmount(){
  const p=(window.sitePricing?.plans||[]).find(x=>x.id===$("renewPlan")?.value);
  if($("renewAmount"))$("renewAmount").value=p?.price??"";
}

// ==================== الحسابات والاشتراكات ====================
async function loadMe(){
  let lastError=null;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await apiFetch(`/.netlify/functions/auth?action=me&_=${Date.now()}`);
      const d=await responseJSON(r);
      if(d.maintenance){sessionReady=false;applyMaintenanceState({siteMode:d.mode||"maintenance",siteModeMessage:d.message||""});document.body.classList.remove("session-ok");$("authOverlay").classList.remove("hidden");return false;}
      // A transient Function/Netlify 5xx must NOT destroy a valid browser session.
      if(r.status>=500){throw Error(d.error||`HTTP ${r.status}`);}
      if(!r.ok||!d.authenticated){localStorage.removeItem("scanner_session_hint");sessionKnown=false;sessionReady=false;applyMaintenanceState({siteMode:"normal"});document.body.classList.remove("session-ok");$("authOverlay").classList.remove("hidden");return false;}
      applyMaintenanceState({siteMode:"normal"});
      sessionReady=true;localStorage.setItem("scanner_session_hint","1");sessionKnown=true;window.currentUserEmail=d.user?.email||"";loadAlertSettings();loadNotificationHistory();document.body.classList.add("session-ok");await loadScannerSettings();loadFavorites();loadScannerCache().catch(()=>{});$("authOverlay").classList.add("hidden");showResearchNotice();loadMySupportReplies();
      const plan=(window.sitePricing?.plans||[]).find(x=>x.id===d.user.plan)?.label||d.user.plan||"—";
      const rem=d.user.expiresAt?Math.max(0,Math.ceil((new Date(d.user.expiresAt+"T23:59:59").getTime()-Date.now())/86400000)):null;
      $("infoEmail").textContent=d.user.email||d.user.username||"—";
      $("infoPlan").textContent=plan;
      $("infoStart").textContent=d.user.subscriptionStartedAt||d.user.createdAt?.slice(0,10)||"—";
      $("infoEnd").textContent=d.user.expiresAt||"—";
      $("infoRemaining").textContent=rem!=null?rem+" يوم":"—";$("renewalBox").classList.toggle("hidden",!(rem!=null&&rem<=7));if(rem!=null&&rem<=7)updateRenewAmount();
      applyTheme(localStorage.getItem("scanner_theme")==="dark"?"dark":"light");
      if(d.user.admin){const tb=$("telegramTestBtn");if(tb){tb.style.display="inline-flex";tb.removeAttribute("aria-hidden");}await addAdminPanel();}else{$("adminNav").classList.add("hidden");if($("sec-admin").classList.contains("active")){document.querySelector('[data-sec="scanner"]').click();}}
      return true;
    }catch(e){
      lastError=e;
      if(attempt<4) await sleep(1200*attempt);
    }
  }
  // Keep a previously authenticated session visible during a transient Function/
  // Netlify failure. The HttpOnly cookie remains authoritative on the server;
  // re-check it when the page becomes visible again.
  if(sessionKnown){
    sessionReady=true; document.body.classList.add("session-ok"); $("authOverlay").classList.add("hidden");
    $("loginMsg").textContent="جاري استعادة الجلسة…";
    return false;
  }
  $("loginMsg").textContent=lastError?.message||"تعذر تشغيل خدمة الحسابات مؤقتًا. أعد المحاولة بعد لحظات.";
  return false;
}
function showResearchNotice(){$("researchNotice").classList.add("show");}
setInterval(()=>{if(maintenanceActive)loadMe();},30000);
startCurrentPriceRefresh();
$("noticeOk").onclick=()=>$("researchNotice").classList.remove("show");
$("loginBtn").onclick=async()=>{
  $("loginMsg").textContent="جاري تسجيل الدخول...";
  try{
    const r=await apiFetch("/.netlify/functions/auth?action=login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("loginUser").value.trim(),password:$("loginPass").value})});
    const d=await responseJSON(r);
    if(!r.ok){
      if(r.status===503 && d.maintenance){applyMaintenanceState({siteMode:d.mode||"maintenance",siteModeMessage:d.message||""});throw Error(d.message||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا.");}
      if(r.status===404) throw Error("خدمة الدخول غير منشورة على Netlify. النسخة تحتاج نشر Functions.");
      if(r.status>=500){
        try{
          const h=await apiFetch("/.netlify/functions/auth?action=health");
          const hd=await responseJSON(h);
          if(hd&&hd.ok===false) throw Error("خدمة الحسابات غير مهيأة.");
        }catch(_){}
        throw Error(d.error||"خدمة الحسابات فيها خطأ على الخادم.");
      }
      throw Error(d.error||`فشل الدخول (${r.status})`);
    }
    if(!d.ok) throw Error(d.error||"تعذر تسجيل الدخول.");
    if(d.deviceId){try{localStorage.setItem("scanner_device_id",String(d.deviceId));}catch{}}
    localStorage.setItem("scanner_session_hint","1"); sessionKnown=true;
    $("loginMsg").textContent="تم الدخول.";await loadMe();
  }catch(e){$("loginMsg").textContent=e.message||"تعذر تسجيل الدخول."}
};
$("logout").onclick=async()=>{await apiFetch("/.netlify/functions/auth?action=logout",{method:"POST"});location.reload()};
function termsHtml(){return `<p>قبل إرسال طلب الاشتراك، يرجى قراءة الشروط التالية:</p><div class="subscribeRules"><ol><li>الاشتراك للاستخدام الشخصي فقط، ولا يُسمح بمشاركة الحساب أو بيانات الوصول مع الآخرين.</li><li>المعلومات المعروضة في الباحث مخصصة للبحث والتحليل فقط، ولا تُعد توصية بالشراء أو البيع ولا نصيحة استثمارية.</li><li>الاشتراك مرتبط بجهاز واحد وفق آلية حماية الحساب في الموقع.</li><li>يتم تحويل قيمة الباقة ثم إرفاق إثبات التحويل في نموذج الاشتراك.</li><li>لا يبدأ الاشتراك إلا بعد مراجعة الطلب واعتماد الحوالة من الإدارة.</li><li>تُطبق سياسة الدفع والاسترجاع المنشورة في الموقع على طلبات الاشتراك.</li></ol></div>`;}
function openSubscribeTerms(){
  if(window.sitePricing?.subscriptionRequestsEnabled===false){applySubscriptionRequestState(false);return;}
  $("termsContent").innerHTML=termsHtml();$("termsAgree").checked=false;$("termsContinue").disabled=true;$("termsModal").classList.add("show");
}
function continueToSubscribe(){
  $("termsModal").classList.remove("show");$("requestBox").classList.remove("hidden");
  setTimeout(()=>$("requestBox").scrollIntoView({behavior:"smooth",block:"start"}),80);
}
$("requestBtn").onclick=openSubscribeTerms;$("termsAgree").onchange=()=>$("termsContinue").disabled=!$("termsAgree").checked;$("termsContinue").onclick=continueToSubscribe;$("termsCancel").onclick=()=>$("termsModal").classList.remove("show");$("termsClose").onclick=()=>$("termsModal").classList.remove("show");
$("themeToggle").onchange=e=>applyTheme(e.target.checked?"dark":"light");
$("reqPlan").onchange=updateRequestAmount;$("savePlans").onclick=savePrices;$("saveBank").onclick=saveBank;
async function sendRenewal(){
  const f=$("renewProof").files[0];$("renewMsg").textContent="جاري إرسال الطلب...";
  try{
    if(!f)throw Error("أرفق إثبات الحوالة."); if(f.size>1.8*1024*1024)throw Error("حجم إثبات الحوالة يجب ألا يتجاوز 1.8MB.");
    const proof={name:f.name,type:f.type||"application/octet-stream",data:await fileToDataUrl(f)};
    const body={renewal:true,name:$("infoEmail").textContent,contact:$("infoEmail").textContent,plan:$("renewPlan").value,proof};
    const r=await apiFetch("/.netlify/functions/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); const d=await responseJSON(r); if(!r.ok)throw Error(d.error||"تعذر إرسال الطلب.");
    $("renewMsg").textContent="تم إرسال طلب التجديد، وسيتم التحقق من الحوالة ثم تمديد الاشتراك.";
  }catch(e){$("renewMsg").textContent=e.message||"تعذر إرسال الطلب."}
}
$("renewPlan").onchange=updateRenewAmount;$("sendRenewal").onclick=sendRenewal;
$("sendRequest").onclick=async()=>{
  const f=$("reqProof").files[0];
  $("reqMsg").textContent="جاري إرسال الطلب...";
  try{
    if(!$("reqName").value.trim()||!$("reqContact").value.trim())throw Error("أكمل الاسم والبريد/الجوال.");
    if(!f)throw Error("أرفق إثبات الحوالة.");
    if(f.size>1.8*1024*1024)throw Error("حجم إثبات الحوالة يجب ألا يتجاوز 1.8MB.");
    let proof={name:f.name,type:f.type||"application/octet-stream",data:await fileToDataUrl(f)};
    const body={name:$("reqName").value.trim(),contact:$("reqContact").value.trim(),plan:$("reqPlan").value,amount:Number($("reqAmount").value),proof};
    const r=await apiFetch("/.netlify/functions/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await responseJSON(r);
    if(!r.ok)throw Error(d.error||`تعذر إرسال الطلب (${r.status})`);
    $("reqMsg").textContent="تم إرسال الطلب. بعد التحقق سيتم التواصل معك لإعطائك بيانات الدخول.";
  }catch(e){$("reqMsg").textContent=e.message||"تعذر إرسال الطلب."}
};
const legalPages={
  privacy:{title:"سياسة الخصوصية",html:`<p>نحترم خصوصية مستخدمي الموقع ونستخدم البيانات اللازمة لتشغيل الحسابات والاشتراكات وتقديم الدعم.</p><h3>البيانات التي قد نجمعها</h3><ul><li>بيانات الحساب مثل البريد الإلكتروني وبيانات الدخول.</li><li>بيانات الاشتراك وطلبات التحويل والمرفقات التي يرسلها العميل.</li><li>الرسائل المرسلة إلى خدمة العملاء.</li><li>بيانات تقنية لازمة لأمان الحساب وتشغيل الموقع.</li></ul><h3>استخدام البيانات</h3><p>تُستخدم البيانات لتفعيل الحسابات وإدارة الاشتراكات، التحقق من طلبات الدفع، تقديم الدعم، وحماية المنصة من إساءة الاستخدام.</p><h3>المرفقات</h3><p>تُخزن مرفقات إثبات التحويل للوصول الإداري والتحقق من الطلب، ولا تُعرض للمستخدمين الآخرين.</p><h3>حماية البيانات</h3><p>نطبق وسائل تقنية وإجرائية معقولة لحماية البيانات، مع التنبيه إلى أن أي خدمة عبر الإنترنت لا يمكن ضمان حمايتها بنسبة 100٪.</p>`},
  refund:{title:"سياسة الدفع والاسترجاع",html:`<p>تُدفع قيمة الباقة وفق السعر والمدة الظاهرين في صفحة الاشتراك وقت إرسال الطلب.</p><h3>اعتماد الاشتراك</h3><p>لا يُفعّل الاشتراك إلا بعد مراجعة طلب الدفع وإثبات التحويل واعتماده من الإدارة.</p><h3>طلبات الاسترجاع</h3><p>إذا كان هناك طلب استرجاع، يتواصل العميل مع الدعم ويوضح رقم/بيانات الطلب وسبب الطلب. تتم مراجعة الحالة وفق الخدمة المستخدمة وحالة الاشتراك.</p><h3>بعد تفعيل الاشتراك</h3><p>أي طلب استرجاع بعد بدء الاستفادة من مدة الاشتراك يخضع للمراجعة بحسب حالة الحساب والمدة المستهلكة والظروف المرتبطة بالطلب.</p><h3>مشاكل الدفع</h3><p>في حال خصم المبلغ دون وصول الطلب أو وجود خطأ في بيانات التحويل، يرجى التواصل مع الدعم وإرفاق ما يثبت العملية.</p>`},
  support:{title:"الدعم",html:`<p>للدعم، استخدم قسم <b>المقترحات والاستفسارات</b> من داخل الحساب، أو وسيلة التواصل المعلنة في صفحة الاشتراك.</p><h3>ماذا تذكر في الطلب؟</h3><ul><li>البريد الإلكتروني المرتبط بالحساب.</li><li>وصف واضح للمشكلة أو الاستفسار.</li><li>وقت حدوث المشكلة وأي رسالة خطأ ظهرت.</li></ul><p>طلبات الدعم المتعلقة بالدفع يفضل أن تتضمن بيانات العملية أو إثبات التحويل المناسب دون إرسال كلمات المرور.</p>`},
  terms:{title:"الشروط والأحكام",html:termsHtml()}
};
function openLegal(key){const page=legalPages[key];if(!page)return;$("legalTitle").textContent=page.title;$("legalContent").innerHTML=page.html;$("legalModal").classList.add("show");}
document.querySelectorAll("[data-legal]").forEach(b=>b.onclick=()=>openLegal(b.dataset.legal));$("legalClose").onclick=()=>$("legalModal").classList.remove("show");
function fileToDataUrl(file){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file)})}
function showProof(proof){
  const box=$("proofViewer");box.innerHTML=""; if(!proof?.data){box.textContent="لا يوجد مرفق.";return;}
  try{const [head,b64]=String(proof.data).split(",");const mime=(proof.type||head.match(/data:([^;]+)/)?.[1]||"application/octet-stream");const bytes=Uint8Array.from(atob(b64||""),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:mime}));
    if(mime.startsWith("image/")){const img=document.createElement("img");img.src=url;img.style.maxWidth="100%";img.style.maxHeight="70vh";img.style.objectFit="contain";box.appendChild(img);}else if(mime==="application/pdf"){const iframe=document.createElement("iframe");iframe.src=url;iframe.style.width="100%";iframe.style.height="70vh";iframe.style.border="0";box.appendChild(iframe);}else{const a=document.createElement("a");a.href=url;a.download=proof.name||"attachment";a.textContent="فتح/تحميل المرفق";box.appendChild(a);} $("proofModal").classList.add("show");setTimeout(()=>URL.revokeObjectURL(url),120000);
  }catch(e){box.textContent="تعذر عرض المرفق.";$("proofModal").classList.add("show");}
}

function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));}
let adminPlanDraft=[];
function renderPlanSelects(pricing){
  const plans=Array.isArray(pricing?.plans)?pricing.plans:[];
  for(const id of ["reqPlan","renewPlan","adminPlan"]){
    const el=$(id);if(!el)continue;
    const old=el.value;el.innerHTML=plans.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} — ${Number(p.price).toLocaleString()} ر.س / ${p.days} يوم</option>`).join("");
    if(plans.some(p=>p.id===old))el.value=old;
  }
  updateRequestAmount();updateRenewAmount();
}
function renderAdminPlans(){
  const box=$("adminPlans");if(!box)return;
  box.innerHTML=adminPlanDraft.map((p,i)=>`<div class="adminBox" data-plan-row="${i}" style="margin-bottom:10px">
    <div class="grid">
      <div><label>اسم الباقة</label><input class="planLabel" value="${escapeHtml(p.label)}"></div>
      <div><label>المدة بالأيام</label><input class="planDays" type="number" min="1" value="${Number(p.days)||1}"></div>
      <div><label>السعر (ر.س)</label><input class="planPrice" type="number" min="0" step="1" value="${Number(p.price)||0}"></div>
      <div><label>المعرّف</label><input class="planId" value="${escapeHtml(p.id)}" ${p.id==="monthly"||p.id==="yearly"?"readonly":""}></div>
    </div>
    <div class="actions"><button type="button" class="btn stop deletePlan" data-index="${i}" ${adminPlanDraft.length<=1?"disabled":""}>حذف الباقة</button></div>
  </div>`).join("");
  box.querySelectorAll(".deletePlan").forEach(b=>b.onclick=()=>{adminPlanDraft.splice(Number(b.dataset.index),1);renderAdminPlans();});
}
function readAdminPlans(){
  return [...document.querySelectorAll("#adminPlans [data-plan-row]")].map((row,i)=>({
    id:row.querySelector(".planId").value.trim(),
    label:row.querySelector(".planLabel").value.trim(),
    days:Number(row.querySelector(".planDays").value),
    price:Number(row.querySelector(".planPrice").value)
  }));
}
async function saveAllSettings(extra={}){
  const current=window.sitePricing||{plans:adminPlanDraft};
  const d=await adminAction("save-settings",{plans:readAdminPlans().length?readAdminPlans():current.plans,...extra});
  window.sitePricing=d.pricing;adminPlanDraft=(d.pricing.plans||[]).map(x=>({...x}));renderAdminPlans();renderPlanSelects(d.pricing);
  renderBankDetails(d.pricing.bank||{});updateTelegramLinks(d.pricing.telegram||"");
  return d;
}
async function addAdminPanel(){
  $("adminNav").classList.remove("hidden");
  try{
    const d=await adminAction("settings"),p=d.pricing;window.sitePricing=p;adminPlanDraft=(p.plans||[]).map(x=>({...x}));
    renderAdminPlans();renderPlanSelects(p);
    $("adminBankName").value=p.bank?.name||"";$("adminBankBank").value=p.bank?.bank||"";$("adminBankAccount").value=p.bank?.account||"";$("adminBankIban").value=p.bank?.iban||"";$("adminTelegram").value=p.telegram||"";
  }catch{}
}
let siteSettingsUnlocked=false;
let siteSettingsUnlockPending=false;
function closeSiteSettingsUnlock(){siteSettingsUnlockPending=false;const m=$("siteSettingsUnlockModal");if(m)m.classList.remove("show");const i=$("siteSettingsUnlockPassword");if(i){i.value="";}}
async function unlockSiteSettings(){
  if(siteSettingsUnlocked)return true;
  const modal=$("siteSettingsUnlockModal"),input=$("siteSettingsUnlockPassword"),msg=$("siteSettingsUnlockMsg");
  if(!modal||!input)return false;
  siteSettingsUnlockPending=true;msg.textContent="";input.value="";modal.classList.add("show");setTimeout(()=>input.focus(),0);
  return await new Promise(resolve=>{
    const submit=async()=>{
      const pass=input.value;
      if(!pass){msg.textContent="أدخل كلمة المرور.";input.focus();return;}
      const btn=$("siteSettingsUnlockSubmit");btn.disabled=true;
      try{await adminAction("verify-site-settings",{adminPassword:pass});siteSettingsUnlocked=true;closeSiteSettingsUnlock();resolve(true);}
      catch(e){siteSettingsUnlocked=false;msg.textContent=e.message||"كلمة مرور المدير غير صحيحة.";input.select();}
      finally{btn.disabled=false;}
    };
    $("siteSettingsUnlockSubmit").onclick=submit;
    $("siteSettingsUnlockCancel").onclick=()=>{closeSiteSettingsUnlock();resolve(false);};
    $("siteSettingsUnlockClose").onclick=()=>{closeSiteSettingsUnlock();resolve(false);};
    input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();submit();}if(e.key==='Escape'){e.preventDefault();closeSiteSettingsUnlock();resolve(false);}};
  });
}
async function loadSiteSettingsPanel(){
  if(!siteSettingsUnlocked)return false;
  try{
    const d=await adminAction("site-settings"),p=d.pricing||{};
    $("siteMode").value=p.siteMode||"normal";
    $("siteModeMessage").value=p.siteModeMessage||"";
    $("autoUpdateToggle").checked=(p.auto_update_enabled!==undefined?p.auto_update_enabled:p.autoUpdateEnabled)!==false;
    $("subscriptionRequestToggle").checked=p.subscriptionRequestsEnabled!==false;
    $("autoUpdateMsg").textContent="";
    $("siteModeMsg").textContent="";
    return true;
  }catch(e){siteSettingsUnlocked=false;alert(e.message||"تعذر فتح إعدادات الموقع.");return false;}
}
async function saveSubscriptionRequestSetting(){const btn=$("saveSubscriptionRequest"),msg=$("subscriptionRequestMsg");try{const enabled=$("subscriptionRequestToggle").checked;btn.disabled=true;msg.textContent="جاري حفظ إعداد طلبات الاشتراك...";const d=await adminAction("save-site-settings",{subscriptionRequestsEnabled:enabled});window.sitePricing=d.pricing;applySubscriptionRequestState(d.pricing.subscriptionRequestsEnabled);$("subscriptionRequestToggle").checked=d.pricing.subscriptionRequestsEnabled!==false;msg.textContent=$("subscriptionRequestToggle").checked?"تم السماح بطلبات الاشتراك الجديدة.":"تم إيقاف طلبات الاشتراك الجديدة.";}catch(e){msg.textContent=e.message||"تعذر حفظ إعداد طلبات الاشتراك.";}finally{btn.disabled=false;}}
if($("saveSubscriptionRequest"))$("saveSubscriptionRequest").onclick=saveSubscriptionRequestSetting;
async function saveAutoUpdate(){
  const btn=$("saveAutoUpdate"),msg=$("autoUpdateMsg");
  try{
    const enabled=$("autoUpdateToggle").checked;
    btn.disabled=true;msg.textContent="جاري حفظ حالة التحديث التلقائي...";
    const d=await adminAction("save-site-settings",{autoUpdateEnabled:enabled,auto_update_enabled:enabled});
    window.sitePricing=d.pricing;
    const actual=(d.pricing.auto_update_enabled!==undefined?d.pricing.auto_update_enabled:d.pricing.autoUpdateEnabled)!==false;
    $("autoUpdateToggle").checked=actual;
    msg.textContent=actual?"تم تفعيل التحديث التلقائي. سيعمل التحديث الفني والأسعار كل 5 دقائق، والشورت حسب جدول التشغيل ثم يُنشر فور اكتماله.":"تم إيقاف التحديث التلقائي بالكامل. لن تبدأ أي جدولة جديدة، والتحديثات اليدوية تبقى مستقلة.";
  }catch(e){msg.textContent=e.message||"تعذر حفظ إعداد التحديث التلقائي.";}finally{btn.disabled=false;}
}
if($("saveAutoUpdate"))$("saveAutoUpdate").onclick=saveAutoUpdate;$("alertDropMode")?.addEventListener("change",updateAlertDropInput);
async function saveSiteMode(){
  try{
    const mode=$("siteMode").value;
    const message=$("siteModeMessage").value.trim();
    const d=await adminAction("save-site-settings",{siteMode:mode,siteModeMessage:message});
    window.sitePricing=d.pricing;applyMaintenanceState(d.pricing);$("siteModeMsg").textContent=mode==="normal"?"تم تشغيل الموقع للعملاء.":"تم إيقاف الموقع على العملاء. حساب المدير يبقى متاحًا.";
  }catch(e){$("siteModeMsg").textContent=e.message||"تعذر حفظ حالة الموقع.";}
}
if($("saveSiteMode"))$("saveSiteMode").onclick=saveSiteMode;
async function savePrices(){try{$("priceMsg").textContent="جاري الحفظ...";await saveAllSettings();$("priceMsg").textContent="تم حفظ الباقات وتحديثها للموقع مباشرة.";}catch(e){$("priceMsg").textContent=e.message||"تعذر الحفظ.";}}
async function saveBank(){
  try{const d=await saveAllSettings({bankName:$("adminBankName").value.trim(),bankBank:$("adminBankBank").value.trim(),bankAccount:$("adminBankAccount").value.trim(),bankIban:$("adminBankIban").value.trim(),telegram:window.sitePricing?.telegram||""});$("bankMsg").textContent="تم حفظ بيانات التحويل.";}catch(e){$("bankMsg").textContent=e.message||"تعذر حفظ بيانات التحويل."}
}
function updateTelegramLinks(url){const u=String(url||"").trim();["loginTelegram","requestTelegram"].forEach(id=>{const a=$(id);if(!a)return;if(u){a.href=u;a.style.display="block";}else{a.removeAttribute("href");a.style.display="none";}})}
async function loadTelegramLink(){try{const d=await getJSON('/.netlify/functions/alerts?action=telegram-link');telegramState=d.telegram||{linked:false,link:null};renderTelegramLinkState();}catch(e){alert(e.message||'تعذر إنشاء رابط تليجرام.');}}
async function sendTelegramAlertTest(){
  const btn=$('telegramTestBtn');
  if(btn)btn.disabled=true;
  try{
    const d=await getJSON('/.netlify/functions/alerts?action=telegram-test');
    if(d.ok)alert('تم إرسال رسالة الاختبار إلى تليجرام. إذا ظهرت في البوت فمسار التنبيهات يعمل.');
    else throw Error(d.error||'تعذر إرسال الاختبار.');
  }catch(e){alert(e.message||'تعذر إرسال اختبار تليجرام.');}
  finally{if(btn)btn.disabled=false;}
}
async function setupTelegramWebhook(){const btn=$('setupTelegramWebhook'),msg=$('telegramWebhookMsg');if(!btn)return;btn.disabled=true;msg.textContent='جاري تفعيل ربط البوت...';try{const d=await adminAction('setup-telegram-webhook',{});msg.textContent=`تم تفعيل البوت: ${d.webhook}`;}catch(e){msg.textContent=e.message||'تعذر تفعيل Webhook.';}finally{btn.disabled=false;}}
async function sendTelegramBroadcast(){const btn=$('telegramBroadcastBtn'),msg=$('telegramBroadcastMsg'),box=$('telegramBroadcastText');if(!box?.value.trim()){msg.textContent='اكتب الرسالة أولاً.';return;}btn.disabled=true;msg.textContent='جاري الإرسال لجميع المرتبطين بتليجرام...';try{const r=await apiFetch('/.netlify/functions/telegram-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:box.value.trim()})});const d=await responseJSON(r);if(!r.ok)throw Error(d.error||'تعذر الإرسال.');msg.textContent=`تم الإرسال بنجاح إلى ${d.sent||0} مشترك. فشل ${d.failed||0}.`; }catch(e){msg.textContent=e.message||'تعذر الإرسال الجماعي.';}finally{btn.disabled=false;}}
async function saveTelegram(){
  try{await saveAllSettings({telegram:$("adminTelegram").value.trim(),bankName:$("adminBankName").value.trim(),bankBank:$("adminBankBank").value.trim(),bankAccount:$("adminBankAccount").value.trim(),bankIban:$("adminBankIban").value.trim()});$("telegramMsg").textContent="تم حفظ حساب التليجرام.";}catch(e){$("telegramMsg").textContent=e.message||"تعذر الحفظ."}
}
$("saveTelegram").onclick=saveTelegram;
$("addPlan").onclick=()=>{adminPlanDraft.push({id:`plan-${Date.now()}`,label:"باقة جديدة",days:90,price:0});renderAdminPlans();};
$("savePlans").onclick=savePrices;

async function sendSupportMessage(){
  const msg=$("supportMessage").value.trim();if(!msg){$("supportMsg").textContent="اكتب الرسالة أولاً.";return;}
  const btn=$("sendSupport");btn.disabled=true;$("supportMsg").textContent="جاري الإرسال...";
  try{
    const file=$("supportAttachment")?.files?.[0]; let attachment=null;
    if(file){
      if(file.size>3*1024*1024)throw Error("حجم المرفق يجب ألا يتجاوز 3 MB.");
      const allowed=["image/png","image/jpeg","application/pdf"];
      if(!allowed.includes(file.type))throw Error("المسموح فقط PNG / JPG / PDF.");
      attachment=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve({name:file.name,type:file.type,size:file.size,data:fr.result});fr.onerror=()=>reject(Error("تعذر قراءة المرفق."));fr.readAsDataURL(file);});
    }
    const r=await apiFetch("/.netlify/functions/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({customerService:true,type:$("supportType").value,subject:$("supportSubject").value.trim(),message:msg,attachment})});
    const d=await responseJSON(r);if(!r.ok)throw Error(d.error||"تعذر إرسال الرسالة.");
    $("supportMessage").value="";$("supportSubject").value="";if($("supportAttachment"))$("supportAttachment").value="";$("supportMsg").textContent="تم إرسال رسالتك للمطور بنجاح.";
  }catch(e){$("supportMsg").textContent=e.message||"تعذر إرسال الرسالة."}finally{btn.disabled=false;}
}
$("sendSupport").onclick=sendSupportMessage;

let supportReplyCache=[];
async function loadMySupportReplies(){
  if(!sessionReady)return;
  try{
    const r=await apiFetch("/.netlify/functions/requests?mine=1");
    const d=await responseJSON(r); if(!r.ok)return;
    const all=d.requests||[]; supportReplyCache=all.filter(x=>x.reply);
    const unread=supportReplyCache.filter(x=>!x.supportReadAt||new Date(x.supportReadAt).getTime()<new Date(x.repliedAt||0).getTime());
    const btn=$("floatingReply");
    if(unread.length){btn.classList.add("show");btn.textContent=`💬 لديك ${unread.length} رد من المطور`;}else btn.classList.remove("show");
    renderMyReplies(all);
  }catch{}
}
function renderMyReplies(items){
  const box=$("repliesList"); if(!box)return;
  const replies=(items||[]).filter(x=>x.reply);
  $("repliesStatus").textContent=replies.length?`عدد الردود: ${replies.length}`:"لا توجد ردود من المطور حتى الآن.";
  box.innerHTML=replies.length?replies.map(x=>`<div class="adminBox" style="margin-bottom:10px"><div><b>${x.supportKind==="suggestion"?"💡 اقتراح":"❓ استفسار"}</b> — ${escapeHtml(x.subject||"")} <span class="small">${escapeHtml(x.createdAt||"")}</span></div><div style="margin-top:8px;background:#f8fafc;border-radius:10px;padding:10px;white-space:pre-wrap"><b>رسالتك:</b>\n${escapeHtml(x.message||"")}</div><div class="supportReply" style="margin-top:8px"><b>رد المطور:</b><div style="white-space:pre-wrap;margin-top:5px">${escapeHtml(x.reply||"")}</div><div class="small">${escapeHtml(x.repliedAt||"")}</div></div></div>`).join(""):"<div class=\"small\">لا توجد ردود من المطور حتى الآن.</div>";
}
async function openMyReplies(){const latest=supportReplyCache.find(x=>!x.supportReadAt||new Date(x.supportReadAt).getTime()<new Date(x.repliedAt||0).getTime())||supportReplyCache[0];if(!latest)return;$("floatingReply").classList.remove("show");$("replyModalText").textContent=latest.reply||"";$("replyModal").classList.add("show");try{await apiFetch("/.netlify/functions/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({markSupportRead:true,id:latest.id})});}catch{} latest.supportReadAt=new Date().toISOString();await loadMySupportReplies();}
$("floatingReply").onclick=openMyReplies;$("replyClose").onclick=()=>$("replyModal").classList.remove("show");$("refreshReplies").onclick=loadMySupportReplies;
setInterval(loadMySupportReplies,30000);
async function adminAction(action,payload={}){
  const r=await apiFetch("/.netlify/functions/admin?action="+encodeURIComponent(action),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const d=await responseJSON(r);
  if(!r.ok) throw Error(d.error||"تعذر تنفيذ العملية.");
  return d;
}
let extendTargetEmail="";
function fillExtendDays(){const y=Number($("extendYear").value),m=Number($("extendMonth").value);const max=new Date(y,m,0).getDate();const cur=Number($("extendDay").value)||1;$("extendDay").innerHTML=Array.from({length:max},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join("");$("extendDay").value=String(Math.min(cur,max));}
function openExtendModal(email,current){extendTargetEmail=email;const d=/^\d{4}-\d{2}-\d{2}$/.test(current)?current:new Date().toISOString().slice(0,10);const [yy,mm,dd]=d.split("-").map(Number);$("extendYear").innerHTML=Array.from({length:11},(_,i)=>{const y=yy-5+i;return `<option value="${y}">${y}</option>`}).join("");$("extendMonth").innerHTML=Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join("");$("extendYear").value=yy;$("extendMonth").value=mm;fillExtendDays();$("extendDay").value=String(dd);$("extendMsg").textContent="";$("extendModal").classList.add("show");}
function closeExtendModal(){$("extendModal").classList.remove("show");extendTargetEmail="";}
$("extendYear").onchange=fillExtendDays;$("extendMonth").onchange=fillExtendDays;$("extendClose").onclick=closeExtendModal;$("extendCancel").onclick=closeExtendModal;$("extendSave").onclick=async()=>{try{const date=`${$("extendYear").value}-${String($("extendMonth").value).padStart(2,"0")}-${String($("extendDay").value).padStart(2,"0")}`;$("extendSave").disabled=true;await adminAction("extend",{email:extendTargetEmail,expiresAt:date});closeExtendModal();await loadAdminUsers();}catch(e){$("extendMsg").textContent=e.message||"تعذر تمديد الاشتراك."}finally{$("extendSave").disabled=false;}};
async function loadAdminUsers(){
  try{
    const d=await adminAction("list");
    const users=d.users||[];
    const nonAdmin=users.filter(u=>!u.admin), now=Date.now();
    const active=nonAdmin.filter(u=>u.status==="active"&&(!u.expiresAt||new Date(u.expiresAt+"T23:59:59").getTime()>=now)).length;
    const expired=nonAdmin.filter(u=>u.expiresAt&&new Date(u.expiresAt+"T23:59:59").getTime()<now).length;
    let revenue=0; try{const rq=await adminAction("requests"); revenue=(rq.requests||[]).filter(x=>x.status==="approved").reduce((a,x)=>a+(Number(x.amount)||0),0);}catch{}
    $("admTotal").textContent=nonAdmin.length.toLocaleString(); $("admActive").textContent=active.toLocaleString(); $("admExpired").textContent=expired.toLocaleString(); $("admRevenue").textContent="$"+revenue.toLocaleString();
    if(!users.length){$("adminOut").innerHTML="لا يوجد عملاء.";return;}
    const today=Date.now();
    const remainingDays=(date)=>{if(!date)return null;const t=new Date(date+"T23:59:59").getTime();return Math.max(0,Math.ceil((t-today)/86400000));};
    $("adminOut").innerHTML=`<table style="min-width:1280px"><thead><tr><th>الإيميل</th><th>دخول العميل</th><th>الحالة</th><th>الباقة</th><th>بداية الاشتراك</th><th>نهاية الاشتراك</th><th>المتبقي</th><th>الجهاز</th><th>إجراءات</th></tr></thead><tbody>${users.map(u=>{
      const admin=u.admin===true, rem=remainingDays(u.expiresAt);
      const subscriptionActive=u.status==="active"&&(!u.expiresAt||new Date(u.expiresAt+"T23:59:59").getTime()>=today);
      const loggedIn=Boolean(u.firstLoginAt);
      const loginReady=loggedIn&&subscriptionActive;
      const loginTitle=loginReady?`دخل العميل — أول دخول: ${escapeHtml(u.firstLoginAt||"")}`:(loggedIn?"العميل دخل سابقًا لكن الاشتراك غير نشط":"العميل لم يسجل الدخول بعد");
      return `<tr><td>${escapeHtml(u.email)}${admin?" 🔐":""}</td><td>${admin?"—":`<button type="button" class="customerLoginState ${loginReady?"is-green":"is-red"}" data-login-at="${escapeHtml(u.firstLoginAt||"")}" title="${loginTitle}" aria-label="${loginTitle}"><span class="loginDot"></span><span>أعرف العميل: ${loginReady?"دخل":"لم يدخل"}</span></button>`}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml(u.plan||"—")}</td><td>${escapeHtml(u.subscriptionStartedAt||u.createdAt?.slice(0,10)||"—")}</td><td>${escapeHtml(u.expiresAt||"—")}</td><td>${rem!=null?rem+" يوم":"—"}</td><td>${u.deviceId?"مرتبط":"غير مرتبط"}</td><td>${admin?"—":`<button class="btn secondary adminAct" data-a="reset-device" data-e="${escapeHtml(u.email)}">إلغاء ارتباط الجهاز</button> <button class="btn ${u.status==="active"?"stop":"start"} adminAct" data-a="${u.status==="active"?"disable":"enable"}" data-e="${escapeHtml(u.email)}">${u.status==="active"?"تعطيل":"تفعيل"}</button> <button class="btn secondary adminAct" data-a="extend" data-e="${escapeHtml(u.email)}">تمديد</button> <button class="btn stop adminAct" data-a="delete" data-e="${escapeHtml(u.email)}">حذف الحساب</button>`}</td></tr>`;}).join("")}</tbody></table>`;
    document.querySelectorAll(".customerLoginState").forEach(b=>b.onclick=()=>{
      const at=b.dataset.loginAt;
      if(at) alert(`العميل دخل الحساب بنجاح\nأول دخول: ${new Date(at).toLocaleString("ar-SA")}`);
      else alert("العميل لم يسجل الدخول إلى الحساب حتى الآن.");
    });
    document.querySelectorAll(".adminAct").forEach(b=>b.onclick=async()=>{
      const email=b.dataset.e, action=b.dataset.a;
      try{
        let payload={email};
        if(action==="extend"){openExtendModal(email,b.closest("tr")?.children?.[4]?.textContent?.trim()||"");return;}
        if(action==="delete"){
          if(!confirm(`تأكيد حذف الحساب ${email} نهائيًا؟`))return;
          const code=prompt("أدخل رمز دخول المدير لتأكيد حذف الحساب:",""); if(code===null||!code)return;
          payload.adminCode=code;
        }
        await adminAction(action,payload); if(action==="reset-device"){b.classList.remove("secondary");b.classList.add("start");b.textContent="✓ تم إلغاء الارتباط";b.disabled=true;return;} await loadAdminUsers();
      }catch(e){alert(e.message)}
    });
  }catch(e){$("adminOut").textContent=e.message}
}
let adminReplyTargetId=null;
function openAdminReply(id){adminReplyTargetId=id;$("adminReplyText").value="";$("adminReplyMsg").textContent="";$("adminReplyModal").classList.add("show");setTimeout(()=>$("adminReplyText").focus(),50);}
function closeAdminReply(){$("adminReplyModal").classList.remove("show");adminReplyTargetId=null;}
$("adminReplySave").onclick=async()=>{const message=$("adminReplyText").value.trim();if(!message){$("adminReplyMsg").textContent="اكتب الرد أولاً.";return;}const b=$("adminReplySave");b.disabled=true;$("adminReplyMsg").textContent="جاري حفظ الرد...";try{await adminAction("reply-support",{id:adminReplyTargetId,message});$("adminReplyMsg").textContent="تم حفظ الرد.";await loadAdminRequests("support");setTimeout(closeAdminReply,300);}catch(e){$("adminReplyMsg").textContent=e.message||"تعذر حفظ الرد.";}finally{b.disabled=false;}};
$("adminReplyClose").onclick=closeAdminReply;$("adminReplyCancel").onclick=closeAdminReply;

async function loadAdminRequests(filter="all",supportState="pending"){
  try{
    const d=await adminAction("requests"); let rows=d.requests||[];
    if(filter==="renewal") rows=rows.filter(x=>x.type==="renewal"); else if(filter==="new") rows=rows.filter(x=>x.type!=="renewal"&&x.type!=="support"); else if(filter==="support"){rows=rows.filter(x=>x.type==="support");if(supportState==="pending")rows=rows.filter(x=>!x.reply);else if(supportState==="replied")rows=rows.filter(x=>Boolean(x.reply));}
    const target=(filter==="support")?$("adminSupportOut"):$("adminOut");
    target.innerHTML=rows.length?rows.map(x=>{
      const proof=x.proof;
      const proofHtml=proof?.id?`<div style="margin-top:10px"><b>المرفق محفوظ:</b> <button type="button" class="btn secondary proofView" data-proof-id="${escapeHtml(proof.id)}">عرض المرفق</button> <button type="button" class="btn start proofSave" data-proof-id="${escapeHtml(proof.id)}" data-proof-name="${escapeHtml(proof.name||"attachment")}">حفظ المرفق</button></div>`:proof?.data?`<div style="margin-top:10px"><b>مرفق قديم:</b> <button type="button" class="btn secondary proofViewLegacy" data-proof="${encodeURIComponent(JSON.stringify(proof))}">عرض المرفق</button> <button type="button" class="btn start proofSaveLegacy" data-proof="${encodeURIComponent(JSON.stringify(proof))}">حفظ المرفق</button></div>`:`<div style="margin-top:8px;color:#a00">لا يوجد مرفق محفوظ.</div>`;
      const renewal=x.type==="renewal", support=x.type==="support";
      if(support){const a=x.attachment;const ah=a?.id?`<div class="attachmentBox"><b>📎 المرفق:</b> ${escapeHtml(a.name||"attachment")} <span class="small">(${Math.ceil(Number(a.size||0)/1024)} KB)</span><div class="actions"><button type="button" class="btn secondary supportAttachmentView" data-attachment-id="${escapeHtml(a.id)}">معاينة المرفق</button><button type="button" class="btn start supportAttachmentSave" data-attachment-id="${escapeHtml(a.id)}" data-attachment-name="${escapeHtml(a.name||"attachment")}">تنزيل المرفق</button></div></div>`:`<div class="small" style="margin-top:8px">لا يوجد مرفق.</div>`;return `<div class="adminBox"><b>${escapeHtml(x.name||x.email||"عميل")}</b> — ${x.supportKind==="suggestion"?"💡 اقتراح":"❓ استفسار"} — ${escapeHtml(x.createdAt||"")}<br>${escapeHtml(x.contact||x.email||"")}<br><b>${escapeHtml(x.subject||"")}</b><div style="white-space:pre-wrap;margin-top:8px;background:#f8fafc;border-radius:10px;padding:10px">${escapeHtml(x.message||"")}</div>${ah}${x.reply?`<div class="supportReply"><b>آخر رد:</b><div style="white-space:pre-wrap;margin-top:5px">${escapeHtml(x.reply)}</div><div class="small">${escapeHtml(x.repliedAt||"")}</div></div>`:""}<div class="actions"><button class="btn start replySupport" data-id="${escapeHtml(x.id)}">${x.reply?"تعديل الرد":"الرد على العميل"}</button></div></div>`;}
      return `<div class="adminBox"><b>${escapeHtml(x.name)}</b> — ${renewal?"🔄 تجديد":"طلب جديد"} — ${((window.sitePricing?.plans||[]).find(p=>p.id===x.plan)?.label||x.plan)} — ${escapeHtml(x.amount)} ر.س — ${escapeHtml(x.status)}<br>${escapeHtml(x.contact)} — ${escapeHtml(x.createdAt)}${proofHtml}<br>${x.status==="pending"?`<button class="btn start approveReq" data-id="${escapeHtml(x.id)}">${renewal?"اعتماد التجديد":"تفعيل"}</button>`:"تمت المعالجة"}</div>`;
    }).join(""):"لا توجد طلبات.";
    document.querySelectorAll(".approveReq").forEach(b=>b.onclick=()=>approveRequest(b.dataset.id));
    document.querySelectorAll(".proofView").forEach(b=>b.onclick=async()=>{try{const r=await apiFetch(`/.netlify/functions/requests?attachment=${encodeURIComponent(b.dataset.proofId)}`);if(!r.ok)throw Error(`HTTP ${r.status}`);const blob=await r.blob();const url=URL.createObjectURL(blob);window.open(url,"_blank","noopener");setTimeout(()=>URL.revokeObjectURL(url),120000);}catch(e){alert("تعذر فتح المرفق المحفوظ.");}});document.querySelectorAll(".proofSave").forEach(b=>b.onclick=async()=>{try{const r=await apiFetch(`/.netlify/functions/requests?attachment=${encodeURIComponent(b.dataset.proofId)}&download=1`);if(!r.ok)throw Error(`HTTP ${r.status}`);const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=b.dataset.proofName||"attachment";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);}catch(e){alert("تعذر حفظ المرفق المحفوظ.");}});document.querySelectorAll(".proofViewLegacy").forEach(b=>b.onclick=()=>showProof(JSON.parse(decodeURIComponent(b.dataset.proof))));document.querySelectorAll(".proofSaveLegacy").forEach(b=>b.onclick=()=>{try{const proof=JSON.parse(decodeURIComponent(b.dataset.proof));const raw=String(proof.data||'');const comma=raw.indexOf(',');const b64=comma>=0?raw.slice(comma+1):raw;const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);const blob=new Blob([bytes],{type:proof.type||'application/octet-stream'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=proof.name||'attachment';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);}catch(e){alert('تعذر حفظ المرفق القديم.');}});
    document.querySelectorAll(".supportAttachmentView").forEach(b=>b.onclick=async()=>{try{const r=await apiFetch(`/.netlify/functions/requests?attachment=${encodeURIComponent(b.dataset.attachmentId)}`);if(!r.ok)throw Error(`HTTP ${r.status}`);const blob=await r.blob();const url=URL.createObjectURL(blob);window.open(url,"_blank","noopener");setTimeout(()=>URL.revokeObjectURL(url),120000);}catch(e){alert("تعذر معاينة مرفق الاستفسار.");}});
    document.querySelectorAll(".supportAttachmentSave").forEach(b=>b.onclick=async()=>{try{const r=await apiFetch(`/.netlify/functions/requests?attachment=${encodeURIComponent(b.dataset.attachmentId)}&download=1`);if(!r.ok)throw Error(`HTTP ${r.status}`);const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=b.dataset.attachmentName||"attachment";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);}catch(e){alert("تعذر تنزيل مرفق الاستفسار.");}});
    document.querySelectorAll(".replySupport").forEach(b=>b.onclick=()=>openAdminReply(b.dataset.id));
  }catch(e){(filter==="support"?$("adminSupportOut"):$("adminOut")).textContent=e.message}
}
function syncAdminDaysToPlan(){const p=(window.sitePricing?.plans||[]).find(x=>x.id===$("adminPlan")?.value);if(p&&$("adminDays"))$("adminDays").value=p.days;}
$("adminPlan")?.addEventListener('change',syncAdminDaysToPlan);
$("adminCreate").onclick=async()=>{
  const btn=$("adminCreate"); if(btn?.dataset.busy==='1')return;
  const email=$("adminEmail").value.trim(),password=$("adminPassword").value,plan=$("adminPlan").value,days=Math.max(1,Number($("adminDays").value)||30);
  btn.dataset.busy='1';btn.disabled=true;const old=btn.textContent;btn.textContent='جاري الإنشاء / التفعيل...';
  try{const d=await adminAction("create",{email,password,plan,days});alert(`تم إنشاء/تفعيل الحساب\n${d.user?.email||email}`);await loadAdminUsers();}
  catch(e){alert(e.message||'تعذر إنشاء/تفعيل الحساب.');}
  finally{btn.disabled=false;btn.dataset.busy='0';btn.textContent=old;}
};
$("adminRefresh").onclick=async()=>{const b=$("adminRefresh");if(b?.dataset.busy==='1')return;b.dataset.busy='1';b.disabled=true;try{await loadAdminUsers();}finally{b.disabled=false;b.dataset.busy='0';}};
let adminSupportState="pending";
function setAdminSupportTab(state){adminSupportState=state;document.querySelectorAll(".supportTab").forEach(b=>b.classList.toggle("active",b.dataset.supportFilter===state));loadAdminRequests("support",state);}
async function loadAdminRequestsButton(id,filter,state){const b=$(id);if(!b||b.dataset.busy==='1')return;b.dataset.busy='1';b.disabled=true;const old=b.textContent;b.textContent='جاري التحميل...';try{await loadAdminRequests(filter,state);}finally{b.disabled=false;b.dataset.busy='0';b.textContent=old;}}
$("adminReq").onclick=()=>loadAdminRequestsButton("adminReq","new");$("adminRenewReq").onclick=()=>loadAdminRequestsButton("adminRenewReq","renewal");$("adminSupport").onclick=()=>loadAdminRequestsButton("adminSupport","support",adminSupportState);
document.querySelectorAll(".supportTab").forEach(b=>b.onclick=()=>setAdminSupportTab(b.dataset.supportFilter));
async function pollRefreshStatus(kind,msg,maxMs=120000){
  const started=Date.now();
  while(Date.now()-started<maxMs){
    try{
      const d=await adminAction("site-stats"),s=d.stats||{};
      if(kind==="hourly"){
        const total=Number(s.hourlyRefreshTotalBatches||0),done=Number(s.hourlyRefreshCompletedBatches||0),tt=Number(s.hourlyRefreshTotalTickers||0),dt=Number(s.hourlyRefreshCompletedTickers||0);
        if(s.hourlyRefreshState==="ready"){
          msg.textContent=`اكتمل التحديث الكامل. ${dt||tt} سهم — ${total||done} دفعة — تم نشر كاش جديد بالكامل.`;
          return true;
        }
        if(s.hourlyRefreshState==="error"){msg.textContent=`فشل التحديث الكامل: ${s.hourlyRefreshError||"خطأ غير معروف"} — تم الإبقاء على آخر كاش مكتمل.`;return false;}
        msg.textContent=`جاري تحديث كل بيانات الساعة… الدفعات ${done}/${total||"—"} — الأسهم ${dt}/${tt||"—"}${s.hourlyRefreshPhase?` — ${s.hourlyRefreshPhase}`:""}${Array.isArray(s.hourlyRefreshFailedTickers)&&s.hourlyRefreshFailedTickers.length?` — أخطاء: ${s.hourlyRefreshFailedTickers.slice(0,8).join(", ")}`:""}`;
      }else if(kind==="borrow"){
        if(s.borrowBuildStatus==="ready"){
          msg.textContent=`اكتمل تحديث الشورت والفائدة. الكاش يحتوي ${s.borrowRecords||0} سهم — بيانات محدثة فعليًا: ${s.borrowSuccessful||0} — غير متوفرة: ${s.borrowFailed||0}.`;
          return true;
        }
        if(s.borrowBuildStatus==="error"){msg.textContent=`فشل تحديث الشورت والفائدة: ${s.borrowBuildError||"خطأ غير معروف"}`;return false;}
        msg.textContent=`${s.borrowCurrentMode==="retry"?"إعادة اختبار":"جاري اختبار"} السهم ${Number(s.borrowDone||0)}/${Number(s.borrowTotal||0)} — ${s.borrowCurrentTicker?`السهم الحالي: ${escapeHtml(s.borrowCurrentTicker)} — `:""}تم الحصول على ${Number(s.borrowSuccessful||0)} — الجولة ${Number(s.borrowRound||0)}/9 — المحاولة داخل الجولة ${Number(s.borrowCurrentAttemptInRound||0)}/${Number(s.borrowCurrentRoundTotal||s.borrowTotal||0)}${s.borrowApiStatus!=null?` — HTTP ${Number(s.borrowApiStatus)}`:""}${s.borrowApiReason?` — ${escapeHtml(String(s.borrowApiReason))}`:""}`;
      }else if(kind==="cache"){
        if(s.cacheBuildStatus==="ready"){
          msg.textContent=`اكتمل تحديث كاش الباحث. ${s.cacheRecords||0} سجل جاهز.`;
          return true;
        }
        if(s.cacheBuildStatus==="error"){msg.textContent=`فشل تحديث كاش الباحث: ${s.cacheBuildError||"خطأ غير معروف"}`;return false;}
        msg.textContent="جاري إعادة بناء كاش الباحث…";
      }else if(kind==="splits"){
        if(s.splitBuildStatus==="ready"){
          msg.textContent=`اكتمل التحديث اليومي لقائمة التقسيمات (${s.splitEvents||0} حدث)، وتم تشغيل كاش الباحث.`;
          return true;
        }
        if(s.splitBuildStatus==="error"){msg.textContent=`فشل التحديث اليومي: ${s.splitBuildError||"خطأ غير معروف"}`;return false;}
        msg.textContent="جاري تحديث قائمة التقسيم ثم إعادة بناء الكاش…";
      }else if(kind==="massive"){
        if(s.massiveCurrentStatus==="ready"){
          msg.textContent=`اكتمل تحديث الأسعار الحالية. ${s.massiveCurrentRecords||0} سجل من كاش الباحث تم تحديثه (${s.massiveMarketTickers||0} سهم من السوق).`;
          return true;
        }
        if(s.massiveCurrentStatus==="error"){msg.textContent=`فشل تحديث Massive: ${s.massiveCurrentError||"خطأ غير معروف"}`;return false;}
        msg.textContent="جاري تحديث الأسعار الحالية…";
      }
    }catch{}
    await sleep(kind==="borrow"?1000:3000);
  }
  msg.textContent="انتهت متابعة الطلب من هذه الشاشة؛ المهمة تعمل في الخلفية. يمكنك تحديث الإحصائيات لاحقًا للتأكد من النتيجة.";
  return false;
}
function bindSingleFlightClick(id,handler){
  const btn=$(id); if(!btn)return;
  btn.onclick=async()=>{
    if(btn.dataset.busy==='1')return;
    btn.dataset.busy='1';
    try{await handler(btn);}finally{btn.dataset.busy='0';}
  };
}
async function triggerSavedCacheUpdate(btn,msg){
  if(!btn||!msg)return;
  btn.disabled=true; msg.textContent="جاري تشغيل التحديث الكامل لبيانات الساعة…";
  try{
    const r=await apiFetch("/.netlify/functions/scanner-hourly-refresh-manual",{method:"POST",headers:{"Content-Type":"application/json"}});
    const d=await responseJSON(r);
    if(!r.ok) throw Error(d?.error||`تعذر تشغيل التحديث الكامل (HTTP ${r.status}).`);
    if(d?.error) throw Error(d.error);
    await pollRefreshStatus("hourly",msg,900000);
    await loadSiteStats();
  }catch(e){msg.textContent=e.message||"تعذر تشغيل التحديث الكامل لبيانات الساعة.";}
  finally{btn.disabled=false;}
}
async function triggerDailySplitUpdate(btn,msg){
  if(!btn||!msg)return; btn.disabled=true; msg.textContent="جاري تحديث قائمة التقسيم…";
  try{const r=await apiFetch("/.netlify/functions/scanner-daily-refresh-manual",{method:"POST"});const d=await responseJSON(r);if(!r.ok)throw Error(d?.error||`تعذر تشغيل تحديث القائمة (HTTP ${r.status}).`);await pollRefreshStatus("splits",msg,900000);await loadSiteStats();}catch(e){msg.textContent=e.message||"تعذر تحديث قائمة التقسيم.";}finally{btn.disabled=false;}
}
async function triggerFloatUpdate(btn,msg){if(!btn||!msg)return;btn.disabled=true;msg.textContent="جاري تشغيل تحديث Free Float فقط…";try{const r=await apiFetch("/.netlify/functions/float-worker-manual",{method:"POST"});const d=await responseJSON(r);if(!r.ok)throw Error(d?.error||`تعذر تشغيل تحديث Free Float (HTTP ${r.status}).`);msg.textContent="تم تشغيل تحديث Free Float في الخلفية. راجع الإحصائيات بعد اكتماله.";await sleep(1200);await loadSiteStats();}catch(e){msg.textContent=e.message||"تعذر تشغيل تحديث Free Float.";}finally{btn.disabled=false;}}
async function triggerMassiveCurrentUpdate(btn,msg){
  if(!btn||!msg)return;btn.disabled=true;btn.dataset.busy='1';msg.textContent='جاري تشغيل تحديث الأسعار…';
  try{const d=await adminAction('refresh-massive');if(!d?.ok)throw Error(d?.error||'تعذر تشغيل تحديث Massive.');msg.textContent='تم تشغيل تحديث الأسعار في الخلفية…';await pollRefreshStatus('massive',msg,60000);await loadSiteStats();}
  catch(e){msg.textContent=e.message||'تعذر تشغيل تحديث Massive.';}
  finally{btn.disabled=false;btn.dataset.busy='0';}
}
async function triggerCacheOnlyUpdate(btn,msg){
  return triggerSavedCacheUpdate(btn,msg);
}
async function triggerBorrowUpdate(btn,msg){
  if(!btn||!msg)return; btn.disabled=true; msg.textContent="جاري تحديث الشورت والفائدة الآن…";
  try{const r=await apiFetch("/.netlify/functions/update-short-background",{method:"POST",headers:{"Content-Type":"application/json"}});const d=await responseJSON(r);if(!r.ok)throw Error(d?.error||`تعذر تشغيل تحديث الشورت (HTTP ${r.status}).`);await pollRefreshStatus("borrow",msg,2700000);await loadSiteStats();}catch(e){msg.textContent=e.message||"تعذر تحديث الشورت والفائدة.";}finally{btn.disabled=false;}
}
bindSingleFlightClick("refreshBorrowNow",btn=>triggerBorrowUpdate(btn,$("borrowAdminMsg")));
bindSingleFlightClick("refreshMassiveCurrent",btn=>triggerMassiveCurrentUpdate(btn,$("massiveCurrentAdminMsg")));bindSingleFlightClick("refreshFloatNow",btn=>triggerFloatUpdate(btn,$("floatAdminMsg")));
bindSingleFlightClick("refreshSavedCache",btn=>triggerSavedCacheUpdate(btn,$("savedCacheAdminMsg")));
bindSingleFlightClick("refreshDailySplits",btn=>triggerDailySplitUpdate(btn,$("dailySplitsAdminMsg")));
bindSingleFlightClick("refreshSiteStats",()=>loadSiteStats());
async function loadSiteStats(){
  const out=$("siteStatsOut");if(!out)return;out.textContent="جاري تحميل الإحصائيات...";
  try{
    const d=await adminAction("site-stats"),s=d.stats||{};
    const mode=s.siteMode==="normal"?"الموقع يعمل":s.siteMode==="maintenance"?"الموقع تحت الصيانة":"الموقع تحت التطوير";
    const updated=s.cacheUpdatedAt?new Date(s.cacheUpdatedAt).toLocaleString("ar-SA"):"غير متوفر"; const cacheState=s.cacheBuildStatus==="ready"?"جاهز":s.cacheBuildStatus==="building"?"قيد التجهيز":s.cacheBuildStatus==="error"?"فشل التجهيز":"غير معروف"; const cacheWarn=Number(s.cacheMissingRows||0)>0?`<br><span style="color:#b45309">تنبيه: ${Number(s.cacheMissingRows)} من ${Number(s.cacheExpectedRows||0)} حدث غير مكتمل، وسيُعاد طلبه في التحديث القادم.</span>`:""; const splitUpdated=s.splitsUpdatedAt?new Date(s.splitsUpdatedAt).toLocaleString("ar-SA"):"غير متوفر";
    out.innerHTML=`<div class="grid">
      <div><label>إجمالي العملاء</label><div class="calcbox big">${Number(s.totalCustomers||0).toLocaleString()}</div></div>
      <div><label>العملاء النشطون</label><div class="calcbox big">${Number(s.activeCustomers||0).toLocaleString()}</div></div>
      <div><label>الاشتراكات المنتهية</label><div class="calcbox big">${Number(s.expiredCustomers||0).toLocaleString()}</div></div>
      <div><label>العملاء الذين دخلوا</label><div class="calcbox big">${Number(s.loggedInCustomers||0).toLocaleString()}</div></div>
      <div><label>لم يدخلوا حتى الآن</label><div class="calcbox big">${Number(s.notLoggedInCustomers||0).toLocaleString()}</div></div>
      <div><label>دخول خلال آخر 24 ساعة</label><div class="calcbox big">${Number(s.loginsLast24h||0).toLocaleString()}</div></div>
      <div><label>طلبات معلقة</label><div class="calcbox big">${Number(s.pendingRequests||0).toLocaleString()}</div></div>
      <div><label>رسائل دعم تحتاج متابعة</label><div class="calcbox big">${Number(s.supportPending||0).toLocaleString()}</div></div>
      <div><label>الدفعات المعتمدة</label><div class="calcbox big">${Number(s.approvedPayments||0).toLocaleString()}</div></div>
      <div><label>الإيرادات المسجلة</label><div class="calcbox big">${"$"+Number(s.revenue||0).toLocaleString()}</div></div>
      <div><label>أسهم الكاش</label><div class="calcbox big">${Number(s.cacheRecords||0).toLocaleString()}</div></div>
      <div><label>حالة كاش الباحث</label><div class="calcbox" style="font-size:14px">${cacheState}${cacheWarn}${s.cacheBuildError?`<br><span style="color:#b91c1c">${escapeHtml(s.cacheBuildError)}</span>`:""}</div></div><div><label>آخر تحديث للبيانات</label><div class="calcbox" style="font-size:14px">${escapeHtml(updated)}</div></div>
      <div><label>آخر تحديث لقائمة التقسيمات</label><div class="calcbox" style="font-size:14px">${escapeHtml(splitUpdated)}</div></div>
      <div><label>كاش الاكتتابات</label><div class="calcbox" style="font-size:14px">${Number(s.ipoRecords||0).toLocaleString()} اكتتاب — ${s.ipoStatus==="ready"?"جاهز":s.ipoStatus==="building"?"قيد التحديث":s.ipoStatus==="error"?"فشل":"غير متوفر"}<br>${s.ipoUpdatedAt?escapeHtml(new Date(s.ipoUpdatedAt).toLocaleString("ar-SA")):"غير متوفر"}</div></div>
      <div><label>تحديث البيانات الفنية والأسعار كل 5 دقائق</label><div class="calcbox" style="font-size:14px">${s.hourlyRefreshState==="ready"?"جاهز":s.hourlyRefreshState==="building"?"قيد التحديث":s.hourlyRefreshState==="error"?"فشل":"غير معروف"}<br>${Number(s.hourlyRefreshCompletedBatches||0).toLocaleString()}/${Number(s.hourlyRefreshTotalBatches||0).toLocaleString()} دفعة — ${Number(s.hourlyRefreshCompletedTickers||0).toLocaleString()}/${Number(s.hourlyRefreshTotalTickers||0).toLocaleString()} سهم<br>${s.hourlyRefreshPhase?escapeHtml(s.hourlyRefreshPhase):""}<br>${s.hourlyRefreshFinishedAt?escapeHtml(new Date(s.hourlyRefreshFinishedAt).toLocaleString("ar-SA")):s.hourlyRefreshStartedAt?escapeHtml(new Date(s.hourlyRefreshStartedAt).toLocaleString("ar-SA")):"غير متوفر"}</div></div><div><label>كاش الشورت والفائدة</label><div class="calcbox" style="font-size:14px">${Number(s.borrowRecords||0).toLocaleString()} سهم في الكاش — ${Number(s.borrowSuccessful||0).toLocaleString()} محدث / ${Number(s.borrowFailed||0).toLocaleString()} غير متوفر — ${s.borrowBuildStatus==="ready"?"جاهز":s.borrowBuildStatus==="building"?"قيد التحديث":s.borrowBuildStatus==="error"?"فشل":"غير معروف"}<br>${s.borrowBuildStatus==="building"?`${s.borrowCurrentMode==="retry"?"إعادة اختبار":"اختبار"}: ${Number(s.borrowDone||0)}/${Number(s.borrowTotal||0)} — السهم: ${escapeHtml(s.borrowCurrentTicker||"—")} — الجولة ${Number(s.borrowRound||0)}/9 — داخل الجولة ${Number(s.borrowCurrentAttemptInRound||0)}/${Number(s.borrowCurrentRoundTotal||0)}`:""}<br>${s.borrowUpdatedAt?escapeHtml(new Date(s.borrowUpdatedAt).toLocaleString("ar-SA")):"غير متوفر"}</div></div>
    </div>
    <div class="adminBox"><b>حالة الموقع:</b> ${mode}<br><b>نطاق الباحث:</b> آخر ${Number(s.cacheWindowDays||100)} يوم<br>${s.siteModeMessage?`<b>رسالة العملاء:</b> ${escapeHtml(s.siteModeMessage)}`:""}</div>
    <div class="small">آخر قراءة للإحصائيات: ${escapeHtml(new Date().toLocaleString("ar-SA"))}</div>`;
  }catch(e){out.textContent=e.message||"تعذر تحميل إحصائيات الموقع.";}
}
function showAdminHome(){siteSettingsUnlocked=false;closeSiteSettingsUnlock();$("adminHome").style.display="block";document.querySelectorAll(".adminPanel").forEach(x=>x.classList.remove("show"));}
async function showAdminPanel(name){
  if(name==="site"){
    if(!await unlockSiteSettings())return;
    if(!await loadSiteSettingsPanel())return;
  }
  $("adminHome").style.display="none";document.querySelectorAll(".adminPanel").forEach(x=>x.classList.remove("show"));$("adminPanel-"+name).classList.add("show");
  if(name==="customers")loadAdminUsers();if(name==="support")loadAdminRequests("support","pending");if(name==="stats")loadSiteStats();
}
document.querySelectorAll("[data-admin-panel]").forEach(b=>{
  b.addEventListener('click',async e=>{
    e.preventDefault();
    const name=b.dataset.adminPanel;
    await showAdminPanel(name);
  });
});document.querySelectorAll(".adminBack").forEach(b=>b.onclick=showAdminHome);

async function approveRequest(id){
  const btn=[...document.querySelectorAll('.approveReq')].find(x=>x.dataset.id===id);
  if(btn?.dataset.busy==='1')return;
  if(btn)btn.dataset.busy='1';
  const old=btn?.textContent; if(btn){btn.disabled=true;btn.textContent='جاري التفعيل...';}
  try{
    const d=await adminAction('approve',{id});
    alert(`تم التفعيل\nالحساب: ${d.email}\nكلمة المرور: ${d.password}`);
    await loadAdminRequests();
    await loadAdminUsers();
  }catch(e){alert(e.message||'تعذر تفعيل الطلب.');}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'تفعيل';btn.dataset.busy='0';}}
}

// حفظ إعدادات الباحث تلقائيًا للحساب المسجل، مع فرض الحد الأقصى 100 يوم فورًا.
["days","maxPrice","drop","rsiMax","shortMax"].forEach(id=>{const el=$(id);if(el){el.addEventListener("input",()=>{if(id==="days")clampScannerDays();});el.addEventListener("change",()=>{if(id==="days")clampScannerDays();});}});
$("saveScannerSettings")?.addEventListener("click",()=>saveScannerSettings());


// لوحة اختبار الضغط: ربط جميع أزرار الاختبارات فعليًا بالـFunction.
let selectedLoadTest="scanner", loadAbort=null, loadBusy=false;
const loadTestNames={scanner:"الباحث",me:"الحساب",favorites:"المفضلة",health:"صحة الموقع",serverFull:"محاكاة مستخدمين مستقلين"};
function setLoadSelected(mode){selectedLoadTest=mode;const el=$("loadSelected");if(el)el.textContent="الاختبار المحدد: "+(loadTestNames[mode]||mode);document.querySelectorAll(".loadPick").forEach(b=>b.classList.toggle("start",b.dataset.test===mode));}
function renderLoadResult(d,mode){
  $("ltTotal").textContent=Number(d.totalRequests??d.totalUsers??d.users??0).toLocaleString();
  $("ltOk").textContent=Number(d.success??0).toLocaleString();
  $("ltFail").textContent=Number(d.failure??0).toLocaleString();
  $("ltAvg").textContent=Number.isFinite(Number(d.avgMs))?Math.round(Number(d.avgMs))+" ms":"—";
  $("ltMin").textContent=Number.isFinite(Number(d.minMs))?Math.round(Number(d.minMs))+" ms":"—";
  $("ltMax").textContent=Number.isFinite(Number(d.maxMs))?Math.round(Number(d.maxMs))+" ms":"—";
  $("lt429").textContent=Number(d.c429??0).toLocaleString(); $("lt5xx").textContent=Number(d.c5xx??0).toLocaleString();
  const log=$("loadLog"); if(log)log.textContent=JSON.stringify({الاختبار:loadTestNames[mode]||mode,النتيجة:d},null,2);
}
async function runLoadTest(mode){
  if(loadBusy)return; loadBusy=true; const btn=$("loadRunSelected"),stop=$("loadStop"),log=$("loadLog"); if(btn)btn.disabled=true;if(stop)stop.disabled=false;if(log)log.textContent="جاري تنفيذ اختبار "+(loadTestNames[mode]||mode)+"…";
  loadAbort=new AbortController();
  try{
    const users=Math.max(1,Math.min(500,Number($("loadUsers")?.value)||100)); const rounds=Math.max(1,Math.min(10,Number($("loadRounds")?.value)||1));
    const r=await apiFetch("/.netlify/functions/load-test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({users,rounds,mode}),signal:loadAbort.signal});
    const d=await responseJSON(r); if(!r.ok)throw Error(d.error||`HTTP ${r.status}`); renderLoadResult(d,mode);
  }catch(e){if(e.name==="AbortError"){if(log)log.textContent="تم إيقاف الطلب من المتصفح.";}else if(log)log.textContent=e.message||"تعذر تنفيذ الاختبار.";}
  finally{loadBusy=false;loadAbort=null;if(btn)btn.disabled=false;if(stop)stop.disabled=true;}
}
$("loadRunSelected")?.addEventListener("click",()=>runLoadTest(selectedLoadTest));
$("loadRunAll")?.addEventListener("click",async()=>{for(const mode of ["scanner","me","favorites","health","serverFull"]){if(loadBusy)break;setLoadSelected(mode);await runLoadTest(mode);}});
$("loadStop")?.addEventListener("click",()=>{loadAbort?.abort();});
document.querySelectorAll(".loadPick").forEach(b=>b.addEventListener("click",()=>setLoadSelected(b.dataset.test)));
setLoadSelected("scanner");

// نظام التنبيهات والمفضلة
$('alertClose')?.addEventListener('click',()=>$('alertModal').classList.remove('show'));
$('alertSave')?.addEventListener('click',saveAlertSettings);$('telegramAlertLink')?.addEventListener('click',loadTelegramLink);$('telegramTestBtn')?.addEventListener('click',sendTelegramAlertTest);$('telegramAlertLinkModal')?.addEventListener('click',loadTelegramLink);$('setupTelegramWebhook')?.addEventListener('click',setupTelegramWebhook);$('telegramBroadcastBtn')?.addEventListener('click',sendTelegramBroadcast);
$('alertDisable')?.addEventListener('click',disableAlert);
$('notificationBell')?.addEventListener('click',openNotificationBell);
$('notificationClose')?.addEventListener('click',()=>$('notificationPanel').classList.remove('show'));
$('notificationPanel')?.addEventListener('click',e=>{if(e.target===$('notificationPanel'))$('notificationPanel').classList.remove('show')});
// التشغيل الأول للحسابات
loadPublicPricing();loadMe();
window.addEventListener("pageshow",()=>{setTimeout(()=>loadMe(),150);});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&sessionKnown)setTimeout(()=>loadMe(),150);});

// القائمة
$("menu").onclick=()=>$("drawer").classList.add("open");$("close").onclick=()=>$("drawer").classList.remove("open");
function activateSection(name){
  const target=$("sec-"+name); if(!target)return false;
  if(name==="admin"&&!sessionReady)return false;
  document.querySelectorAll(".section").forEach(x=>x.classList.remove("active"));
  target.classList.add("active");
  document.querySelectorAll(".navBtn").forEach(x=>x.classList.toggle("active",x.dataset.sec===name));
  if(name!=="admin"){document.querySelectorAll(".adminPanel").forEach(x=>x.classList.remove("show"));$("adminHome")?.style.setProperty("display","block");}
  if(name==="admin")showAdminHome();
  if(name==="favorites"){loadFavorites();startFavoriteAutoRefresh();}else stopFavoriteAutoRefresh();
  return true;
}
document.querySelectorAll(".navBtn").forEach(b=>b.onclick=()=>{if(activateSection(b.dataset.sec))$("drawer").classList.remove("open");});
$("refreshFavorites").onclick=()=>refreshFavoriteData(true);$("proofClose").onclick=()=>$("proofModal").classList.remove("show");$("testClose").onclick=()=>$("testModal").classList.remove("show");$("detailsClose").onclick=()=>$("detailsModal").classList.remove("show");document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelectorAll(".testModal.show").forEach(m=>m.classList.remove("show"));});

document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'clearAlertsBtn') {
        if (!confirm('هل تريد حقاً مسح جميع حالات التنبيهات القديمة وتصفيرها؟')) return;
        
        try {
            const res = await apiFetch('/.netlify/functions/alerts?action=clear', {
                method: 'DELETE'
            });
            
            if (res.ok) {
                alert('تمت تصفير التنبيهات القديمة بنجاح!');
                location.reload();
            } else {
                alert('فشل تصفير التنبيهات من السيرفر');
            }
        } catch (err) {
            console.error('Error clearing alerts:', err);
            alert('حدث خطأ أثناء الاتصال بالـ API');
        }
    }
});
