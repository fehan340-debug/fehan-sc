import { currentUser } from '../../lib.js';
import { runHourlyBuild } from './scanner-hourly-core.mjs';
import { refreshIpoCache } from './scanner-ipo-core.mjs';
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return Response.json({error:'غير مصرح.'},{status:403});
  // This endpoint itself is a Background Function. It does not call another HTTP function,
  // so site protection cannot produce the old internal 401.
  try{
    // Manual 'refresh cache' also refreshes the prepared IPO snapshot so the
    // customer cache is rebuilt with the newest IPO data in the same operation.
    await refreshIpoCache();
    await runHourlyBuild({manual:true,force:true});
  }catch(e){console.error('manual hourly refresh failed',e);}
  return new Response('',{status:202});
}
export const config={background:true};
