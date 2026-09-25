import { requireUser, json, getDataStore } from '../../lib.js';
export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    const d=await getDataStore().get('scanner-current-price-v1',{type:'json',consistency:'strong'});
    const headers={'Cache-Control':'private, no-store, max-age=0, must-revalidate','Surrogate-Control':'no-store','Vary':'Accept-Encoding'};
    const raw=d?.records&&typeof d.records==='object'?d.records:{};
    const records={};
    for(const [ticker,row] of Object.entries(raw)){
      const p=Number(row?.extendedPrice);
      records[String(ticker).toUpperCase()]={...row,extendedPrice:Number.isFinite(p)&&p>0?p:(Number.isFinite(Number(row?.price))&&Number(row.price)>0?Number(row.price):null)};
    }
    return json({ok:true,ready:Boolean(Object.keys(records).length),updatedAt:d?.updatedAt||null,session:d?.session||'closed',records},200,headers);
  }catch(e){return json({ok:false,ready:false,records:{},error:String(e?.message||e)},500);}
}
