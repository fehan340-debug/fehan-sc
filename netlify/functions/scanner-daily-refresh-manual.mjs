import { currentUser } from '../../lib.js';
import { refreshUniverse } from './scanner-universe-core.mjs';
import { runHourlyBuild } from './scanner-hourly-core.mjs';
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:403});
  try{await refreshUniverse();await runHourlyBuild({manual:true,force:true});}catch(e){console.error('manual daily refresh failed',e);}
  return new Response('',{status:202});
}
export const config={background:true};
