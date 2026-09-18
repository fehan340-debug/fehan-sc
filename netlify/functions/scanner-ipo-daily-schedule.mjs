import { getSiteSettings } from '../../lib.js';
import { refreshIpoCache } from './scanner-ipo-core.mjs';
export default async function(){const settings=await getSiteSettings();if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  try{await refreshIpoCache();return new Response('ok',{status:200});}
  catch(e){console.error('daily IPO refresh failed',e);return new Response(String(e?.message||e),{status:500});}
}
export const config={schedule:'15 10 * * 1-5'};
