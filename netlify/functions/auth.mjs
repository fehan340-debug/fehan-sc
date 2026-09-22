import { json,readJson,cookieMap,setSessionCookie,setDeviceCookie,clearSessionCookie,randomToken,getUsers,verifyPassword,saveUsers,currentUser,safeUser,deviceCandidatesFrom,deviceFingerprintFrom,ensureAdmin,getSiteSettings,getFavorites,saveFavorites,getUserSettingsStore,getSessionStore } from "../../lib.js";
export default async function(request){
  try{
    await ensureAdmin();
    const action=new URL(request.url).searchParams.get("action")||"me";
    if(action==="pricing"){ return json({ok:true,pricing:await getSiteSettings()}); }
    if(action==="health"){
      const users=await getUsers(); const email=(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
      return json({ok:true,environment:Boolean(email&&process.env.ADMIN_PASSWORD),adminCreated:Boolean(email&&users[email]),supabase:true});
    }
    if(action==="scanner-settings") {
      const c=await currentUser(request);
      if(c?.maintenance) return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
      if(!c || c.blocked) return json({error:"غير مصرح. سجّل الدخول."},401);
      const key=`scanner-settings:${String(c.user.email||"").toLowerCase()}`;
      if(request.method==="GET") {
        const settings=await getUserSettingsStore().get(key,{type:"json"}) || null;
        return json({ok:true,settings});
      }
      if(request.method==="POST") {
        const b=await readJson(request);
        const clean={
          days:Math.max(1,Math.min(100,Math.floor(Number(b.days)||60))),
          maxPrice:Math.max(0,Number(b.maxPrice)||10),
          drop:Math.max(0,Math.min(100,Number(b.drop)||0)),
          rsiMax:Math.max(0,Math.min(100,Number(b.rsiMax)||30)),
          shortMax:String(b.shortMax??"").trim()
        };
        await getUserSettingsStore().setJSON(key,clean);
        return json({ok:true,settings:clean});
      }
      return json({error:"طريقة الطلب غير مدعومة."},405);
    }
    if(action==="favorites") {
      const c=await currentUser(request);
      if(c?.maintenance) return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
      if(!c || c.blocked) return json({error:"غير مصرح. سجّل الدخول."},401);
      const email=c.user.email;
      if(request.method==="GET") return json({ok:true,favorites:await getFavorites(email)});
      if(request.method==="POST") {
        const b=await readJson(request);
        if(Array.isArray(b.items)){
          const clean=b.items.slice(0,10000).map(x=>({ticker:String(x.ticker||"").trim().toUpperCase(),splitDate:String(x.splitDate||"").trim(),splitOpen:Number.isFinite(Number(x.splitOpen))?Number(x.splitOpen):null,addedAt:x.addedAt||new Date().toISOString()})).filter(x=>/^[A-Z0-9.\-]{1,15}$/.test(x.ticker));
          await saveFavorites(email,clean); return json({ok:true,favorites:clean});
        }
        const ticker=String(b.ticker||"").trim().toUpperCase();
        const splitDate=String(b.splitDate||"").trim();
        if(!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return json({error:"رمز السهم غير صالح."},400);
        const current=await getFavorites(email);
        const exists=current.some(x=>x.ticker===ticker && x.splitDate===splitDate);
        if(exists) return json({ok:true,favorites:current});
        const item={ticker,splitDate,splitOpen:Number.isFinite(Number(b.splitOpen))?Number(b.splitOpen):null,addedAt:new Date().toISOString()};
        const next=[item,...current.filter(x=>x.ticker!==ticker || x.splitDate!==splitDate)];
        await saveFavorites(email,next);
        return json({ok:true,favorites:next});
      }
      if(request.method==="DELETE") {
        const b=await readJson(request);
        const ticker=String(b.ticker||"").trim().toUpperCase(), splitDate=String(b.splitDate||"").trim();
        const next=(await getFavorites(email)).filter(x=>!(x.ticker===ticker && x.splitDate===splitDate));
        await saveFavorites(email,next);
        return json({ok:true,favorites:next});
      }
      return json({error:"طريقة الطلب غير مدعومة."},405);
    }
    if(action==="me"){
      const c=await currentUser(request);
      if(!c) {
        const site=await getSiteSettings();
        return json({authenticated:false,maintenance:site.siteMode!=="normal",mode:site.siteMode,message:site.siteModeMessage||""});
      }
      if(c.maintenance) return json({authenticated:false,maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||""});
      if(c.blocked) return json({authenticated:false});
      return json({authenticated:true,user:safeUser(c.user)});
    }
    if(action==="login"){
      const b=await readJson(request), username=String(b.username||"").trim().toLowerCase(), password=String(b.password||"");
      const users=await getUsers(),u=users[username];
      if(!u || u.status!=="active" || !u.password || !verifyPassword(password,u.password)) return json({error:"بيانات الدخول غير صحيحة."},401);
      if(u.expiresAt && Date.now()>new Date(u.expiresAt).getTime()) return json({error:"انتهى اشتراكك."},403);
      const isAdmin=u.admin===true || username===(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
      const site=await getSiteSettings();
      if(!isAdmin && site.siteMode!=="normal") return json({maintenance:true,mode:site.siteMode,message:site.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
      const devs=deviceCandidatesFrom(request);
      const fingerprint=deviceFingerprintFrom(request);
      if(!isAdmin){
        // Device lock is preserved, but the lock is now physical-device based rather
        // than browser-storage based. Safari, Chrome and Google Chrome on the same
        // phone/computer therefore share the same device fingerprint.
        if(!u.deviceId && devs.length) u.deviceId=devs[0];
        if(!u.deviceFingerprint && fingerprint) u.deviceFingerprint=fingerprint;
        if((u.deviceId || u.deviceFingerprint) && devs.length){
          const idMatch=devs.includes(String(u.deviceId||""));
          const fingerprintMatch=Boolean(fingerprint && u.deviceFingerprint && fingerprint===String(u.deviceFingerprint));
          if(!idMatch && !fingerprintMatch) return json({error:"هذا الحساب مرتبط بجهاز آخر."},403);
        }
        if((u.deviceId || u.deviceFingerprint) && !devs.length && !fingerprint) return json({error:"تعذر التحقق من الجهاز. حدّث الصفحة وحاول مرة أخرى."},403);
      }
      const now=new Date().toISOString();
      // Mark the account as having completed at least one successful login.
      // This is persistent and is used by the admin customer panel as the green/red indicator.
      u.firstLoginAt=u.firstLoginAt||now;
      u.lastLoginAt=now;
      users[username]=u;
      await saveUsers(users);
      const token=randomToken();
      await getSessionStore().setJSON(`session:${token}`,{email:username,deviceId:u.deviceId||null,createdAt:now,expiresAt:new Date(Date.now()+2592000000).toISOString()});
      const cookieHeaders=[setSessionCookie(token)];
      if(!isAdmin && u.deviceId) cookieHeaders.push(setDeviceCookie(u.deviceId));
      return json({ok:true,user:safeUser(u),deviceId:u.deviceId||null},200,{"set-cookie":cookieHeaders});
    }
    if(action==="logout"){
      const t=cookieMap(request).scanner_session;if(t) await getSessionStore().delete(`session:${t}`);
      return json({ok:true},200,{"set-cookie":clearSessionCookie()});
    }
    return json({error:"action غير معروف"},400);
  }catch(err){
    console.error("auth function error",err);
    return json({error:`خطأ في خدمة الحسابات: ${String(err?.message||err)}`},500);
  }
}
