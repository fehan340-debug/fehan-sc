import { getSiteSettings } from '../../lib.js';

export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  return new Response('full 10-minute scanner refresh owns Massive price/technical updates',{status:200});
}
// Deliberately no schedule: scanner-hourly-refresh-schedule.mjs runs the full
// Massive/technical refresh every 10 minutes. Keeping this endpoint available
// avoids breaking any existing manual/admin references without creating a
// second automatic update lane.
