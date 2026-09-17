import { requireUser, json } from '../../lib.js';
import { readIpoCache } from './scanner-ipo-core.mjs';

export default async function(request){
  const auth=await requireUser(request);
  if(auth instanceof Response)return auth;
  try{
    const cache=await readIpoCache();
    return json({
      ok:true,
      ready:Boolean(cache?.ready),
      records:Array.isArray(cache?.records)?cache.records:[],
      updatedAt:cache?.updatedAt||null,
      source:cache?.source||'scanner-ipo-daily'
    });
  }catch(e){
    return json({ok:false,ready:false,records:[],updatedAt:null,error:String(e?.message||e)},500);
  }
}
