import { currentUser } from '../../lib.js';
import { dispatchShortWorker } from './short-worker-trigger.mjs';

export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:401});
  try{
    const result=await dispatchShortWorker({source:'manual-admin'});
    return new Response(JSON.stringify({ok:true,accepted:true,background:true,trigger_only:true,worker:'github-actions',requestedAt:result.requestedAt,repo:result.repo,workflow:result.workflow}),{status:202,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  }catch(e){
    console.error('external short worker trigger failed',e);
    return new Response(JSON.stringify({ok:false,error:String(e?.message||e)}),{status:500,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  }
}
