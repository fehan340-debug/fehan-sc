import { json, readJson, currentUser, getDataStore, getFavorites, getUserSettingsStore, getUsers, saveUsers, randomToken } from "../../lib.js";
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
function telegramConfig(){
  return {
    token:String(process.env.TELEGRAM_BOT_TOKEN||"").trim(),
    username:String(process.env.TELEGRAM_BOT_USERNAME||"").trim().replace(/^@/,""),
    siteUrl:String(process.env.SITE_URL||process.env.URL||"").trim().replace(/\/+$/,"")
  };
}
async function createTelegramLink(email){
  const {username}=telegramConfig();
  if(!username)return null;
  const token=randomToken();
  await getDataStore().setJSON(`telegram-link:${token}`,{email:String(email).toLowerCase(),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60*1000).toISOString()});
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(token)}`;
}
async function sendTelegram(chatId,text){
  const token=String(process.env.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token||!chatId)return {sent:false,reason:!token?"telegram_not_configured":"telegram_not_linked"};
  let lastError='Telegram send failed';
  for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    try{
      const r=await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true}),signal:controller.signal});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d?.ok===true)return {sent:true,messageId:d?.result?.message_id||null};
      lastError=`Telegram HTTP ${r.status}: ${d?.description||"sendMessage failed"}`;
      if(![429,500,502,503,504].includes(r.status))break;
    }catch(e){lastError=e?.name==='AbortError'?'Telegram request timed out':String(e?.message||e);}
    finally{clearTimeout(timer);}
    if(attempt<2)await new Promise(r=>setTimeout(r,500*(attempt+1)));
  }
  throw new Error(lastError);
}
function supabaseConfig(){
  return {
    url:String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,''),
    key:String(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_KEY||'').trim()
  };
}
async function supabaseTable(path,options={}){
  const {url,key}=supabaseConfig();
  if(!url||!key)return {available:false};
  const r=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation',...(options.headers||{})}});
  const text=await r.text(); let data=null; try{data=text?JSON.parse(text):null;}catch{}
  if(!r.ok){
    if(r.status===404||r.status===406||r.status===42703||r.status===42)return {available:false,status:r.status};
    return {available:false,status:r.status,error:text.slice(0,500)};
  }
  return {available:true,data};
}
function alertRowToObject(row){
  return {ticker:cleanTicker(row.ticker),splitDate:String(row.split_date||''),enabled:Boolean(row.enabled),drop:{enabled:Boolean(row.drop_enabled),mode:row.drop_mode==='price'?'price':'percent',value:row.drop_value==null?null:Number(row.drop_value)},short:{enabled:Boolean(row.short_enabled),value:row.short_value==null?null:Number(row.short_value)},rsi:{enabled:Boolean(row.rsi_enabled),value:row.rsi_value==null?null:Number(row.rsi_value),direction:row.rsi_direction==='above'?'above':'below'},updatedAt:row.updated_at||null};
}
function alertObjectToRow(email,a){
  return {user_email:String(email).toLowerCase(),ticker:a.ticker,split_date:a.splitDate||null,enabled:Boolean(a.enabled),drop_enabled:Boolean(a.drop?.enabled),drop_mode:a.drop?.mode==='price'?'price':'percent',drop_value:a.drop?.value==null?null:Number(a.drop.value),short_enabled:Boolean(a.short?.enabled),short_value:a.short?.value==null?null:Number(a.short.value),rsi_enabled:Boolean(a.rsi?.enabled),rsi_value:a.rsi?.value==null?null:Number(a.rsi.value),rsi_direction:a.rsi?.direction==='above'?'above':'below',updated_at:new Date().toISOString()};
}
async function readAlerts(email){
  const mirror=await getDataStore().get(keyFor(email,'settings'),{type:'json'}).catch(()=>null)||{};
  const q=`user_alerts?select=*&user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&order=ticker.asc`;
  const r=await supabaseTable(q);
  if(r.available){
    const out={};
    for(const row of Array.isArray(r.data)?r.data:[]){const a=alertRowToObject(row);out[a.ticker]=a;}
    return Object.keys(out).length?out:mirror;
  }
  return mirror;
}
async function upsertAlert(email,a){
  const row=alertObjectToRow(email,a);
  const r=await supabaseTable('user_alerts',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(row)});
  const all=await getDataStore().get(keyFor(email,'settings'),{type:'json'}).catch(()=>null)||{};
  all[a.ticker]=a;
  await getDataStore().setJSON(keyFor(email,'settings'),all);
  return Boolean(r.available);
}
async function deleteAlert(email,ticker){
  const r=await supabaseTable(`user_alerts?user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&ticker=eq.${encodeURIComponent(ticker)}`,{method:'DELETE'});
  const all=await getDataStore().get(keyFor(email,'settings'),{type:'json'}).catch(()=>null)||{};
  delete all[ticker];
  await getDataStore().setJSON(keyFor(email,'settings'),all);
  return Boolean(r.available);
}
async function appendAlertHistory(email,event){
  const row={user_email:String(email).toLowerCase(),ticker:event.ticker,alert_type:event.type,title:event.title,message:event.message,created_at:event.createdAt||new Date().toISOString(),payload:event};
  const r=await supabaseTable('stock_alerts',{method:'POST',body:JSON.stringify(row)});
  const history=await getDataStore().get(keyFor(email,'history'),{type:'json'}).catch(()=>null)||[];
  await getDataStore().setJSON(keyFor(email,'history'),[event,...history].slice(0,100));
  return Boolean(r.available);
}
async function readAlertHistory(email){
  const mirror=await getDataStore().get(keyFor(email,'history'),{type:'json'}).catch(()=>null)||[];
  const q=`stock_alerts?select=*&user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&order=created_at.desc&limit=100`;
  const r=await supabaseTable(q);
  if(r.available){
    const rows=(Array.isArray(r.data)?r.data:[]).map(x=>({ticker:x.ticker,type:x.alert_type,title:x.title,message:x.message,createdAt:x.created_at}));
    return rows.length?rows:mirror;
  }
  return mirror;
}
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
    for(const [type,hit,detail] of checks){
      const sk=`${ticker}:${type}`; const prev=nextState[sk]||{}; const was=Boolean(prev.hit);
      if(hit&&!was){
        const title=`تنبيه ${ticker}`; const message=`${ticker}: ${detail}`;
        const users=await getUsers(); const user=users[String(email).toLowerCase()];
        const telegramLinked=Boolean(user?.telegramChatId);
        let delivered=!telegramLinked;
        if(telegramLinked){
          try{
            const result=await sendTelegram(user.telegramChatId,`🔔 ${title}\n${message}`);
            delivered=Boolean(result?.sent);
          }catch(e){
            delivered=false;
            console.warn('Telegram send failed; alert will retry on next sweep',ticker,type,e.message);
          }
        }
        // Only record/consume the trigger after delivery is confirmed.
        // If Telegram is linked but temporarily fails, nothing is consumed and the next sweep retries it.
        if(delivered){
          fired.push({ticker,type,title,message,createdAt:new Date().toISOString(),telegramSent:telegramLinked});
          nextState[sk]={hit:true,updatedAt:new Date().toISOString()};
          changed=true;
        }
      } else if(!hit&&was){
        nextState[sk]={hit:false,updatedAt:new Date().toISOString()};
        changed=true;
      }
    }
  }
  if(fired.length){let savedAny=false;for(const event of fired){const saved=await appendAlertHistory(email,event).catch(e=>{console.warn('alert history save failed',e.message);return false;});savedAny=savedAny||saved;}if(!savedAny)await getDataStore().setJSON(keyFor(email,'history'),[...fired,...history].slice(0,100));}
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
export async function createUserTelegramLink(email){
  const users=await getUsers();
  const user=users[String(email||"").toLowerCase()];
  if(!user)return {linked:false,link:null};
  if(user.telegramChatId){
    await getDataStore().setJSON(`telegram-subscriber:${String(email).toLowerCase()}`,{email:String(email).toLowerCase(),chatId:String(user.telegramChatId),linkedAt:user.telegramLinkedAt||null,admin:Boolean(user.admin)}).catch(()=>{});
    return {linked:true,chatId:String(user.telegramChatId),username:user.telegramUsername||null,link:null};
  }
  return {linked:false,link:await createTelegramLink(email)};
}

export default async function(request){
  try{
    const action=new URL(request.url).searchParams.get('action')||'settings'; const c=await currentUser(request);
    if(!c?.user||c.blocked) return json({error:'غير مصرح. سجّل الدخول.'},401);
    const email=c.user.email;
    if(action==='settings'){
      if(request.method==='GET'){const settings=await readAlerts(email);return json({ok:true,settings,telegram:await createUserTelegramLink(email)});}
      if(request.method==='POST'){const b=await readJson(request);const a=cleanAlert(b);await upsertAlert(email,a);return json({ok:true,settings:await readAlerts(email),telegram:await createUserTelegramLink(email)});}
      if(request.method==='DELETE'){const b=await readJson(request);const ticker=cleanTicker(b.ticker);await deleteAlert(email,ticker);return json({ok:true,settings:await readAlerts(email)});}
    }
    if(action==='history'){return json({ok:true,items:await readAlertHistory(email)});}
    if(action==='telegram-link'){return json({ok:true,telegram:await createUserTelegramLink(email)});}
    if(action==='telegram-test'){
      const users=await getUsers();
      const user=users[String(email).toLowerCase()];
      if(!user?.telegramChatId)return json({ok:false,error:'الحساب غير مربوط بتليجرام.'},400);
      const result=await sendTelegram(user.telegramChatId,'✅ اختبار تنبيهات The Short Scope\nإذا وصلت هذه الرسالة فمسار التنبيهات عبر تليجرام يعمل بشكل صحيح.');
      return json({ok:true,...result});
    }
    return json({error:'إجراء غير مدعوم.'},405);
  }catch(e){return json({error:String(e?.message||e)},500);}
}
