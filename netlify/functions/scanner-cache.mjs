import { requireUser, json, getDataStore } from '../../lib.js';
import { readPublishedCache } from './scanner-hourly-core.mjs';

export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    // Do not cache this HTTP response: Supabase is the authoritative published
    // cache and workers update it immediately when their jobs finish.
    let cache=await readPublishedCache();
    // Short/borrow data is published only as a completed hourly snapshot.
    // Never overlay individual ticker results while the external worker is running.
    const ipoRecords=Array.isArray(cache?.ipos)?cache.ipos:[];
    const ipoUpdatedAt=cache?.ipoUpdatedAt||null;
    const headers={'Cache-Control':'private, no-store, max-age=0','Surrogate-Control':'no-store','Vary':'Accept-Encoding'};
    if(cache?.ready&&Array.isArray(cache.records))return json({ok:true,...cache,ipos:ipoRecords,ipoUpdatedAt,serverCacheTtlSeconds:0},200,headers);
    return json({ok:true,ready:false,records:[],updatedAt:null,ipos:[],ipoUpdatedAt:null,message:'لا يوجد كاش مكتمل حتى الآن. التحديث التلقائي سيبني أول نسخة.'},200,headers);
  }catch(e){return json({ok:false,ready:false,records:[],error:String(e?.message||e)},500,{'Cache-Control':'private, no-store, max-age=0'});}
}
