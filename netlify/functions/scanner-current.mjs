import { requireUser, json, getDataStore } from '../../lib.js';
export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    const d=await getDataStore().get('scanner-current-price-v1',{type:'json',consistency:'strong'});
    const headers={'Cache-Control':'private, no-store, max-age=0, must-revalidate','Surrogate-Control':'no-store','Vary':'Accept-Encoding'};
    return json({ok:true,ready:Boolean(d?.records),updatedAt:d?.updatedAt||null,session:d?.session||'closed',records:d?.records||{}},200,headers);
  }catch(e){return json({ok:false,ready:false,records:{},error:String(e?.message||e)},500);}
}
