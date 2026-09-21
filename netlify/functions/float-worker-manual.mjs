import { currentUser, json } from '../../lib.js';
import { dispatchFloatWorker } from './float-worker-trigger.mjs';

export default async function(request){
  try{
    const c=await currentUser(request);
    if(!c?.user?.admin || c.maintenance || c.blocked) return json({error:'غير مصرح.'},403);
    const result=await dispatchFloatWorker({source:'manual-admin-float-only'});
    return json({ok:true,...result},202);
  }catch(e){
    return json({ok:false,error:String(e?.message||e)},500);
  }
}
