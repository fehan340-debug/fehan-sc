import { getDataStore } from '../../lib.js';

const WORKFLOW_DEFAULT='.github/workflows/short-worker.yml';

function env(name){return String(process.env[name]||'').trim();}

function parseRepo(raw){
  const value=String(raw||'').trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/^\/+|\/+$/g,'');
  const parts=value.split('/').filter(Boolean);
  if(parts.length!==2)throw new Error('GITHUB_WORKER_REPO يجب أن يكون owner/repository.');
  return parts;
}

export async function dispatchShortWorker({source='manual-admin'}={}){
  const token=env('GITHUB_WORKER_TOKEN');
  const repo=env('GITHUB_WORKER_REPO');
  const workflow=env('GITHUB_WORKER_WORKFLOW')||WORKFLOW_DEFAULT;
  const ref=env('GITHUB_WORKER_REF')||'main';
  if(!token||!repo)throw new Error('لم يتم إعداد GITHUB_WORKER_TOKEN و GITHUB_WORKER_REPO في Netlify.');
  const [owner,name]=parseRepo(repo);
  const store=getDataStore();
  const stamp=new Date().toISOString();
  const current=await store.get('trigger_short_update',{type:'json',consistency:'strong'}).catch(()=>null);
  const active=await store.get('scanner-borrow-job-v4',{type:'json',consistency:'strong'}).catch(()=>null);
  const trigger={
    trigger:true,
    status:'pending',
    requestedAt:stamp,
    source:String(source||'manual-admin'),
    jobId:active?.jobId||current?.jobId||null,
    worker:'github-actions'
  };
  await store.setJSON('trigger_short_update',trigger);
  await store.setJSON('scanner-borrow-status',{
    state:active?.active?'building':'pending',
    phase:'waiting-for-external-worker',
    mode:'external-github-actions',
    timeoutMs:4000,
    total:active?.total||0,
    done:active?.cursor||0,
    requestedAt:stamp,
    startedAt:active?.startedAt||null,
    finishedAt:null,
    error:null,
    source:trigger.source,
    worker:'github-actions'
  });
  const url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${workflow.split('/').map(encodeURIComponent).join('/')}/dispatches`;
  const response=await fetch(url,{
    method:'POST',
    headers:{
      accept:'application/vnd.github+json',
      authorization:`Bearer ${token}`,
      'x-github-api-version':'2026-03-10',
      'content-type':'application/json',
      'user-agent':'nasdaq-scanner-short-worker'
    },
    body:JSON.stringify({ref,inputs:{source:String(source||'manual-admin'),requested_at:stamp}})
  });
  if(!response.ok){
    const body=await response.text();
    await store.setJSON('scanner-borrow-status',{state:'error',phase:'worker-dispatch-failed',mode:'external-github-actions',error:`GitHub HTTP ${response.status}: ${body.slice(0,500)}`,requestedAt:stamp,finishedAt:new Date().toISOString()}).catch(()=>{});
    throw new Error(`تعذر تشغيل Background Worker على GitHub (HTTP ${response.status}).`);
  }
  return {ok:true,repo:`${owner}/${name}`,workflow,ref,requestedAt:stamp,trigger};
}
