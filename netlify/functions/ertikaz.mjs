import { readErtikaz, readErtikazStatus } from './ertikaz-core.mjs';

function json(x,status=200){
  return new Response(JSON.stringify(x),{
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
  });
}

export default async function(request){
  try{
    const action=new URL(request.url).searchParams.get('action')||'read';
    if(action==='status')return json({ok:true,status:await readErtikazStatus()});
    if(action==='read'||action==='results')return json({ok:true,data:await readErtikaz(),status:await readErtikazStatus()});
    return json({ok:false,error:'قراءة نتائج ارتكاز فقط متاحة هنا.'},400);
  }catch(e){
    return json({ok:false,error:String(e?.message||e)},500);
  }
}
