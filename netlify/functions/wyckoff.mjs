import { getDataStore } from '../../lib.js';
import { readWyckoff, readWyckoffStatus } from './wyckoff-core.mjs';
function json(x,status=200){return new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
export default async function(request){
  try{
    const u=new URL(request.url),action=u.searchParams.get('action')||'read';
    if(action==='status')return json({ok:true,status:await readWyckoffStatus()});
    if(action==='read'||action==='results')return json({ok:true,data:await readWyckoff(),status:await readWyckoffStatus()});
    return json({ok:false,error:'تشغيل Wyckoff يتم حصراً عبر GitHub Actions من لوحة المدير.'},410);
  }catch(e){return json({ok:false,error:String(e?.message||e)},500);}
}
