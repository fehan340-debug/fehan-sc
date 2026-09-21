function env(name){return String(process.env[name]||'').trim();}
function parseRepo(raw){
  const value=String(raw||'').trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/^\/+|\/+$/g,'');
  const parts=value.split('/').filter(Boolean);
  if(parts.length!==2)throw new Error('GITHUB_WORKER_REPO يجب أن يكون owner/repository.');
  return parts;
}

export async function dispatchFloatWorker({source='daily-market-open'}={}){
  const token=env('GITHUB_WORKER_TOKEN');
  const repo=env('GITHUB_WORKER_REPO');
  const configuredWorkflow=env('GITHUB_FLOAT_WORKER_WORKFLOW')||'.github/workflows/finviz-float.yml';
  const ref=env('GITHUB_WORKER_REF')||'main';
  if(!token||!repo)throw new Error('لم يتم إعداد GITHUB_WORKER_TOKEN و GITHUB_WORKER_REPO في Netlify.');
  const [owner,name]=parseRepo(repo);
  const headers={accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'nasdaq-scanner-float-worker'};
  const base=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const stamp=new Date().toISOString();

  // Resolve the workflow from GitHub first. This avoids a 404 caused by an
  // incorrect path/filename and guarantees that the dispatch uses the workflow
  // that actually exists in .github/workflows on the configured repository.
  let workflowId=null, workflowPath=null;
  const wanted=String(configuredWorkflow).replace(/^\/+/, '').trim();
  const listUrl=`${base}/actions/workflows?per_page=100`;
  const listResponse=await fetch(listUrl,{headers});
  const listText=await listResponse.text();
  let listData={}; try{listData=listText?JSON.parse(listText):{};}catch{}
  if(!listResponse.ok){
    throw new Error(`تعذر قراءة Workflows من GitHub (HTTP ${listResponse.status}). تحقق من المستودع وصلاحيات GITHUB_WORKER_TOKEN.`);
  }
  const workflows=Array.isArray(listData.workflows)?listData.workflows:[];
  const wantedName=wanted.split('/').pop();
  const match=workflows.find(w=>String(w.path||'').replace(/^\/+/, '')===wanted)
    || workflows.find(w=>String(w.path||'').endsWith(`/${wantedName}`))
    || workflows.find(w=>String(w.name||'').trim()===wantedName);
  if(match){workflowId=match.id;workflowPath=match.path||wanted;}
  else throw new Error(`ملف Workflow غير موجود في المستودع: ${wanted}. الموجود: ${workflows.map(w=>w.path||w.name).slice(0,20).join(', ')||'لا توجد Workflows قابلة للوصول.'}`);

  const url=`${base}/actions/workflows/${encodeURIComponent(String(workflowId))}/dispatches`;
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({ref,inputs:{source:String(source||'daily-market-open'),requested_at:stamp}})});
  if(!response.ok){const body=await response.text();throw new Error(`تعذر تشغيل Background Worker للبيانات (HTTP ${response.status}). Workflow: ${workflowPath}. ${body.slice(0,300)}`);}
  return {ok:true,repo:`${owner}/${name}`,workflow:workflowPath,workflowId,ref,requestedAt:stamp};
}
