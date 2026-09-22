import crypto from "node:crypto";

// Supabase is the single persistent data store for the application.
// Netlify Blobs is intentionally not used anywhere in the project.
const SUPABASE_URL=()=>String(process.env.SUPABASE_URL||"").trim().replace(/\/+$/,"").replace(/\/rest\/v1$/i,"");
const SUPABASE_KEY=()=>String(process.env.SUPABASE_KEY||"").trim();
const TABLES={
  scanner:String(process.env.SUPABASE_SCANNER_TABLE||process.env.SUPABASE_TABLE||"scanner_worker_store").trim(),
  users:String(process.env.SUPABASE_USERS_TABLE||"app_users_store").trim(),
  sessions:String(process.env.SUPABASE_SESSIONS_TABLE||"app_sessions_store").trim(),
  requests:String(process.env.SUPABASE_REQUESTS_TABLE||"app_requests_store").trim(),
  favorites:String(process.env.SUPABASE_FAVORITES_TABLE||"app_favorites_store").trim(),
  userSettings:String(process.env.SUPABASE_USER_SETTINGS_TABLE||"app_user_settings_store").trim(),
  siteSettings:String(process.env.SUPABASE_SITE_SETTINGS_TABLE||"app_site_settings_store").trim(),
  attachments:String(process.env.SUPABASE_ATTACHMENTS_TABLE||"app_attachments_store").trim()
};

