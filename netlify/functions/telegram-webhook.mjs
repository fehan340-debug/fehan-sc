import { getDataStore, getUsers, saveUsers } from '../../lib.js';

function env(name){return String(process.env[name]||'').trim();}
async function sendTelegram(chatId,text){
  const token=env('TELEGRAM_BOT_TOKEN');
  if(!token)throw new Error('TELEGRAM_BOT_TOKEN غير مهيأ.');
  let last='Telegram send failed';
  for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
    try{
      const r=await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true}),signal:controller.signal});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d?.ok===true)return d;
      last=d?.description||`Telegram HTTP ${r.status}`;
      if(![429,500,502,503,504].includes(r.status))break;
    }catch(e){last=e?.name==='AbortError'?'Telegram request timed out':String(e?.message||e);}
    finally{clearTimeout(timer);}
    if(attempt<2)await new Promise(r=>setTimeout(r,500*(attempt+1)));
  }
  throw new Error(last);
}

export default async function(request){
  try{
    if(request.method!=='POST')return new Response('ok',{status:200});
    const secret=env('TELEGRAM_WEBHOOK_SECRET');
    if(secret && request.headers.get('x-telegram-bot-api-secret-token')!==secret)return new Response('forbidden',{status:403});
    const update=await request.json().catch(()=>({}));
    const msg=update?.message;
    const chat=msg?.chat;
    const text=String(msg?.text||'').trim();
    if(!chat?.id)return new Response('ok',{status:200});
    if(/^\/start(?:@\w+)?(?:\s+(.+))?$/i.test(text)){
      const token=text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i)?.[1]?.trim();
      if(!token){await sendTelegram(chat.id,'مرحبًا بك في The Short Scope. افتح رابط الربط من داخل حسابك في الموقع لإكمال ربط التنبيهات.');return new Response('ok');}
      const link=await getDataStore().get(`telegram-link:${token}`,{type:'json'}).catch(()=>null);
      if(!link?.email || !link.expiresAt || Date.now()>new Date(link.expiresAt).getTime()){
        await sendTelegram(chat.id,'رابط الربط منتهي أو غير صالح. ارجع للموقع واضغط «ربط التنبيهات عبر تليجرام» للحصول على رابط جديد.');
        return new Response('ok');
      }
      const users=await getUsers();
      const email=String(link.email).toLowerCase();
      if(!users[email]){await sendTelegram(chat.id,'تعذر العثور على حسابك في الموقع.');return new Response('ok');}
      users[email]={...users[email],telegramChatId:String(chat.id),telegramUsername:chat.from?.username||null,telegramFirstName:chat.from?.first_name||null,telegramLinkedAt:new Date().toISOString()};
      await saveUsers(users);
      await getDataStore().setJSON(`telegram-subscriber:${email}`,{email,chatId:String(chat.id),linkedAt:new Date().toISOString(),admin:Boolean(users[email]?.admin)}).catch(()=>{});
      await getDataStore().delete(`telegram-link:${token}`).catch(()=>{});
      await sendTelegram(chat.id,'تم ربط حسابك في The Short Scope بتليجرام بنجاح. ستصلك تنبيهات الأسهم هنا عند تحقق الشروط.');
    }
    return new Response('ok',{status:200});
  }catch(e){console.error('telegram webhook',e);return new Response('ok',{status:200});}
}
