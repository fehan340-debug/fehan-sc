import { getSiteSettings } from '../../lib.js';
import { runMassiveCurrentUpdate } from './scanner-massive-current-worker.mjs';
import { marketSession } from '../../market-calendar.mjs';
export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const now=new Date(), session=marketSession(now);
  // Outside the live window, weekends, and US equity holidays are read-only.
  if(session==='closed')return new Response('market closed/holiday; price fetching stopped until Pre-Market',{status:200});
  // Fail-safe lane: GitHub Actions remains the primary five-minute worker.
  // Netlify only runs the direct price worker when the published snapshot is
  // missing or older than six minutes, so the two lanes do not duplicate API work.
  try{
    const store=getDataStore();
    const current=await store.get('scanner-current-price-v1',{type:'json',consistency:'strong'}).catch(()=>null);
    const updatedAt=current?.updatedAt?new Date(current.updatedAt).getTime():0;
    const fresh=Number.isFinite(updatedAt)&&updatedAt>0&&(Date.now()-updatedAt)<6*60*1000&&Object.keys(current?.records||{}).length>0;
    if(fresh)return new Response('current-price snapshot is fresh; GitHub worker owns this cycle',{status:200});
    const result=await runMassiveCurrentUpdate();
    return new Response(JSON.stringify({ok:true,fallback:true,...result}),{status:202,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }catch(e){return new Response(String(e?.message||e),{status:500});}
}
export const config={schedule:'*/5 * * * 1-5'};

