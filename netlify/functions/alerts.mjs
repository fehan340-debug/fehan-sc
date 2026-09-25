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
  try{await storeSetJSON(`telegram-link:${token}`,{email:String(email).toLowerCase(),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60*1000).toISOString()});}catch(e){console.warn('[alerts] telegram link store failed',e.message);return null;}
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
function withTimeout(promise,ms=7000,label='الطلب'){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} تجاوز المهلة.`)),ms);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
async function storeGet(key,fallback=null){
  try{return await withTimeout(getDataStore().get(key,{type:'json'}),5000,'قراءة بيانات التنبيهات');}catch(e){console.warn('[alerts] store get failed',key,e.message);return fallback;}
}
async function storeSetJSON(key,value){
  return await withTimeout(getDataStore().setJSON(key,value),5000,'حفظ بيانات التنبيهات');
}
async function storeDelete(key){
  try{await withTimeout(getDataStore().delete(key),5000,'حذف بيانات التنبيهات');return true;}catch(e){console.warn('[alerts] store delete failed',key,e.message);return false;}
}
function supabaseConfig(){
  return {
    url:String(process.env.SUPABASE_URL||'').trim().replace(/\/+$/,''),
    key:String(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_KEY||'').trim()
  };
}
async function supabaseTable(path,options={}){
  const {url,key}=supabaseConfig();
  if(!url||!key)return {available:false,reason:'not_configured'};
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),7000);
    try{
      const r=await fetch(`${url}/rest/v1/${path}`,{...options,signal:controller.signal,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation',...(options.headers||{})}});
      const text=await r.text(); let data=null; try{data=text?JSON.parse(text):null;}catch{}
      if(!r.ok){
        if([401,403,404,406,42703].includes(r.status))return {available:false,status:r.status,error:text.slice(0,500)};
        return {available:false,status:r.status,error:text.slice(0,500)};
      }
      return {available:true,data};
    }finally{clearTimeout(timer);}
  }catch(e){
    return {available:false,status:0,error:e?.name==='AbortError'?'Supabase timeout':String(e?.message||e)};
  }
}
function alertRowToObject(row){
  return {ticker:cleanTicker(row.ticker),splitDate:String(row.split_date||''),enabled:Boolean(row.enabled),drop:{enabled:Boolean(row.drop_enabled),mode:row.drop_mode==='price'?'price':'percent',value:row.drop_value==null?null:Number(row.drop_value)},short:{enabled:Boolean(row.short_enabled),value:row.short_value==null?null:Number(row.short_value)},rsi:{enabled:Boolean(row.rsi_enabled),value:row.rsi_value==null?null:Number(row.rsi_value),direction:row.rsi_direction==='above'?'above':'below'},updatedAt:row.updated_at||null};
}
function alertObjectToRow(email,a){
  return {user_email:String(email).toLowerCase(),ticker:a.ticker,split_date:a.splitDate||null,enabled:Boolean(a.enabled),drop_enabled:Boolean(a.drop?.enabled),drop_mode:a.drop?.mode==='price'?'price':'percent',drop_value:a.drop?.value==null?null:Number(a.drop.value),short_enabled:Boolean(a.short?.enabled),short_value:a.short?.value==null?null:Number(a.short.value),rsi_enabled:Boolean(a.rsi?.enabled),rsi_value:a.rsi?.value==null?null:Number(a.rsi.value),rsi_direction:a.rsi?.direction==='above'?'above':'below',updated_at:new Date().toISOString()};
}
async function readAlerts(email){
  const mirror=await storeGet(keyFor(email,'settings'),{})||{};
  // The mirror is the fast, user-owned source of truth. This prevents the UI
  // from hanging when the optional Supabase alerts table is slow or blocked by RLS.
  if(Object.keys(mirror).length)return mirror;
  const q=`user_alerts?select=*&user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&order=ticker.asc`;
  const r=await supabaseTable(q);
  if(!r.available)return {};
  const out={};
  for(const row of Array.isArray(r.data)?r.data:[]){const a=alertRowToObject(row);out[a.ticker]=a;}
  if(Object.keys(out).length){try{await storeSetJSON(keyFor(email,'settings'),out);}catch{}}
  return out;
}
async function upsertAlert(email, a) {
    const all = await storeGet(keyFor(email, 'settings'), {}) || {};
    const existing = all[a.ticker] || {};
    all[a.ticker] = {
        ...existing,
        ...a,
        // دمج خصائص التنبيهات لضمان عدم مسح القديم عند إضافة نوع جديد
        drop: a.drop && a.drop.enabled !== undefined 
            ? (a.drop.enabled ? a.drop : null) 
            : existing.drop,
        short: a.short && a.short.enabled !== undefined 
            ? (a.short.enabled ? a.short : null) 
            : existing.short,
        rsi: a.rsi && a.rsi.enabled !== undefined 
            ? (a.rsi.enabled ? a.rsi : null) 
            : existing.rsi,
        enabled: true
    };
    // تنظيف الخصائص الفارغة إذا لزم الأمر
    if (!all[a.ticker].drop?.enabled) delete all[a.ticker].drop;
    if (!all[a.ticker].short?.enabled) delete all[a.ticker].short;
    if (!all[a.ticker].rsi?.enabled) delete all[a.ticker].rsi;
    await storeSetJSON(keyFor(email, 'settings'), all);
    const row = alertObjectToRow(email, a);
    const r = await supabaseTable('user_alerts', { method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify(row) });
    if (!r.available) console.warn('[alerts] user_alerts upsert mirrored; Supabase unavailable', r.status);
    return true;
}
async function deleteAlert(email,ticker){
  const all=await storeGet(keyFor(email,'settings'),{})||{};
  delete all[ticker];
  await storeSetJSON(keyFor(email,'settings'),all);
  const r=await supabaseTable(`user_alerts?user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&ticker=eq.${encodeURIComponent(ticker)}`,{method:'DELETE'});
  if(!r.available)console.warn('[alerts] user_alerts delete mirrored; Supabase unavailable',r.status||'',r.error||'');
  return true;
}

async function consumeAlertType(email,ticker,type){
  const all=await storeGet(keyFor(email,'settings'),{})||{};
  const a=all[ticker];
  if(!a)return false;
  const next={...a};
  if(type==='drop')delete next.drop;
  else if(type==='short')delete next.short;
  else if(type==='rsi')delete next.rsi;
  else return false;
  const stillHas=Boolean(next.drop?.enabled||next.short?.enabled||next.rsi?.enabled);
  if(stillHas){
    all[ticker]={...next,enabled:true};
  }else{
    delete all[ticker];
  }
  await storeSetJSON(keyFor(email,'settings'),all);
  // Mirror the remaining alert configuration in Supabase. This is deliberately
  // best-effort because the Data Store is the fast source of truth for alerts.
  try{
    if(stillHas){
      const normalized=cleanAlert({...next,ticker,enabled:true});
      await supabaseTable(`user_alerts?user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&ticker=eq.${encodeURIComponent(ticker)}`,{method:'DELETE'});
      await supabaseTable('user_alerts',{method:'POST',headers:{'Prefer':'resolution=merge-duplicates'},body:JSON.stringify(alertObjectToRow(email,normalized))});
    }else{
      await supabaseTable(`user_alerts?user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&ticker=eq.${encodeURIComponent(ticker)}`,{method:'DELETE'});
    }
  }catch(e){console.warn('[alerts] triggered alert mirror update failed',e?.message||e);}
  return true;
}

async function appendAlertHistory(email,event){
  const history=await storeGet(keyFor(email,'history'),[])||[];
  const next=[event,...history].slice(0,100);
  await storeSetJSON(keyFor(email,'history'),next);
  const row={user_email:String(email).toLowerCase(),ticker:event.ticker,alert_type:event.type,title:event.title,message:event.message,created_at:event.createdAt||new Date().toISOString(),payload:event};
  const r=await supabaseTable('stock_alerts',{method:'POST',body:JSON.stringify(row)});
  if(!r.available)console.warn('[alerts] stock_alerts mirrored; Supabase unavailable',r.status||'',r.error||'');
  return true;
}

async function readAlertHistory(email){
  const mirror=await storeGet(keyFor(email,'history'),[])||[];
  if(Array.isArray(mirror)&&mirror.length)return mirror;
  const q=`stock_alerts?select=*&user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&order=created_at.desc&limit=100`;
  const r=await supabaseTable(q);
  if(!r.available)return [];
  const rows=(Array.isArray(r.data)?r.data:[]).map(x=>({ticker:x.ticker,type:x.alert_type,title:x.title,message:x.message,createdAt:x.created_at}));
  if(rows.length){try{await storeSetJSON(keyFor(email,'history'),rows);}catch{}}
  return rows;
}

async function deleteAlertHistory(email,event){
  const ticker=cleanTicker(event?.ticker), type=String(event?.type||''), createdAt=String(event?.createdAt||'');
  const history=await storeGet(keyFor(email,'history'),[])||[];
  const idx=Array.isArray(history)?history.findIndex(x=>cleanTicker(x?.ticker)===ticker && String(x?.type||'')===type && String(x?.createdAt||'')===createdAt):-1;
  if(idx<0)throw new Error('التنبيه المطلوب حذفه غير موجود.');
  const next=history.slice(); next.splice(idx,1); await storeSetJSON(keyFor(email,'history'),next);
  const q=`stock_alerts?user_email=eq.${encodeURIComponent(String(email).toLowerCase())}&ticker=eq.${encodeURIComponent(ticker)}&alert_type=eq.${encodeURIComponent(type)}&created_at=eq.${encodeURIComponent(createdAt)}`;
  const r=await supabaseTable(q,{method:'DELETE'}); if(!r.available)console.warn('[alerts] history delete mirror failed',r.status||'',r.error||'');
  return next;
}
export async function evaluateUserAlerts(email,records,usersMap=null){
  const settings=await readAlerts(email);
  const state=await storeGet(keyFor(email,'state'),{})||{};
  const history=await storeGet(keyFor(email,'history'),[])||[];
  const nextState={...state}; let changed=false, fired=[];
  const byTicker=new Map((records||[]).map(x=>[cleanTicker(x?.ticker),x]));
  const users=usersMap||await getUsers();
  const user=users[String(email).toLowerCase()];
  for(const [ticker,a] of Object.entries(settings)){
    if(!a?.enabled)continue;
    const row=byTicker.get(ticker); if(!row)continue;
    // extendedPrice is the single canonical alert price. Never fall back to a
    // closing/current alias here, because that can fire an extended-hours alert
    // against yesterday's close.
    const price=Number(row.extendedPrice), change=Number(row.changePct), short=Number(row.shortShares), rsi=Number(row.rsi);
    const checks=[];
    if(a.drop?.enabled){
      const hit=a.drop.mode==='price'
        ? (Number.isFinite(price)&&price<=Number(a.drop.value))
        : (Number.isFinite(change)&&change<=-Math.abs(Number(a.drop.value)));
      checks.push(['drop',hit,a.drop.mode==='price'?`وصل السعر إلى $${price.toFixed(2)}`:`هبوط ${Math.abs(change).toFixed(2)}%`]);
    }
    if(a.short?.enabled)checks.push(['short',Number.isFinite(short)&&short<=Number(a.short.value),`الشورت ${short.toLocaleString()}`]);
    if(a.rsi?.enabled){
      const v=Number(a.rsi.value),hit=a.rsi.direction==='above'?(Number.isFinite(rsi)&&rsi>=v):(Number.isFinite(rsi)&&rsi<=v);
      checks.push(['rsi',hit,`RSI ${rsi.toFixed(1)}`]);
    }
    for(const [type,hit,detail] of checks){
      const sk=`${ticker}:${type}`; const prev=nextState[sk]||{};
      const was=Boolean(prev.hit);
      if(hit&&!was){
        // A short-lived pending marker prevents overlapping one-minute sweeps
        // from sending the same Telegram alert twice while delivery is in flight.
        if(prev.pending && prev.pendingAt && Date.now()-new Date(prev.pendingAt).getTime()<45000)continue;
        nextState[sk]={...prev,pending:true,pendingAt:new Date().toISOString()};
        changed=true;
        const title=`تنبيه ${ticker}`; const message=`${ticker}: ${detail}`;
        const telegramLinked=Boolean(user?.telegramChatId);
        let delivered=!telegramLinked;
        if(telegramLinked){
          try{
            const result=await sendTelegram(user.telegramChatId,`🔔 ${title}\n${message}`);
            delivered=Boolean(result?.sent);
          }catch(e){
            delivered=false;
            console.warn('Telegram send failed; alert remains active for retry',ticker,type,e.message);
          }
        }
        if(delivered){
          const event={ticker,type,title,message,createdAt:new Date().toISOString(),telegramSent:telegramLinked};
          fired.push(event);
          // The trigger is consumed immediately after confirmed delivery: it is
          // removed from active settings and kept in Triggered Alerts/history.
          await appendAlertHistory(email,event).catch(e=>console.warn('alert history save failed',e.message));
          await consumeAlertType(email,ticker,type).catch(e=>console.warn('alert consume failed',e.message));
          nextState[sk]={hit:true,pending:false,updatedAt:new Date().toISOString()};
        }else{
          nextState[sk]={hit:false,pending:false,updatedAt:new Date().toISOString()};
        }
      }else if(!hit&&was){
        nextState[sk]={hit:false,pending:false,updatedAt:new Date().toISOString()};
        changed=true;
      }else if(!hit&&prev.pending){
        nextState[sk]={hit:false,pending:false,updatedAt:new Date().toISOString()};
        changed=true;
      }
    }
  }
  if(fired.length){
    // appendAlertHistory already persists each event. The fallback below protects
    // against a transient write failure without changing the consume semantics.
    const current=await storeGet(keyFor(email,'history'),[])||[];
    const known=new Set((current||[]).map(x=>`${x?.ticker}:${x?.type}:${x?.createdAt}`));
    const missing=fired.filter(x=>!known.has(`${x.ticker}:${x.type}:${x.createdAt}`));
    if(missing.length)await storeSetJSON(keyFor(email,'history'),[...missing,...current].slice(0,100)).catch(()=>{});
  }
  if(changed)await storeSetJSON(keyFor(email,'state'),nextState).catch(()=>{});
  return {fired};
}
export async function runAlertSweep(){
  const store=getDataStore();
  const lockKey='alerts:sweep-lock';
  const existing=await storeGet(lockKey,null);
  if(existing?.startedAt && Date.now()-new Date(existing.startedAt).getTime()<55000){
    return {ok:true,skipped:true,reason:'already-running'};
  }
  const startedAt=new Date().toISOString();
  await storeSetJSON(lockKey,{startedAt});
  try{
    const users=await getUsers();
    const cache=await readPublishedCache().catch(()=>null);
    const currentRaw=await storeGet('scanner-current-price-v1',{})||{};
    const massiveRaw=await storeGet('scanner-massive-current-v1',{})||{};
    const currentRecords=Array.isArray(currentRaw)?currentRaw:Object.values(currentRaw.records||currentRaw.data||currentRaw);
    const massiveRecords=Array.isArray(massiveRaw)?massiveRaw:Object.values(massiveRaw.records||massiveRaw.data||massiveRaw);
    const cachedRecords=Array.isArray(cache?.records)?cache.records:Object.values(cache?.records||{});
    const liveMap=new Map(currentRecords.map(x=>[cleanTicker(x?.ticker),x]));
    const massiveMap=new Map(massiveRecords.map(x=>[cleanTicker(x?.ticker),x]));
    const cacheMap=new Map(cachedRecords.map(x=>[cleanTicker(x?.ticker),x]));
    const allTickers=Array.from(new Set([...liveMap.keys(),...massiveMap.keys(),...cacheMap.keys()]));
    const records=allTickers.map(t=>{
      const c=liveMap.get(t)||{},m=massiveMap.get(t)||{},base=cacheMap.get(t)||{},ind=m.indicators||base.indicators||{};
      const extendedPrice=Number.isFinite(Number(c.extendedPrice))?Number(c.extendedPrice):
        (Number.isFinite(Number(m.extendedPrice))?Number(m.extendedPrice):
        (Number.isFinite(Number(base.extendedPrice))?Number(base.extendedPrice):null));
      return {...base,...m,...c,ticker:t,
        extendedPrice,
        price:extendedPrice,
        current:extendedPrice,
        currentPrice:extendedPrice,
        changePct:c.changePct??m.changePct??base.changePct??base.changePercent,
        shortShares:c.shortShares??m.shortShares??base.shortShares,
        rsi:Number.isFinite(Number(c.rsi))?Number(c.rsi):(Number.isFinite(Number(m.rsi))?Number(m.rsi):(Number.isFinite(Number(ind.rsi))?Number(ind.rsi):base.rsi))};
    }).filter(x=>Number.isFinite(Number(x.extendedPrice))||Number.isFinite(Number(x.shortShares))||Number.isFinite(Number(x.rsi)));
    if(!records.length)return {ok:true,users:0,fired:0,reason:'no-market-data'};
    let fired=0,usersChecked=0;
    const emails=Object.keys(users);
    let cursor=0;
    const runUser=async()=>{
      while(true){
        const i=cursor++; if(i>=emails.length)return;
        const email=emails[i];
        try{
          const a=await readAlerts(email); if(!Object.keys(a).length)continue;
          usersChecked++;
          const r=await evaluateUserAlerts(email,records,users);
          fired+=r.fired.length;
        }catch(e){
          console.warn('[alerts] user sweep failed; continuing with remaining users',email,e?.message||e);
        }
      }
    };
    await Promise.all(Array.from({length:Math.min(5,emails.length)},runUser));
    return {ok:true,users:usersChecked,fired};
  }finally{
    await storeDelete(lockKey).catch(()=>{});
  }
}
export async function createUserTelegramLink(email){
  const users=await getUsers();
  const user=users[String(email||"").toLowerCase()];
  if(!user)return {linked:false,link:null};
  if(user.telegramChatId){
    await storeSetJSON(`telegram-subscriber:${String(email).toLowerCase()}`,{email:String(email).toLowerCase(),chatId:String(user.telegramChatId),linkedAt:user.telegramLinkedAt||null,admin:Boolean(user.admin)}).catch(()=>{});
    return {linked:true,chatId:String(user.telegramChatId),username:user.telegramUsername||null,link:null};
  }
  return {linked:false,link:await createTelegramLink(email)};
}

export default async function(request){
  try{
    const action=new URL(request.url).searchParams.get('action')||'settings'; const c=await currentUser(request);
    if(!c?.user||c.blocked) return json({error:'غير مصرح. سجّل الدخول.'},401);
    const email=c.user.email;
    if(action==='clear' && request.method==='DELETE'){
      await storeDelete(keyFor(email,'state'));
      return json({ok:true,message:'تمت تصفير حالات التنبيهات القديمة.'});
    }
    if(action==='settings'){
      if(request.method==='GET'){const settings=await readAlerts(email);return json({ok:true,settings,telegram:await createUserTelegramLink(email)});}
      if(request.method==='POST'){const b=await readJson(request);const a=cleanAlert(b);await upsertAlert(email,a);return json({ok:true,settings:await readAlerts(email),telegram:await createUserTelegramLink(email)});}
      if(request.method==='DELETE'){const b=await readJson(request);const ticker=cleanTicker(b.ticker);await deleteAlert(email,ticker);return json({ok:true,settings:await readAlerts(email)});}
    }
    if(action==='history'){if(request.method==='GET')return json({ok:true,items:await readAlertHistory(email)});if(request.method==='DELETE'){const b=await readJson(request);return json({ok:true,items:await deleteAlertHistory(email,b)});}}
    if(action==='telegram-link'){return json({ok:true,telegram:await createUserTelegramLink(email)});}
    if(action==='telegram-test'){
      if(c.user.admin!==true)return json({ok:false,error:'هذا الاختبار متاح للمدير فقط.'},403);
      const users=await getUsers();
      const user=users[String(email).toLowerCase()];
      if(!user?.telegramChatId)return json({ok:false,error:'الحساب غير مربوط بتليجرام.'},400);
      const result=await sendTelegram(user.telegramChatId,'✅ اختبار تنبيهات The Short Scope\nإذا وصلت هذه الرسالة فمسار التنبيهات عبر تليجرام يعمل بشكل صحيح.');
      return json({ok:true,...result});
    }
    return json({error:'إجراء غير مدعوم.'},405);
  }catch(e){return json({error:String(e?.message||e)},500);}
}
