import { getSiteSettings } from '../../lib.js';
import { AsyncWorkloadsClient } from '@netlify/async-workloads';
export default async function(){const settings=await getSiteSettings();if(settings.auto_update_enabled!==true)return new Response('automatic updates disabled',{status:200});const c=new AsyncWorkloadsClient();await c.send('scanner.hourly.start',{data:{manual:false,scheduledAt:new Date().toISOString()}});}
export const config={schedule:'40 * * * 1-5'};
