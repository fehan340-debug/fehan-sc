import { json,requireUser } from "../../lib.js";
export default async function(request){
  const auth=await requireUser(request); if(auth instanceof Response) return auth;
  const path=new URL(request.url).searchParams.get("path")||"";
  if(!path.startsWith("/")||path.includes("..")||path.includes("://"))return json({error:"مسار غير صالح"},400);
  const key=String(process.env.MASSIVE_API_KEY||"").trim();
  if(!key)return json({error:"MASSIVE_API_KEY غير مضبوط في Netlify."},500);
  const sep=path.includes("?")?"&":"?";
  try{
    const upstream=await fetch(`https://api.massive.com${path}${sep}apiKey=${encodeURIComponent(key)}`,{headers:{"accept":"application/json"}});
    const raw=await upstream.text();
    let body=null; try{body=raw?JSON.parse(raw):null}catch{}
    if(!upstream.ok){
      const detail=body?.error||body?.message||body?.status||raw?.slice(0,500)||"Massive API error";
      return json({error:`Massive API HTTP ${upstream.status}: ${detail}`,upstreamStatus:upstream.status},upstream.status);
    }
    return new Response(raw,{status:upstream.status,headers:{"content-type":upstream.headers.get("content-type")||"application/json","cache-control":"private, max-age=15"}});
  }catch(e){
    return json({error:`تعذر الاتصال بـ Massive API: ${e?.message||e}`},502);
  }
}
