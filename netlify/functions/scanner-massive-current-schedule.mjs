import { getSiteSettings } from '../../lib.js';

export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  return new Response('5-minute scanner refresh owns Massive price/technical updates',{status:200});
}
// Deliberately no schedule. The GitHub Massive workflow owns the five-minute
// live-price lane; daily technical data is rebuilt once during After-Hours.
// This endpoint remains only as a compatibility/manual status endpoint.
