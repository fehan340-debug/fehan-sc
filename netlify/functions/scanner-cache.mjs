import { requireUser, json } from '../../lib.js';
import { readPublishedCache } from './scanner-hourly-core.mjs';
import { readIpoCache } from './scanner-ipo-core.mjs';

export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    const cache=await readPublishedCache();
    // Keep the response shape compatible with the browser scanner:
    // records/updatedAt must be top-level, not nested under `cache`.
    const ipo=await readIpoCache();
    if(cache?.ready&&Array.isArray(cache.records)) return json({ok:true,...cache,ipos:ipo?.records||[],ipoUpdatedAt:ipo?.updatedAt||null});
    return json({ok:true,ready:false,records:[],updatedAt:null,ipos:ipo?.records||[],ipoUpdatedAt:ipo?.updatedAt||null,message:'لا يوجد كاش مكتمل حتى الآن. التحديث التلقائي سيبني أول نسخة.'},200);
  }catch(e){return json({ok:false,ready:false,records:[],error:String(e?.message||e)},500);}
}