function requireSupabase(){
  const url=SUPABASE_URL(), key=SUPABASE_KEY();
  if(!url||!key) throw new Error("SUPABASE_URL و SUPABASE_KEY غير مهيئين في Netlify.");
  return {url,key};
}
function enc(v){return encodeURIComponent(String(v));}
async function supabaseRequest(path,options={}){
  const {url,key}=requireSupabase();
  const r=await fetch(`${url}/rest/v1/${path}`,{
    ...options,
    headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json",...(options.headers||{})}
  });
  const body=await r.text();
  if(!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${body.slice(0,1000)}`);
  if(!body) return null;
  try{return JSON.parse(body);}catch{return body;}
}

function makeStore(table){
  const safe=String(table||"").trim();
  if(!safe) throw new Error("اسم جدول Supabase غير صالح.");
  const path=encodeURIComponent(safe);
  return {
    async get(key,options={}){
      const rows=await supabaseRequest(`${path}?select=value&key=eq.${enc(key)}&limit=1`);
      const raw=rows?.[0]?.value;
      if(raw==null)return null;
      if(options.type==="arrayBuffer"){
        if(raw?.__scanner_binary_base64){const b=Buffer.from(String(raw.__scanner_binary_base64),"base64");return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}
        return null;
      }
      if(options.type==="text") return typeof raw==="string"?raw:JSON.stringify(raw);
      return raw;
    },
    async setJSON(key,value){
      await supabaseRequest(path,{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({key:String(key),value})});
      return value;
    },
    async set(key,value){
      let stored=value;
      if(value instanceof ArrayBuffer) stored={__scanner_binary_base64:Buffer.from(value).toString("base64")};
      else if(ArrayBuffer.isView(value)) stored={__scanner_binary_base64:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString("base64")};
      else if(Buffer.isBuffer(value)) stored={__scanner_binary_base64:value.toString("base64")};
      await supabaseRequest(path,{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({key:String(key),value:stored})});
      return value;
    },
    async delete(key){await supabaseRequest(`${path}?key=eq.${enc(key)}`,{method:"DELETE"});}
  };
}
export const getDataStore=()=>makeStore(TABLES.scanner);
export const getUserStore=()=>makeStore(TABLES.users);
export const getSessionStore=()=>makeStore(TABLES.sessions);
export const getRequestStore=()=>makeStore(TABLES.requests);
export const getFavoriteStore=()=>makeStore(TABLES.favorites);
export const getUserSettingsStore=()=>makeStore(TABLES.userSettings);
export const getSiteSettingsStore=()=>makeStore(TABLES.siteSettings);
export const getAttachmentStore=()=>makeStore(TABLES.attachments);

export function json(data,status=200,extra={}) {
  const headers = new Headers({"content-type":"application/json; charset=utf-8", "cache-control":"no-store"});
  for(const [k,v] of Object.entries(extra||{})){
    if(k.toLowerCase()==="set-cookie" && Array.isArray(v)){ for(const item of v) headers.append("set-cookie",String(item)); }
    else headers.set(k,String(v));
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export async function readJson(request){
  try { return await request.json(); } catch { return {}; }
}

export function cookieMap(request){
  const c = request.headers.get("cookie") || "";
  const out = {};
  for (const part of c.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0,i).trim();
    const v = part.slice(i+1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
export function setSessionCookie(token){
  return `scanner_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}
export function clearSessionCookie(){ return "scanner_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }

function hashPassword(password,salt){ return crypto.scryptSync(password,salt,32).toString("hex"); }
export function verifyPassword(password, stored){
  if(!stored?.salt||!stored?.hash) return false;
  const h=hashPassword(password,stored.salt);
  const a=Buffer.from(h,"hex"), b=Buffer.from(stored.hash,"hex");
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
export function makePasswordRecord(password){
  const salt=crypto.randomBytes(16).toString("hex");
  return {salt,hash:hashPassword(password,salt)};
}
export function randomToken(){return crypto.randomBytes(32).toString("hex");}

export function deviceFrom(request){
  const header=String(request.headers.get("x-device-id")||"").trim();
  if(header)return header;
  const c=cookieMap(request);
  return String(c.scanner_device_id||"").trim();
}
export function deviceCandidatesFrom(request){
  const out=[];
  const h=String(request.headers.get("x-device-id")||"").trim();
  const c=String(cookieMap(request).scanner_device_id||"").trim();
  for(const v of [h,c]) if(v && !out.includes(v)) out.push(v);
  return out;
}
export function deviceFingerprintFrom(request){
  return String(request.headers.get("x-device-fingerprint")||"").trim();
}
export function setDeviceCookie(deviceId){
  return `scanner_device_id=${encodeURIComponent(String(deviceId||""))}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`;
}

export async function getUsers(){ return await getUserStore().get("users",{type:"json"}) || {}; }
export async function saveUsers(u){ await getUserStore().setJSON("users",u); }
export async function getRequests(){ return await getRequestStore().get("requests",{type:"json"}) || []; }
export async function saveRequests(r){ await getRequestStore().setJSON("requests",r); }
export async function getFavorites(email){ return await getFavoriteStore().get(`favorites:${String(email||"").toLowerCase()}`,{type:"json"}) || []; }
export async function saveFavorites(email,items){ await getFavoriteStore().setJSON(`favorites:${String(email||"").toLowerCase()}`,items); }

export async function getSiteSettings(){
  const d=await getSiteSettingsStore().get("site-settings",{type:"json"});
  const legacy=[
    {id:"monthly",label:String(d?.monthlyLabel||"شهري"),price:Number.isFinite(Number(d?.monthlyPrice))?Number(d.monthlyPrice):59,days:Number.isFinite(Number(d?.monthlyDays))?Math.max(1,Number(d.monthlyDays)):30},
    {id:"yearly",label:String(d?.yearlyLabel||"سنوي"),price:Number.isFinite(Number(d?.yearlyPrice))?Number(d.yearlyPrice):499,days:Number.isFinite(Number(d?.yearlyDays))?Math.max(1,Number(d.yearlyDays)):365}
  ];
  const plans=Array.isArray(d?.plans)&&d.plans.length?d.plans.map((p,i)=>({
    id:String(p?.id||`plan-${i+1}`).trim(),
    label:String(p?.label||`باقة ${i+1}`).trim(),
    price:Math.max(0,Number(p?.price)||0),
    days:Math.max(1,Number(p?.days)||1)
  })).filter(p=>p.id&&p.label):legacy;
  const monthly=plans.find(p=>p.id==="monthly")||legacy[0], yearly=plans.find(p=>p.id==="yearly")||legacy[1];
  return {
    plans, monthlyPrice:monthly.price, yearlyPrice:yearly.price,
    monthlyDays:monthly.days, yearlyDays:yearly.days,
    monthlyLabel:monthly.label, yearlyLabel:yearly.label,
    telegram:String(d?.telegram||""),
    bank:{name:String(d?.bank?.name||""),bank:String(d?.bank?.bank||""),account:String(d?.bank?.account||""),iban:String(d?.bank?.iban||"")},
    siteMode:["normal","maintenance","development"].includes(String(d?.siteMode))?String(d.siteMode):"normal",
    siteModeMessage:String(d?.siteModeMessage||""),
    autoUpdateEnabled:(d?.auto_update_enabled!==undefined ? Boolean(d.auto_update_enabled) : d?.autoUpdateEnabled!==false),
    auto_update_enabled:(d?.auto_update_enabled!==undefined ? Boolean(d.auto_update_enabled) : d?.autoUpdateEnabled!==false),
    subscriptionRequestsEnabled:d?.subscriptionRequestsEnabled!==false
  };
}
export async function saveSiteSettings(s){
  const old=await getSiteSettings();
  const rawPlans=Array.isArray(s?.plans)?s.plans:old.plans;
  const plans=rawPlans.map((p,i)=>({
    id:String(p?.id||`plan-${Date.now()}-${i}`).trim().replace(/[^a-zA-Z0-9_-]/g,"-"),
    label:String(p?.label||`باقة ${i+1}`).trim()||`باقة ${i+1}`,
    price:Math.max(0,Number(p?.price)||0),
    days:Math.max(1,Number(p?.days)||1)
  })).filter((p,i,a)=>p.id&&a.findIndex(x=>x.id===p.id)===i);
  const monthly=plans.find(p=>p.id==="monthly")||old.plans.find(p=>p.id==="monthly")||{id:"monthly",label:"شهري",price:59,days:30};
  const yearly=plans.find(p=>p.id==="yearly")||old.plans.find(p=>p.id==="yearly")||{id:"yearly",label:"سنوي",price:499,days:365};
  const out={
    plans,monthlyPrice:monthly.price,yearlyPrice:yearly.price,monthlyDays:monthly.days,yearlyDays:yearly.days,
    monthlyLabel:monthly.label,yearlyLabel:yearly.label,
    telegram:String(s?.telegram ?? old.telegram ?? "").trim(),
    bank:{name:String(s?.bankName ?? old.bank?.name ?? "").trim(),bank:String(s?.bankBank ?? old.bank?.bank ?? "").trim(),account:String(s?.bankAccount ?? old.bank?.account ?? "").trim(),iban:String(s?.bankIban ?? old.bank?.iban ?? "").trim()},
    siteMode:["normal","maintenance","development"].includes(String(s?.siteMode ?? old.siteMode))?String(s?.siteMode ?? old.siteMode):"normal",
    siteModeMessage:String(s?.siteModeMessage ?? old.siteModeMessage ?? "").trim(),
    autoUpdateEnabled:s?.autoUpdateEnabled!==undefined ? Boolean(s.autoUpdateEnabled) : (s?.auto_update_enabled!==undefined ? Boolean(s.auto_update_enabled) : Boolean(old.autoUpdateEnabled)),
    auto_update_enabled:s?.auto_update_enabled!==undefined ? Boolean(s.auto_update_enabled) : (s?.autoUpdateEnabled!==undefined ? Boolean(s.autoUpdateEnabled) : Boolean(old.auto_update_enabled ?? old.autoUpdateEnabled)),
    subscriptionRequestsEnabled:s?.subscriptionRequestsEnabled!==undefined ? Boolean(s.subscriptionRequestsEnabled) : Boolean(old.subscriptionRequestsEnabled),
    updatedAt:new Date().toISOString()
  };
  await getSiteSettingsStore().setJSON("site-settings",out);
  return out;
}

export async function currentUser(request){
  const token=cookieMap(request).scanner_session;
  if(!token) return null;
  const s=await getSessionStore().get(`session:${token}`,{type:"json"});
  if(!s || !s.email || (s.expiresAt && Date.now()>new Date(s.expiresAt).getTime())) return null;
  const users=await getUsers(), u=users[s.email];
  if(!u || u.status!=="active") return null;
  const isAdmin=u.admin===true || s.email===(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
  const devs=deviceCandidatesFrom(request);
  const fingerprint=deviceFingerprintFrom(request);
  if(!isAdmin){
    if(!u.deviceId && devs.length){u.deviceId=devs[0];}
    if(!u.deviceFingerprint && fingerprint){u.deviceFingerprint=fingerprint;}
    if((u.deviceId || u.deviceFingerprint) && devs.length){
      const idMatch=devs.includes(String(u.deviceId||""));
      const fingerprintMatch=Boolean(fingerprint && u.deviceFingerprint && fingerprint===String(u.deviceFingerprint));
      if(!idMatch && !fingerprintMatch) return {blocked:true,user:u};
    }
    if((u.deviceId || u.deviceFingerprint) && !devs.length && !fingerprint) return {blocked:true,user:u};
    users[s.email]=u;
    await saveUsers(users);
  }
  if(u.expiresAt && Date.now()>new Date(u.expiresAt).getTime()) return null;
  if(!isAdmin){
    const site=await getSiteSettings();
    if(site.siteMode!=="normal") return {maintenance:true,user:u,token,siteMode:site.siteMode,siteModeMessage:site.siteModeMessage};
  }
  return {user:u,token};
}
export function safeUser(u){let x={...u};delete x.password;return x;}
export async function requireUser(request){
  const c=await currentUser(request);
  if(!c) return json({error:"غير مصرح. سجّل الدخول."},401);
  if(c.maintenance) return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
  if(c.blocked) return json({error:"هذا الحساب مرتبط بجهاز آخر."},403);
  return c;
}
export async function ensureAdmin(){
  const users=await getUsers();
  const email=(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
  const pass=process.env.ADMIN_PASSWORD||"";
  if(email && pass && !users[email]){
    users[email]={email,admin:true,status:"active",plan:"admin",expiresAt:"2099-12-31",deviceId:null,password:makePasswordRecord(pass),createdAt:new Date().toISOString()};
    await saveUsers(users);
  }
  return users;
}
