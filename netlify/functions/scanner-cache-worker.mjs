import { currentUser } from '../../lib.js';
import { runHourlyBuild } from './scanner-hourly-core.mjs';
export const runScannerCacheBuild = runHourlyBuild;
export async function patchScannerCacheBorrow(){ return {ok:false,reason:'البيانات مستقلة الآن وتُقرأ من كاش الشورت دون الكتابة فوق كاش الباحث.'}; }
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:401});
  try{await runHourlyBuild({manual:true,force:true});return new Response('ok',{status:202});}catch(e){return new Response(String(e?.message||e),{status:500});}
}
export const config={background:true};
