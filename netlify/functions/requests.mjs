import { json,readJson,getRequests,saveRequests,randomToken,currentUser,getSiteSettings,getAttachmentStore } from "../../lib.js";
export default async function(request){
  try{
    if(request.method==="POST"){
      const b=await readJson(request); const c=await currentUser(request);
      if(b.markSupportRead){
        if(c?.maintenance)return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
        if(!c?.user)return json({error:"يجب تسجيل الدخول."},401);
        const id=String(b.id||""); const reqs=await getRequests(); const item=reqs.find(x=>x.id===id&&x.type==="support"&&x.email===c.user.email);
        if(!item)return json({error:"الرسالة غير موجودة."},404);
        item.supportReadAt=new Date().toISOString(); await saveRequests(reqs); return json({ok:true});
      }
      if(b.customerService){
        if(c?.maintenance)return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
        if(!c?.user)return json({error:"يجب تسجيل الدخول لإرسال الرسالة."},401);
        const message=String(b.message||"").trim();
        if(!message)return json({error:"اكتب الرسالة أولاً."},400);
        let attachment=null;
        if(b.attachment?.data){
          const raw=String(b.attachment.data); const comma=raw.indexOf(','); const b64=comma>=0?raw.slice(comma+1):raw;
          if(b64.length>4_000_000) return json({error:"المرفق كبير جدًا."},413);
          const bytes=Buffer.from(b64,"base64");
          const type=String(b.attachment.type||"application/octet-stream");
          const allowed=new Set(["image/png","image/jpeg","image/jpg","application/pdf"]);
          if(!allowed.has(type)) return json({error:"نوع المرفق غير مدعوم. المسموح PNG/JPG/PDF فقط."},400);
          const attachmentId=`support-attachment-${randomToken()}`;
          await getAttachmentStore().set(attachmentId,bytes,{contentType:type});
          attachment={id:attachmentId,name:String(b.attachment.name||"attachment"),type,size:bytes.byteLength,storedAt:new Date().toISOString()};
        }
        const reqs=await getRequests(); const id=randomToken().slice(0,16);
        reqs.unshift({id,type:"support",supportKind:b.type==="suggestion"?"suggestion":"question",subject:String(b.subject||"").trim(),message,attachment,email:c.user.email,name:c.user.email,contact:c.user.email,status:"new",createdAt:new Date().toISOString()});
        await saveRequests(reqs); return json({ok:true,id});
      }
      const renewal=Boolean(b.renewal);
      if(c?.maintenance)return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
      if(renewal && !c?.user)return json({error:"يجب تسجيل الدخول لإرسال طلب تجديد."},401);
      if(!b.name||!b.contact||!b.plan)return json({error:"أكمل بيانات الطلب."},400);
      const pricing=await getSiteSettings(); const selectedPlan=pricing.plans.find(p=>p.id===String(b.plan||""));
      if(!selectedPlan)return json({error:"الباقة المحددة غير موجودة."},400);
      const amount=selectedPlan.price;
      let attachment=null;
      if(b.proof?.data){
        const raw=String(b.proof.data); const comma=raw.indexOf(','); const b64=comma>=0?raw.slice(comma+1):raw;
        if(b64.length>4_000_000) return json({error:"المرفق كبير جدًا."},413);
        const bytes=Buffer.from(b64,"base64");
        const attachmentId=`customer-attachment-${randomToken()}`;
        const type=String(b.proof.type||"application/octet-stream");
        await getAttachmentStore().set(attachmentId,bytes,{contentType:type});
        attachment={id:attachmentId,name:String(b.proof.name||"attachment"),type,size:bytes.byteLength,storedAt:new Date().toISOString()};
      }
      const reqs=await getRequests(); const id=randomToken().slice(0,16);
      const email=renewal?c.user.email:(String(b.contact||"").trim().toLowerCase());
      reqs.unshift({id,type:renewal?"renewal":"new",email,name:String(b.name),contact:String(b.contact),plan:selectedPlan.id,amount,proof:attachment,status:"pending",createdAt:new Date().toISOString()});
      await saveRequests(reqs); return json({ok:true,id});
    }
    const c=await currentUser(request);
    const url=new URL(request.url);
    const attachmentId=String(url.searchParams.get("attachment")||"");
    if(attachmentId){
      if(!c?.user?.admin)return json({error:"غير مصرح."},403);
      const owner=(await getRequests()).find(x=>x?.proof?.id===attachmentId || x?.attachment?.id===attachmentId);
      const meta=owner?.proof?.id===attachmentId?owner.proof:owner?.attachment?.id===attachmentId?owner.attachment:null;
      if(!meta)return json({error:"المرفق غير موجود."},404);
      const data=await getAttachmentStore().get(attachmentId,{type:"arrayBuffer",consistency:"strong"});
      if(!data)return json({error:"تعذر قراءة المرفق."},404);
      const download=String(url.searchParams.get("download")||"")==="1";
      const disposition=download?"attachment":"inline";
      return new Response(data,{status:200,headers:{"content-type":meta.type||"application/octet-stream","content-disposition":`${disposition}; filename="${encodeURIComponent(meta.name||"attachment")}"`,"cache-control":"private, no-store"}});
    }
    if(url.searchParams.get("mine")==="1"){
      if(c?.maintenance)return json({maintenance:true,mode:c.siteMode||"maintenance",message:c.siteModeMessage||"الموقع متوقف مؤقتًا، الرجاء المحاولة لاحقًا."},503);
      if(!c?.user)return json({error:"غير مصرح."},401);
      const requests=await getRequests();
      return json({requests:requests.filter(x=>x.type==="support"&&x.email===c.user.email).slice(0,50)});
    }
    if(!c?.user?.admin)return json({error:"غير مصرح."},403);
    return json({requests:await getRequests()});
  }catch(err){
    console.error("requests function error",err);
    return json({error:`تعذر حفظ الطلب: ${String(err?.message||err)}`},500);
  }
}
