import { getDataStore } from '../../lib.js';

const TRIGGER_KEY='trigger_short_update';
const JOB_KEY='scanner-borrow-job-v4';
const STATUS_KEY='scanner-borrow-status';

export async function requestBorrowRefreshTrigger({source='manual'}={}){
  const store=getDataStore();
  const stamp=new Date().toISOString();
  const active=await store.get(JOB_KEY,{type:'json',consistency:'strong'}).catch(()=>null);
  const existing=await store.get(TRIGGER_KEY,{type:'json',consistency:'strong'}).catch(()=>null);
  const payload={
    trigger:true,
    status:'pending',
    requestedAt:stamp,
    source:String(source||'manual'),
    jobId:active?.jobId||existing?.jobId||null
  };
  await store.setJSON(TRIGGER_KEY,payload);
  return payload;
}

export async function consumeBorrowRefreshTrigger(){
  const store=getDataStore();
  const trigger=await store.get(TRIGGER_KEY,{type:'json',consistency:'strong'}).catch(()=>null);
  return trigger?.trigger===true?trigger:null;
}

export async function readBorrowCache(){
  const store=getDataStore();
  const pointer=await store.get('scanner-borrow-pointer-v2',{type:'json',consistency:'strong'}).catch(()=>null);
  if(pointer?.key){
    const data=await store.get(pointer.key,{type:'json',consistency:'strong'}).catch(()=>null);
    if(data?.records)return data;
  }
  const current=await store.get('scanner-borrow-v2',{type:'json',consistency:'strong'}).catch(()=>null);
  if(current?.records)return current;
  const old=await store.get('scanner-borrow-v1',{type:'json',consistency:'strong'}).catch(()=>null);
  return old?.records?old:{version:2,records:{},updatedAt:null};
}

export async function getBorrowStatus(){
  return await getDataStore().get(STATUS_KEY,{type:'json',consistency:'strong'}).catch(()=>null);
}
