function env(name){return String(process.env[name]||'').trim();}
function parseRepo(raw){const value=String(raw||'').trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/^\/+|\/+$/g,'');const parts=value.split('/').filter(Boolean);if(parts.length!==2)throw new Error('GITHUB_WORKER_REPO يجب أن يكون owner/repository.');return parts;}
export async function dispatchMassiveWorker({source='manual-admin-massive'}={}){
  const token=env('GITHUB_WORKER_TOKEN'),repo=env('GITHUB_WORKER_REPO'),configured=env('GITHUB_MASSIVE_WORKFLOW')||'.github/workflows/massive-update.yml',ref=env('GITHUB_WORKER_REF')||'main';
  if(!token||!repo)throw new Error('لم يتم إعداد GITHUB_WORKER_TOKEN و GITHUB_WORKER_REPO في Netlify.');
  const [owner,name]=parseRepo(repo);const headers={accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'nasdaq-scanner-massive-worker'};const base=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const wanted=configured.replace(/^\/+/,''),list=await fetch(`${base}/actions/workflows?per_page=100`,{headers}),text=await list.text();let data={};try{data=text?JSON.parse(text):{};}catch{}
  if(!list.ok)throw new Error(`تعذر قراءة Workflows من GitHub (HTTP ${list.status}). تحقق من المستودع وصلاحيات المفتاح.`);
  const workflows=Array.isArray(data.workflows)?data.workflows:[],nameOnly=wanted.split('/').pop();
  const match=workflows.find(w=>String(w.path||'').replace(/^\/+|\/+$/g,'')===wanted)||workflows.find(w=>String(w.path||'').endsWith(`/${nameOnly}`))||workflows.find(w=>String(w.name||'').trim()===nameOnly);
  if(!match)throw new Error(`ملف Workflow غير موجود في المستودع: ${wanted}.`);
  const stamp=new Date().toISOString();const response=await fetch(`${base}/actions/workflows/${encodeURIComponent(String(match.id))}/dispatches`,{method:'POST',headers,body:JSON.stringify({ref,inputs:{source:String(source),requested_at:stamp}})});
  if(!response.ok)throw new Error(`تعذر تشغيل Massive Workflow (HTTP ${response.status}). ${String(await response.text()).slice(0,300)}`);
  return {ok:true,repo:`${owner}/${name}`,workflow:match.path||wanted,workflowId:match.id,ref,requestedAt:stamp};
}
