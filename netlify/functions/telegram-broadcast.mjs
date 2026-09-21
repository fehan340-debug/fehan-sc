import { currentUser, getUsers, json, readJson } from '../../lib.js';
function env(name){return String(process.env[name]||'').trim();}
async function sendTelegram(chatId,text){
  const token=env('TELEGRAM_BOT_TOKEN');
  if(!token)throw new Error('TELEGRAM_BOT_TOKEN غير مهيأ.');
  const r=await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d?.ok!==true)throw new Error(d?.description||`Telegram HTTP ${r.status}`);
  return d;
}
export default async function(request){
  try{
    const auth=await currentUser(request);
    if(!auth?.user?.admin||auth.blocked)return json({error:'غير مصرح.'},403);
    if(request.method!=='POST')return json({error:'طريقة الطلب غير مدعومة.'},405);
    const body=await readJson(request);const message=String(body?.message||'').trim();
    if(!message)return json({error:'اكتب الرسالة أولاً.'},400);
    const users=await getUsers();
    const recipients=Object.values(users).filter(u=>u&&u.telegramChatId&&(u.admin || u.status==='active'));
    let sent=0,failed=0;const failures=[];
    for(const u of recipients){
      try{await sendTelegram(u.telegramChatId,message);sent++;}
      catch(e){failed++;failures.push({email:u.email,error:String(e?.message||e)});}
    }
    return json({ok:true,total:recipients.length,sent,failed,failures:failures.slice(0,20)});
  }catch(e){return json({error:String(e?.message||e)},500);}
}
