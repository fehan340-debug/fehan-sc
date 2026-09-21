import { getSiteSettings } from '../../lib.js';
import { refreshIpoCache } from './scanner-ipo-core.mjs';
export default async function(){const settings=await getSiteSettings();if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const existing=await (await import('../../lib.js')).getDataStore().get('scanner-ipo-v1',{type:'json',consistency:'strong'}).catch(()=>null);
  if(existing?.updatedAt&&new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(existing.updatedAt))===today)return new Response('IPO already refreshed today',{status:200});
  try{await refreshIpoCache();return new Response('ok',{status:200});}
  catch(e){console.error('daily IPO refresh failed',e);return new Response(String(e?.message||e),{status:500});}
}
export const config={schedule:'0 13 * * *'};
// One daily refresh. The hourly scanner only reads this prepared snapshot.

