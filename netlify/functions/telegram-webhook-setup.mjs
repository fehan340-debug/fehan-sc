import { currentUser, json } from '../../lib.js';
function env(name){return String(process.env[name]||'').trim().replace(/\/+$/,'');}
export default async function(request){
  try{
    const auth=await currentUser(request);
    if(!auth?.user?.admin||auth.blocked)return json({error:'غير مصرح.'},403);
    const token=env('TELEGRAM_BOT_TOKEN');
    const site=env('SITE_URL')||env('URL');
    if(!token||!site)return json({error:'ضع TELEGRAM_BOT_TOKEN وSITE_URL في متغيرات البيئة أولاً.'},400);
    const webhook=`${site}/.netlify/functions/telegram-webhook`;
    const body={url:webhook};
    const secret=String(process.env.TELEGRAM_WEBHOOK_SECRET||'').trim();
    if(secret)body.secret_token=secret;
    const r=await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d?.ok!==true)return json({error:d?.description||`Telegram HTTP ${r.status}`},502);
    return json({ok:true,webhook});
  }catch(e){return json({error:String(e?.message||e)},500);}
}
