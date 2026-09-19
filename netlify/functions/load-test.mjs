import { json, cookieMap, currentUser, getDataStore, getSessionStore, randomToken, ensureAdmin, getFavorites } from "../../lib.js";

const MAX_USERS = 500;
const MAX_ROUNDS = 10;

function cookieHeader(token){ return `scanner_session=${encodeURIComponent(token)}`; }
function okStatus(s){ return s >= 200 && s < 300; }

export default async function(request){
  const started = Date.now();
  try{
    await ensureAdmin();
    const me = await currentUser(request);
    if(!me || me.blocked || !me.user?.admin) return json({error:"غير مصرح. اختبار الضغط للمدير فقط."},401);
    if(request.method !== "POST") return json({error:"استخدم POST."},405);

    const body = await request.json().catch(()=>({}));
    const users = Math.max(1, Math.min(MAX_USERS, Number(body.users)||100));
    const rounds = Math.max(1, Math.min(MAX_ROUNDS, Number(body.rounds)||1));
    const mode = String(body.mode||"scanner");
    const allowedModes=new Set(["scanner","me","favorites","health","serverFull"]);
    if(!allowedModes.has(mode)) return json({error:"نوع الاختبار غير مدعوم."},400);

    // Netlify Access can protect the public URL before a function is reached.
    // Calling the public URL from inside this function would therefore return 401
    // even though the backend itself is healthy. For this test, execute the same
    // backend reads directly inside this Function, with a separate session per user.
    const store = getDataStore();
    const sessionStore = getSessionStore();
    const sessionTokens = [];

    const sessionData = [];
    for(let i=0;i<users;i++){
      const token = randomToken();
      sessionTokens.push(token);
      sessionData.push({token, value:{email:me.user.email, createdAt:new Date().toISOString(), expiresAt:new Date(Date.now()+10*60*1000).toISOString(), loadTest:true}});
    }
    for(let start=0; start<sessionData.length; start+=50){
      const batch=sessionData.slice(start,start+50);
      await Promise.all(batch.map(x=>sessionStore.setJSON(`session:${x.token}`,x.value)));
    }

    function reqFor(token){ return new Request('https://load-test.internal/', {headers:{cookie:cookieHeader(token),'x-load-test':'1'}}); }
    async function runStep(token,name){
      const stepStart=Date.now();
      try{
        const r=reqFor(token);
        if(name==='الحساب'){
          const c=await currentUser(r);
          return {name,status:c?200:401,ms:Date.now()-stepStart};
        }
        if(name==='الباحث'){
          const c=await currentUser(r);
          if(!c || c.blocked) return {name,status:c?.blocked?403:401,ms:Date.now()-stepStart};
          const cache=await store.get('scanner-cache-v1',{type:'json'});
          return {name,status:cache&&Array.isArray(cache.records)?200:200,ready:Boolean(cache),ms:Date.now()-stepStart};
        }
        if(name==='المفضلة'){
          const c=await currentUser(r);
          if(!c || c.blocked) return {name,status:c?.blocked?403:401,ms:Date.now()-stepStart};
          const fav=await getFavorites(c.user.email);
          return {name,status:200,count:Array.isArray(fav)?fav.length:0,ms:Date.now()-stepStart};
        }
        if(name==='الصحة'){
          const probe=`load-health-${Date.now()}-${Math.random()}`;
          await store.setJSON(probe,{ok:true});
          const value=await store.get(probe,{type:'json'});
          await store.delete(probe).catch(()=>{});
          return {name,status:value?.ok?200:500,ms:Date.now()-stepStart};
        }
        return {name,status:400,ms:Date.now()-stepStart,error:'خطوة غير معروفة'};
      }catch(e){
        return {name,status:500,ms:Date.now()-stepStart,error:String(e?.message||e)};
      }
    }

    const totals={users:0,ok:0,fail:0,c429:0,c5xx:0,totalMs:0,minMs:null,maxMs:null};
    const roundsOut=[];
    const modeSteps={scanner:['الباحث'],me:['الحساب'],favorites:['المفضلة'],health:['الصحة'],serverFull:['الحساب','الباحث','المفضلة']};
    const selectedSteps=modeSteps[mode]||['الباحث'];

    async function runVirtualUser(i, round){
      const token=sessionTokens[i];
      const st=Date.now();
      const result={user:i+1,round,steps:[],ok:true};
      for(const name of selectedSteps){
        const step=await runStep(token,name);
        result.steps.push(step);
        if(!(step.status>=200 && step.status<300)){ result.ok=false; break; }
      }
      result.ms=Date.now()-st;
      return result;
    }

    try{
      for(let round=1;round<=rounds;round++){
        const batch=await Promise.all(Array.from({length:users},(_,i)=>runVirtualUser(i,round)));
        let ok=0,fail=0,c429=0,c5xx=0;
        for(const r of batch){
          totals.users++;
          if(r.ok) ok++; else fail++;
          totals.totalMs+=r.ms;
          totals.minMs=totals.minMs===null?r.ms:Math.min(totals.minMs,r.ms);
          totals.maxMs=totals.maxMs===null?r.ms:Math.max(totals.maxMs,r.ms);
          for(const s of r.steps){if(s.status===429)c429++;if(s.status>=500&&s.status<600)c5xx++;}
        }
        totals.ok+=ok; totals.fail+=fail; totals.c429+=c429; totals.c5xx+=c5xx;
        const failed=batch.find(x=>!x.ok);
        roundsOut.push({round,users,ok,fail,c429,c5xx,firstFailure:failed?JSON.stringify(failed.steps):null});
      }
    } finally {
      await Promise.all(sessionTokens.map(t=>sessionStore.delete(`session:${t}`).catch(()=>{})));
      await Promise.all(sessionTokens.map(t=>store.delete(`loadtest-session:${t}`).catch(()=>{})));
    }

    return json({
      ok:true,
      mode:"independent-sessions",
      users,rounds,
      totalUsers:totals.users,
      totalRequests:totals.users*selectedSteps.length,
      success:totals.ok,
      failure:totals.fail,
      c429:totals.c429,
      c5xx:totals.c5xx,
      avgMs:totals.users?totals.totalMs/totals.users:0,
      minMs:totals.minMs||0,
      maxMs:totals.maxMs||0,
      elapsedMs:Date.now()-started,
      rounds:roundsOut,
      note:"جلسات مستقلة داخل وظيفة الاختبار لتجاوز Netlify Access الذي يمنع الاستدعاء الداخلي للدومين المحمي. يختبر عمليات الحساب والباحث والمفضلة وقراءة Supabase لكل جلسة، لكنه لا يقيس طبقة HTTP/Netlify Access ولا أجهزة أو عناوين IP مستقلة."
    });
  }catch(err){
    console.error("load-test error",err);
    return json({error:String(err?.message||err)},500);
  }
}
