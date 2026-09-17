import { getSiteSettings, getDataStore } from '../../lib.js';
import { dispatchShortWorker } from './short-worker-trigger.mjs';

export default async function(){
  const settings=await getSiteSettings();
  if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const weekday=parts.find(x=>x.type==='weekday')?.value||'';
  const hour=Number(parts.find(x=>x.type==='hour')?.value||0);
  const minute=Number(parts.find(x=>x.type==='minute')?.value||0);
  if(['Sat','Sun'].includes(weekday)||hour<4||hour>=20)return new Response('outside automatic short window',{status:200});
  if(minute!==50)return new Response('waiting for automatic short minute',{status:200});
  const store=getDataStore();
  const active=await store.get('scanner-borrow-job-v4',{type:'json',consistency:'strong'}).catch(()=>null);
  if(active?.active)return new Response('short update already running',{status:200});
  const pending=await store.get('trigger_short_update',{type:'json',consistency:'strong'}).catch(()=>null);
  if(pending?.trigger===true)return new Response('short worker already pending',{status:200});
  const result=await dispatchShortWorker({source:'automatic-cron'});
  return new Response(JSON.stringify({ok:true,triggered:true,externalWorker:true,minute,repo:result.repo,workflow:result.workflow}),{status:202,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}
export const config={schedule:'* * * * 1-5'};
