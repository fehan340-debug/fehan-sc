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
    if(cache?.ready&&Array.isArray(cache.records)){
      const current=await getDataStore().get('scanner-current-price-v1',{type:'json',consistency:'strong'}).catch(()=>null);
      const live=current?.records&&typeof current.records==='object'?current.records:{};
      const records=cache.records.map(row=>{
        const t=String(row?.ticker||'').toUpperCase();
        const l=live[t];
        const p=Number(l?.extendedPrice);
        if(Number.isFinite(p)&&p>0){
          return {...row,extendedPrice:p,current:p,currentPrice:p,preMarketPrice:Number.isFinite(Number(l?.preMarket))?Number(l.preMarket):(row.preMarketPrice??null),afterHoursPrice:Number.isFinite(Number(l?.afterHours))?Number(l.afterHours):(row.afterHoursPrice??null),priceSession:l?.priceSession||current?.session||row.priceSession||null,priceSource:l?.priceSource||row.priceSource||null,currentUpdatedAt:current?.updatedAt||null,changePct:Number.isFinite(Number(l?.changePct))?Number(l.changePct):row.changePct};
        }
        const existing=Number(row?.extendedPrice);
        return Number.isFinite(existing)&&existing>0?row:{...row,extendedPrice:null,current:null,currentPrice:null};
      });
      return json({ok:true,...cache,records,ipos:ipoRecords,ipoUpdatedAt,currentUpdatedAt:current?.updatedAt||null,currentSession:current?.session||null,serverCacheTtlSeconds:0},200,headers);
    }
    return json({ok:true,ready:false,records:[],updatedAt:null,ipos:[],ipoUpdatedAt:null,message:'لا يوجد كاش مكتمل حتى الآن. التحديث التلقائي سيبني أول نسخة.'},200,headers);
  }catch(e){return json({ok:false,ready:false,records:[],error:String(e?.message||e)},500,{'Cache-Control':'private, no-store, max-age=0'});}
}
