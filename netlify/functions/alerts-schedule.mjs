import { runAlertSweep } from "./alerts.mjs";
export default async function(){try{const r=await runAlertSweep();return new Response(JSON.stringify(r),{status:200,headers:{"content-type":"application/json"}});}catch(e){return new Response(JSON.stringify({ok:false,error:String(e?.message||e)}),{status:500,headers:{"content-type":"application/json"}});}}
export const config={schedule:"*/5 * * * *"};
