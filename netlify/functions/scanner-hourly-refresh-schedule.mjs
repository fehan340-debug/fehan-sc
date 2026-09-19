import { getSiteSettings } from '../../lib.js';
import { AsyncWorkloadsClient } from '@netlify/async-workloads';

export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const weekday=parts.find(x=>x.type==='weekday')?.value||'';
  const hour=Number(parts.find(x=>x.type==='hour')?.value||0);
  if(['Sat','Sun'].includes(weekday)||hour<4||hour>=20)return new Response('outside automatic 04:00-20:00 New York window',{status:200});
  const c=new AsyncWorkloadsClient();
  await c.send('scanner.hourly.start',{data:{manual:false,scheduledAt:now.toISOString(),mode:'full-every-10-minutes'}});
  return new Response('full scanner refresh queued',{status:202});
}

export const config={schedule:'*/10 * * * 1-5'};
