import { requireUser, json, getDataStore } from '../../lib.js';
export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response)return auth;
  try{
    const store=getDataStore();
    const d=await store.get('scanner-current-price-v1',{type:'json',consistency:'strong'});
    const fallback=(!d?.records||typeof d.records!=='object'||Object.keys(d.records).length===0)
      ? await store.get('scanner-massive-current-v1',{type:'json',consistency:'strong'}).catch(()=>null)
      : null;
    const source=d?.records&&typeof d.records==='object'&&Object.keys(d.records).length?d:(fallback||d);
    const headers={'Cache-Control':'private, no-store, max-age=0, must-revalidate','Surrogate-Control':'no-store','Vary':'Accept-Encoding'};
    const raw=source?.records&&typeof source.records==='object'?source.records:{};
    const records={};
    for(const [ticker,row] of Object.entries(raw)){
      const p=Number(row?.extendedPrice);
      records[String(ticker).toUpperCase()]={...row,extendedPrice:Number.isFinite(p)&&p>0?p:(Number.isFinite(Number(row?.price))&&Number(row.price)>0?Number(row.price):null)};
    }
    return json({ok:true,ready:Boolean(Object.keys(records).length),updatedAt:source?.updatedAt||null,session:source?.session||'closed',records},200,headers);
  }catch(e){return json({ok:false,ready:false,records:{},error:String(e?.message||e)},500);}
}
