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
    // Stock/IPO data is identical for all authenticated scanner users.
    // Let the CDN/Edge serve the same snapshot for up to 5 minutes,
    // then revalidate it in the background while allowing stale data briefly.
    const edgeCacheHeaders={
      'Cache-Control':'public, max-age=300, s-maxage=300, stale-while-revalidate=300, stale-if-error=86400', 'Surrogate-Control':'max-age=300, stale-while-revalidate=300, stale-if-error=86400', 'Vary':'Accept-Encoding'
    };
    if(cache?.ready&&Array.isArray(cache.records)) return json(
      {ok:true,...cache,ipos:ipo?.records||[],ipoUpdatedAt:ipo?.updatedAt||null},
      200,
      edgeCacheHeaders
    );
    return json(
      {ok:true,ready:false,records:[],updatedAt:null,ipos:ipo?.records||[],ipoUpdatedAt:ipo?.updatedAt||null,message:'لا يوجد كاش مكتمل حتى الآن. التحديث التلقائي سيبني أول نسخة.'},
      200,
      edgeCacheHeaders
    );
  }catch(e){return json({ok:false,ready:false,records:[],error:String(e?.message||e)},500);}
}
