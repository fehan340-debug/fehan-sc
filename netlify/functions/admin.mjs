import crypto from "node:crypto";
import { json,readJson,getUsers,saveUsers,getRequests,saveRequests,makePasswordRecord,safeUser,randomToken,currentUser,cookieMap,getDataStore,getSiteSettings,saveSiteSettings,getSessionStore } from "../../lib.js";
export default async function(request){
  try{
    const c=await currentUser(request); if(!c?.user?.admin)return json({error:"غير مصرح."},403);
    const action=new URL(request.url).searchParams.get("action")||"list";
    const b=await readJson(request); const users=await getUsers();
    if(action==="list") return json({users:Object.values(users).map(safeUser)});
    if(action==="settings") return json({pricing:await getSiteSettings()});
    if(action==="verify-site-settings") {
      const supplied=String(b.adminPassword||""), expected=String(process.env.ADMIN_PASSWORD||"");
      if(!supplied||!expected)return json({error:"كلمة مرور المدير غير مهيأة."},500);
      const a=Buffer.from(supplied),bb=Buffer.from(expected);
      if(a.length!==bb.length||!crypto.timingSafeEqual(a,bb))return json({error:"كلمة مرور المدير غير صحيحة."},403);
      const token=cookieMap(request).scanner_session;
      if(!token)return json({error:"جلسة المدير غير موجودة."},401);
      const session=await getSessionStore().get(`session:${token}`,{type:"json"});
      if(!session)return json({error:"جلسة المدير منتهية."},401);
      session.siteSettingsUnlockedUntil=Date.now()+30*60*1000;
      await getSessionStore().setJSON(`session:${token}`,session);
      return json({ok:true,unlockedUntil:session.siteSettingsUnlockedUntil});
    }
    if(action==="site-settings") {
      const token=cookieMap(request).scanner_session;
      const session=token?await getSessionStore().get(`session:${token}`,{type:"json"}):null;
      if(!session?.siteSettingsUnlockedUntil || Date.now()>Number(session.siteSettingsUnlockedUntil))return json({error:"أدخل كلمة مرور المدير لفتح إعدادات الموقع."},403);
      return json({pricing:await getSiteSettings()});
    }
    if(action==="save-site-settings") {
      const token=cookieMap(request).scanner_session;
      const session=token?await getSessionStore().get(`session:${token}`,{type:"json"}):null;
      if(!session?.siteSettingsUnlockedUntil || Date.now()>Number(session.siteSettingsUnlockedUntil))return json({error:"أدخل كلمة مرور المدير لفتح إعدادات الموقع."},403);
      const current=await getSiteSettings();
      const mode=["normal","maintenance","development"].includes(String(b.siteMode))?String(b.siteMode):current.siteMode;
      const defaultMsg=mode==="maintenance"?"الموقع تحت الصيانة مؤقتًا، الرجاء المحاولة لاحقًا.":mode==="development"?"الموقع تحت التطوير حاليًا، الرجاء المحاولة لاحقًا.":"";
      return json({ok:true,pricing:await saveSiteSettings({
        siteMode:mode,
        siteModeMessage:String(b.siteModeMessage||defaultMsg).trim(),
        autoUpdateEnabled:b.autoUpdateEnabled!==undefined?Boolean(b.autoUpdateEnabled):(b.auto_update_enabled!==undefined?Boolean(b.auto_update_enabled):current.autoUpdateEnabled),
        auto_update_enabled:b.auto_update_enabled!==undefined?Boolean(b.auto_update_enabled):(b.autoUpdateEnabled!==undefined?Boolean(b.autoUpdateEnabled):current.auto_update_enabled),
        subscriptionRequestsEnabled:b.subscriptionRequestsEnabled!==undefined?Boolean(b.subscriptionRequestsEnabled):current.subscriptionRequestsEnabled
      })});
    }
    if(action==="save-settings") {
      const current=await getSiteSettings();
      const plans=Array.isArray(b.plans)?b.plans:current.plans;
      if(!Array.isArray(plans)||!plans.length)return json({error:"يجب وجود باقة واحدة على الأقل."},400);
      for(const p of plans){
        if(!String(p?.label||"").trim())return json({error:"اسم كل باقة مطلوب."},400);
        if(!Number.isFinite(Number(p?.price))||Number(p.price)<0||!Number.isFinite(Number(p?.days))||Number(p.days)<1)return json({error:"بيانات إحدى الباقات غير صحيحة."},400);
      }
      return json({ok:true,pricing:await saveSiteSettings({
        plans,
        monthlyPrice:b.monthlyPrice??current.monthlyPrice,yearlyPrice:b.yearlyPrice??current.yearlyPrice,
        monthlyDays:b.monthlyDays??current.monthlyDays,yearlyDays:b.yearlyDays??current.yearlyDays,
        monthlyLabel:b.monthlyLabel??current.monthlyLabel,yearlyLabel:b.yearlyLabel??current.yearlyLabel,
        bankName:b.bankName??current.bank.name,bankBank:b.bankBank??current.bank.bank,bankAccount:b.bankAccount??current.bank.account,bankIban:b.bankIban??current.bank.iban,telegram:b.telegram??current.telegram,autoUpdateEnabled:b.autoUpdateEnabled??b.auto_update_enabled??current.autoUpdateEnabled,auto_update_enabled:b.auto_update_enabled??b.autoUpdateEnabled??current.auto_update_enabled
      })});
    }
    if(action==="start-hourly-refresh") {
      return json({ok:true,manualEndpoint:"/.netlify/functions/scanner-hourly-refresh-manual",message:"استخدم مسار التحديث اليدوي الخلفي مباشرة من لوحة الأدمن."});
    }
    if(action==="refresh-splits") return json({ok:true,mode:"direct-worker",endpoint:"/.netlify/functions/scanner-splits-worker"});
    if(action==="refresh-float") return json({ok:true,mode:"github-worker",endpoint:"/.netlify/functions/float-worker-manual"});
    if(action==="refresh-borrow") return json({ok:true,mode:"direct-worker",endpoint:"/.netlify/functions/update-short-background"});
    if(action==="refresh-massive-current") return json({ok:true,mode:"direct-worker",endpoint:"/.netlify/functions/scanner-massive-current-worker"});
    if(action==="refresh-massive") return json(await dispatchMassiveWorker({source:'manual-admin-massive'}),202);
    if(action==="site-stats") {
      const site=await getSiteSettings();
      const requestRows=await getRequests();
      const nonAdmin=Object.values(users).filter(u=>!u.admin);
      const now=Date.now();
      const active=nonAdmin.filter(u=>u.status==="active"&&(!u.expiresAt||new Date(u.expiresAt+"T23:59:59").getTime()>=now));
      const expired=nonAdmin.filter(u=>u.expiresAt&&new Date(u.expiresAt+"T23:59:59").getTime()<now);
      const loggedIn=nonAdmin.filter(u=>Boolean(u.firstLoginAt));
      const recentLogins=nonAdmin.filter(u=>u.lastLoginAt && now-new Date(u.lastLoginAt).getTime()<=24*60*60*1000);
      const pending=requestRows.filter(x=>x.status==="pending");
      const approved=requestRows.filter(x=>x.status==="approved");
      const revenue=approved.reduce((a,x)=>a+(Number(x.amount)||0),0);
      const supportPending=requestRows.filter(x=>x.type==="support" && x.status!=="responded");
      const cache=await getDataStore().get("scanner-cache-v1",{type:"json",consistency:"strong"});
      const splitCache=await getDataStore().get("scanner-universe-v2",{type:"json",consistency:"strong"});
      const cacheStatus=await getDataStore().get("scanner-cache-status",{type:"json",consistency:"strong"});
      const borrowPointer=await getDataStore().get("scanner-borrow-pointer-v2",{type:"json",consistency:"strong"});
      const borrowCache=(borrowPointer?.key?await getDataStore().get(borrowPointer.key,{type:"json",consistency:"strong"}):null)||await getDataStore().get("scanner-borrow-v1",{type:"json",consistency:"strong"});
      const borrowStatus=await getDataStore().get("scanner-borrow-status",{type:"json",consistency:"strong"});
      const splitStatus=await getDataStore().get("scanner-universe-status-v2",{type:"json",consistency:"strong"});
      const massiveCurrent=await getDataStore().get("scanner-massive-current-v1",{type:"json",consistency:"strong"});
      const massiveCurrentStatus=await getDataStore().get("scanner-massive-current-status",{type:"json",consistency:"strong"});
      const ipoCache=await getDataStore().get("scanner-ipo-v1",{type:"json",consistency:"strong"});
      const ipoStatus=await getDataStore().get("scanner-ipo-status",{type:"json",consistency:"strong"});
      const hourlyRefresh=await getDataStore().get("scanner-hourly-refresh-v1",{type:"json",consistency:"strong"});
      return json({ok:true,stats:{
        totalCustomers:nonAdmin.length,activeCustomers:active.length,expiredCustomers:expired.length,
        loggedInCustomers:loggedIn.length,notLoggedInCustomers:Math.max(0,nonAdmin.length-loggedIn.length),
        loginsLast24h:recentLogins.length,pendingRequests:pending.length,supportPending:supportPending.length,
        approvedPayments:approved.length,revenue,cacheRecords:Array.isArray(cache?.records)?cache.records.length:0,
        cacheUpdatedAt:cache?.updatedAt||null,cacheBuildStatus:cacheStatus?.state||null,cacheBuildError:cacheStatus?.error||null,cacheExpectedRows:Number(cacheStatus?.expectedRows||cache?.expectedRows||0),cacheMissingRows:Number(cacheStatus?.missingRows||cache?.missingRows||0),cacheMissing:cacheStatus?.missing||cache?.missing||[],
        borrowUpdatedAt:borrowCache?.updatedAt||null,borrowBuildStatus:borrowStatus?.state||null,borrowBuildError:borrowStatus?.error||null,borrowRecords:borrowCache?.records?Object.keys(borrowCache.records).length:0,borrowSuccessful:Number(borrowStatus?.successful||0),borrowFailed:Number(borrowStatus?.failed||0),borrowDone:Number(borrowStatus?.done||0),borrowTotal:Number(borrowStatus?.total||0),borrowRound:Number(borrowStatus?.round||0),borrowCurrentTicker:borrowStatus?.currentTicker||null,borrowCurrentIndex:Number(borrowStatus?.currentIndex||0),borrowAttempts:Number(borrowStatus?.attempts||0),borrowQueuedRetries:Number(borrowStatus?.queuedRetries||0),
        splitBuildStatus:splitStatus?.state||null,splitBuildError:splitStatus?.error||null,splitEvents:splitStatus?.events||0,splitTickers:splitStatus?.tickers||0,splitUpdatedAt:splitStatus?.updatedAt||splitCache?.updatedAt||null,
        massiveCurrentUpdatedAt:massiveCurrent?.updatedAt||null,massiveCurrentStatus:massiveCurrentStatus?.state||null,massiveCurrentError:massiveCurrentStatus?.error||null,massiveCurrentRecords:Number(massiveCurrentStatus?.scannerRecords||0),massiveMarketTickers:Number(massiveCurrentStatus?.marketTickers||0),
        ipoUpdatedAt:ipoCache?.updatedAt||ipoStatus?.updatedAt||null,ipoStatus:ipoStatus?.state||null,ipoRecords:Array.isArray(ipoCache?.records)?ipoCache.records.length:Number(ipoStatus?.records||0),
        hourlyRefreshState:hourlyRefresh?.state||null,hourlyRefreshPhase:hourlyRefresh?.phase||null,hourlyRefreshStartedAt:hourlyRefresh?.startedAt||null,hourlyRefreshFinishedAt:hourlyRefresh?.finishedAt||null,hourlyRefreshUpdatedAt:hourlyRefresh?.updatedAt||null,hourlyRefreshTotalBatches:Number(hourlyRefresh?.totalBatches||0),hourlyRefreshCompletedBatches:Number(hourlyRefresh?.completedBatches||0),hourlyRefreshTotalTickers:Number(hourlyRefresh?.totalTickers||0),hourlyRefreshCompletedTickers:Number(hourlyRefresh?.completedTickers||0),hourlyRefreshError:hourlyRefresh?.error||null,hourlyRefreshFailedTickers:Array.isArray(hourlyRefresh?.failedTickers)?hourlyRefresh.failedTickers.map(x=>typeof x==="string"?x:x?.ticker).filter(Boolean):[],hourlyRefreshSplitWarning:hourlyRefresh?.splitRefreshWarning||null,
        splitsUpdatedAt:cache?.splitsUpdatedAt||splitCache?.updatedAt||null,cacheWindowDays:cache?.windowDays||100,
        siteMode:site.siteMode,siteModeMessage:site.siteModeMessage||"",
        statsUpdatedAt:new Date().toISOString()
      }});
    }
    if(action==="setup-telegram-webhook"){
      const token=String(process.env.TELEGRAM_BOT_TOKEN||"").trim();
      const site=String(process.env.SITE_URL||process.env.URL||"").trim().replace(/\/+$/,'');
      if(!token||!site)return json({error:"ضع TELEGRAM_BOT_TOKEN وSITE_URL في متغيرات البيئة أولاً."},400);
      const webhook=`${site}/.netlify/functions/telegram-webhook`;
      const body={url:webhook}; const secret=String(process.env.TELEGRAM_WEBHOOK_SECRET||"").trim(); if(secret)body.secret_token=secret;
      const r=await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const d=await r.json().catch(()=>({})); if(!r.ok||d?.ok!==true)return json({error:d?.description||`Telegram HTTP ${r.status}`},502);
      return json({ok:true,webhook});
    }
    if(action==="requests") return json({requests:await getRequests()});
    if(action==="reply-support"){
      const id=String(b.id||""), message=String(b.message||"").trim();
      if(!id||!message)return json({error:"اكتب الرد أولاً."},400);
      const reqs=await getRequests(); const req=reqs.find(x=>x.id===id&&x.type==="support");
      if(!req)return json({error:"رسالة العميل غير موجودة."},404);
      req.reply=message; req.repliedAt=new Date().toISOString(); req.status="responded"; req.supportReadAt=null;
      await saveRequests(reqs); return json({ok:true});
    }
    if(action==="create"){
      const email=String(b.email||"").trim().toLowerCase(),password=String(b.password||"");
      if(!email||password.length<6)return json({error:"الإيميل وكلمة المرور (6 أحرف على الأقل) مطلوبة."},400);
      const pricing=await getSiteSettings(); const plan=pricing.plans.find(p=>p.id===String(b.plan||"")); if(!plan)return json({error:"الباقة غير موجودة."},400);
      const requestedDays=Number(b.days); const days=Number.isFinite(requestedDays)&&requestedDays>0?Math.floor(requestedDays):plan.days; const expires=new Date(Date.now()+days*86400000).toISOString().slice(0,10);
      const now=new Date().toISOString(); users[email]={email,admin:false,status:"active",plan:String(b.plan),subscriptionStartedAt:now.slice(0,10),expiresAt:expires,deviceId:null,password:makePasswordRecord(password),createdAt:now,firstLoginAt:null,lastLoginAt:null};
      await saveUsers(users); return json({ok:true,user:safeUser(users[email])});
    }
    if(action==="disable"){
      const email=String(b.email||"").trim().toLowerCase();if(!users[email])return json({error:"العميل غير موجود"},404);
      users[email].status="disabled";await saveUsers(users);return json({ok:true});
    }
    if(action==="enable"){
      const email=String(b.email||"").trim().toLowerCase();if(!users[email])return json({error:"العميل غير موجود"},404);
      users[email].status="active";if(!users[email].expiresAt||Date.now()>new Date(users[email].expiresAt).getTime()){const now=new Date();users[email].expiresAt=new Date(Date.now()+30*86400000).toISOString().slice(0,10);users[email].subscriptionStartedAt=now.toISOString().slice(0,10);}
      await saveUsers(users);return json({ok:true});
    }
    if(action==="extend"){
      const email=String(b.email||"").trim().toLowerCase();if(!users[email])return json({error:"العميل غير موجود"},404);
      const target=String(b.expiresAt||"").trim();
      let expiry;
      if(target){ if(!/^\d{4}-\d{2}-\d{2}$/.test(target))return json({error:"تاريخ الانتهاء غير صحيح."},400); expiry=new Date(target+"T23:59:59"); if(Number.isNaN(expiry.getTime()))return json({error:"تاريخ الانتهاء غير صحيح."},400); }
      else { const days=Math.max(1,Number(b.days)||30); const base=users[email].expiresAt&&Date.now()<new Date(users[email].expiresAt).getTime()?new Date(users[email].expiresAt):new Date(); expiry=new Date(base.getTime()+days*86400000); }
      users[email].expiresAt=expiry.toISOString().slice(0,10);users[email].status="active";await saveUsers(users);return json({ok:true,expiresAt:users[email].expiresAt});
    }
    if(action==="reset-device"){
      const email=String(b.email||"").trim().toLowerCase();if(!users[email])return json({error:"العميل غير موجود"},404);
      users[email].deviceId=null;await saveUsers(users);return json({ok:true,deviceId:null,email});
    }
    if(action==="delete"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!email||!users[email])return json({error:"العميل غير موجود"},404);
      if(users[email].admin===true)return json({error:"لا يمكن حذف حساب المدير."},400);
      const supplied=String(b.adminCode||""), expected=String(process.env.ADMIN_PASSWORD||"");
      if(!supplied||!expected)return json({error:"رمز دخول المدير غير مهيأ."},500);
      const a=Buffer.from(supplied),bb=Buffer.from(expected);
      if(a.length!==bb.length||!crypto.timingSafeEqual(a,bb))return json({error:"رمز دخول المدير غير صحيح."},403);
      delete users[email];
      await saveUsers(users);
      return json({ok:true});
    }
    if(action==="approve"){
      const id=String(b.id||""),reqs=await getRequests(),req=reqs.find(x=>x.id===id);if(!req)return json({error:"الطلب غير موجود"},404);
      const email=String(b.email||req.contact||"").trim().toLowerCase(); let password=String(b.password||"");
      if(!email)return json({error:"أدخل إيميل العميل."},400); if(!password)password=randomToken().slice(0,10);
      const pricing=await getSiteSettings(); const selectedPlan=pricing.plans.find(p=>p.id===String(req.plan||"")); if(!selectedPlan)return json({error:"الباقة المطلوبة لم تعد موجودة."},400); const days=selectedPlan.days;
      const now=new Date().toISOString();
      if(req.type==="renewal" && users[email]){
        const base=users[email].expiresAt&&Date.now()<new Date(users[email].expiresAt+"T23:59:59").getTime()?new Date(users[email].expiresAt+"T23:59:59"):new Date();
        users[email].expiresAt=new Date(base.getTime()+days*86400000).toISOString().slice(0,10);users[email].status="active";users[email].plan=req.plan;
      } else {
        users[email]={email,admin:false,status:"active",plan:req.plan,subscriptionStartedAt:now.slice(0,10),expiresAt:new Date(Date.now()+days*86400000).toISOString().slice(0,10),deviceId:null,password:makePasswordRecord(password),createdAt:now};
      }
      await saveUsers(users);req.status="approved";req.approvedAt=new Date().toISOString();req.accountEmail=email;req.generatedPassword=password;await saveRequests(reqs);
      return json({ok:true,email,password,expiresAt:users[email].expiresAt});
    }
    return json({error:"action غير معروف"},400);
  }catch(err){console.error("admin function error",err);return json({error:`خطأ في لوحة الإدارة: ${String(err?.message||err)}`},500);}
}
