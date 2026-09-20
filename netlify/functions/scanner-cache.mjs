import { requireUser, json } from '../../lib.js';
import { readPublishedCache } from './scanner-hourly-core.mjs';

// Per-function-instance server cache. It is deliberately short-lived: a new
// published snapshot is still produced by the refresh workers, while users
// never need to query Supabase for every page/search request.
let memoryCache=null;
let memoryCacheExpires=0;
const SERVER_CACHE_TTL_MS=5*60*1000;

export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    const now=Date.now();
    let cache=(memoryCache&&memoryCacheExpires>now)?memoryCache:null;
    if(!cache){
      cache=await readPublishedCache();
      if(cache?.ready&&Array.isArray(cache.records)){
        memoryCache=cache;
        memoryCacheExpires=now+SERVER_CACHE_TTL_MS;
      }
    }
    const ipoRecords=Array.isArray(cache?.ipos)?cache.ipos:[];
    const ipoUpdatedAt=cache?.ipoUpdatedAt||null;
    const edgeCacheHeaders={
      'Cache-Control':'public, max-age=300, s-maxage=300, stale-while-revalidate=300, stale-if-error=86400',
      'Surrogate-Control':'max-age=300, stale-while-revalidate=300, stale-if-error=86400',
      'Vary':'Accept-Encoding'
    };
    if(cache?.ready&&Array.isArray(cache.records))return json({ok:true,...cache,ipos:ipoRecords,ipoUpdatedAt,serverCacheTtlSeconds:300},200,edgeCacheHeaders);
    return json({ok:true,ready:false,records:[],updatedAt:null,ipos:[],ipoUpdatedAt:null,message:'لا يوجد كاش مكتمل حتى الآن. التحديث التلقائي سيبني أول نسخة.'},200,edgeCacheHeaders);
  }catch(e){return json({ok:false,ready:false,records:[],error:String(e?.message||e)},500);}
}
