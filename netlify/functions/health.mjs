import { getStore } from "@netlify/blobs";
export default async function(){
  try{
    const store=getStore("nasdaq-scanner-data");
    const key="__health__";
    await store.setJSON(key,{ok:true,at:new Date().toISOString()});
    const value=await store.get(key,{type:"json"});
    return new Response(JSON.stringify({ok:true,functions:true,blobs:!!value,environment:{adminEmail:!!process.env.ADMIN_EMAIL,adminPassword:!!process.env.ADMIN_PASSWORD,massiveKey:!!String(process.env.MASSIVE_API_KEY||"").trim(),siteUrl:!!String(process.env.URL||process.env.DEPLOY_PRIME_URL||"").trim()}}),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
  }catch(e){
    console.error("health error",e);
    return new Response(JSON.stringify({ok:false,functions:true,blobs:false,error:String(e?.message||e)}),{status:500,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
  }
}
