import { json, readJson, currentUser, getDataStore, getFavorites, getUserSettingsStore, getUsers } from "../../lib.js";
import { readPublishedCache } from "./scanner-hourly-core.mjs";

const keyFor=(email,name)=>`alerts:${String(email||"").toLowerCase()}:${name}`;
const cleanTicker=x=>String(x||"").trim().toUpperCase();
const validTicker=x=>/^[A-Z0-9.\-]{1,15}$/.test(x);
function cleanAlert(a){
  const ticker=cleanTicker(a?.ticker); if(!validTicker(ticker)) throw new Error("رمز السهم غير صالح.");
  const dropMode=a?.drop?.mode==='price'?'price':'percent';
  const num=v=>Number.isFinite(Number(v))?Number(v):null;
  const r={ticker,splitDate:String(a?.splitDate||""),enabled:Boolean(a?.enabled),
    drop:{enabled:Boolean(a?.drop?.enabled),mode:dropMode,value:num(a?.drop?.value)},
    short:{enabled:Boolean(a?.short?.enabled),value:num(a?.short?.value)},
    rsi:{enabled:Boolean(a?.rsi?.enabled),value:num(a?.rsi?.value),direction:a?.rsi?.direction==='above'?'above':'below'}};
  if(r.drop.enabled && (r.drop.value===null || r.drop.value<0 || (dropMode==='percent'&&r.drop.value>100))) throw new Error(`قيمة هبوط ${ticker} غير صحيحة.`);
  if(r.short.enabled && (r.short.value===null || r.short.value<0)) throw new Error(`قيمة الشورت ${ticker} غير صحيحة.`);
  if(r.rsi.enabled && (r.rsi.value===null || r.rsi.value<0 || r.rsi.value>100)) throw new Error(`قيمة RSI ${ticker} غير صحيحة.`);
  return r;
}
async function sendOneSignal(email,title,message,data={}){
  const appId=String(process.env.ONESIGNAL_APP_ID||"").trim(), apiKey=String(process.env.ONESIGNAL_REST_API_KEY||"").trim();
  if(!appId||!apiKey) return {sent:false,reason:"onesignal_not_configured"};
  const r=await fetch("https://api.onesignal.com/notifications",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${apiKey}`},body:JSON.stringify({app_id:appId,target_channel:"push",include_aliases:{external_id:[String(email).toLowerCase()]},headings:{en:title,ar:title},contents:{en:message,ar:message},data})});
  const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
  if(!r.ok) throw new Error(`OneSignal HTTP ${r.status}: ${d.errors?.[0]||d.message||text.slice(0,200)}`);
  return {sent:true,id:d.id||null};
}
async function readAlerts(email){return await getDataStore().get(keyFor(email,'settings'),{type:'json'}).catch(()=>null)||{};}
async function saveAlerts(email,v){await getDataStore().setJSON(keyFor(email,'settings'),v||{});return v||{};}
export async function evaluateUserAlerts(email,records){
  const settings=await readAlerts(email); const state=await getDataStore().get(keyFor(email,'state'),{type:'json'}).catch(()=>null)||{};
  const history=await getDataStore().get(keyFor(email,'history'),{type:'json'}).catch(()=>null)||[];
  const nextState={...state}; let changed=false, fired=[];
  const byTicker=new Map((records||[]).map(x=>[cleanTicker(x?.ticker),x]));
  for(const [ticker,a] of Object.entries(settings)){
    if(!a?.enabled) continue; const row=byTicker.get(ticker); if(!row) continue;
    const price=Number(row.currentPrice??row.current), change=Number(row.changePct), short=Number(row.shortShares), rsi=Number(row.rsi);
    const checks=[];
    if(a.drop?.enabled){ const hit=a.drop.mode==='price' ? (Number.isFinite(price)&&price<=Number(a.drop.value)) : (Number.isFinite(change)&&change<=-Math.abs(Number(a.drop.value))); checks.push(['drop',hit,a.drop.mode==='price'?`وصل السعر إلى $${price.toFixed(2)}`:`هبوط ${Math.abs(change).toFixed(2)}%`]); }
    if(a.short?.enabled) checks.push(['short',Number.isFinite(short)&&short<=Number(a.short.value),`الشورت ${short.toLocaleString()}`]);
    if(a.rsi?.enabled){ const v=Number(a.rsi.value), hit=a.rsi.direction==='above'?(Number.isFinite(rsi)&&rsi>=v):(Number.isFinite(rsi)&&rsi<=v); checks.push(['rsi',hit,`RSI ${rsi.toFixed(1)}`]); }
    for(const [type,hit,detail] of checks){ const sk=`${ticker}:${type}`; const prev=nextState[sk]||{}; const was=Boolean(prev.hit); if(hit&&!was){
        const title=`تنبيه ${ticker}`; const message=`${ticker}: ${detail}`;
        try{ await sendOneSignal(email,title,message,{ticker,type}); }catch(e){ console.warn('OneSignal send failed',ticker,type,e.message); }
        fired.push({ticker,type,title,message,createdAt:new Date().toISOString()}); nextState[sk]={hit:true,updatedAt:new Date().toISOString()}; changed=true;
      } else if(!hit&&was){ nextState[sk]={hit:false,updatedAt:new Date().toISOString()}; changed=true; }
    }
  }
  if(fired.length){const merged=[...fired,...history].slice(0,100);await getDataStore().setJSON(keyFor(email,'history'),merged);}
  if(changed)await getDataStore().setJSON(keyFor(email,'state'),nextState);
  return {fired};
}
export async function runAlertSweep(){
  const users=await getUsers();
  const cache=await readPublishedCache();
  const current=await getDataStore().get('scanner-current-price-v1',{type:'json'}).catch(()=>null)||{};
  const liveMap=new Map((current.records||[]).map(x=>[cleanTicker(x?.ticker),x]));
  const records=(Array.isArray(cache?.records)?cache.records:[]).map(x=>{const live=liveMap.get(cleanTicker(x?.ticker));return live?{...x,current:live.price,currentPrice:live.price,changePct:live.changePct,priceSource:live.priceSource,priceSession:live.priceSession}:x;}); if(!records.length)return {ok:true,users:0,fired:0};
  let fired=0, usersChecked=0;
  for(const email of Object.keys(users)){ const a=await readAlerts(email); if(!Object.keys(a).length)continue; usersChecked++; const r=await evaluateUserAlerts(email,records); fired+=r.fired.length; }
  return {ok:true,users:usersChecked,fired};
}
export default async function(request){
  try{
    const action=new URL(request.url).searchParams.get('action')||'settings'; const c=await currentUser(request);
    if(action==='config') return json({ok:true,appId:String(process.env.ONESIGNAL_APP_ID||'')});
    if(!c?.user||c.blocked) return json({error:'غير مصرح. سجّل الدخول.'},401);
    const email=c.user.email;
    if(action==='settings'){
      if(request.method==='GET') return json({ok:true,settings:await readAlerts(email)});
      if(request.method==='POST'){ const b=await readJson(request); const a=cleanAlert(b); const all=await readAlerts(email); all[a.ticker]=a; await saveAlerts(email,all); return json({ok:true,settings:all}); }
      if(request.method==='DELETE'){const b=await readJson(request);const ticker=cleanTicker(b.ticker);const all=await readAlerts(email);delete all[ticker];await saveAlerts(email,all);return json({ok:true,settings:all});}
    }
    if(action==='history'){const h=await getDataStore().get(keyFor(email,'history'),{type:'json'}).catch(()=>null)||[];return json({ok:true,items:h.slice(0,100)});}
    if(action==='test'){const b=await readJson(request);const r=await sendOneSignal(email,'اختبار التنبيهات','تم تفعيل إشعارات الباحث بنجاح.',{test:true});return json({ok:true,...r});}
    return json({error:'إجراء غير مدعوم.'},405);
  }catch(e){return json({error:String(e?.message||e)},500);}
}
