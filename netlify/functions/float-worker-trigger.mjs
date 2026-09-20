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
  const workflow=env('GITHUB_FLOAT_WORKER_WORKFLOW')||'.github/workflows/daily-float-worker.yml';
  const ref=env('GITHUB_WORKER_REF')||'main';
  if(!token||!repo)throw new Error('لم يتم إعداد GITHUB_WORKER_TOKEN و GITHUB_WORKER_REPO في Netlify.');
  const [owner,name]=parseRepo(repo);
  const stamp=new Date().toISOString();
  const url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${workflow.split('/').map(encodeURIComponent).join('/')}/dispatches`;
  const response=await fetch(url,{
    method:'POST',
    headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2026-03-10','content-type':'application/json','user-agent':'nasdaq-scanner-float-worker'},
    body:JSON.stringify({ref,inputs:{source:String(source||'daily-market-open'),requested_at:stamp}})
  });
  if(!response.ok){const body=await response.text();throw new Error(`تعذر تشغيل Background Worker للـFree Float على GitHub (HTTP ${response.status}): ${body.slice(0,300)}`);}
  return {ok:true,repo:`${owner}/${name}`,workflow,ref,requestedAt:stamp};
}
