import { getSiteSettings } from '../../lib.js';
import { runMassiveCurrentUpdate } from './scanner-massive-current-worker.mjs';
export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const weekday=parts.find(x=>x.type==='weekday')?.value||'';
  const hour=Number(parts.find(x=>x.type==='hour')?.value||0);
  if(['Sat','Sun'].includes(weekday)||hour<4||hour>=20)return new Response('outside automatic current-price window',{status:200});
  try{const result=await runMassiveCurrentUpdate();return new Response(JSON.stringify({ok:true,...result}),{status:202,headers:{'content-type':'application/json','cache-control':'no-store'}});}
  catch(e){return new Response(String(e?.message||e),{status:500});}
}
// Live Massive prices are refreshed by the 5-minute scanner schedule.
// This endpoint remains available for manual/admin invocation.

