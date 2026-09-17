import { getDataStore } from '../../lib.js';

const MASSIVE='https://api.massive.com';
const ALLOWED_EXCHANGES=new Set(['XNAS','XNYS','XASE']);
const EXCHANGE_NAMES={XNAS:'NASDAQ',XNYS:'NYSE',XASE:'NYSE American'};
function normalizeExchange(value){const v=String(value||'').trim().toUpperCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ');if(['XNAS','NASDAQ','NASDAQ GLOBAL SELECT MARKET','NASDAQ GLOBAL MARKET','NASDAQ CAPITAL MARKET'].includes(v))return 'XNAS';if(['XNYS','NYSE','NEW YORK STOCK EXCHANGE'].includes(v))return 'XNYS';if(['XASE','AMEX','NYSE AMERICAN','NYSEAMERICAN','NYSE ARCA','NYSE ARCA EXCHANGE','ARCA'].includes(v))return 'XASE';return '';}
const iso=d=>d.toISOString().slice(0,10);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const key=()=>String(process.env.MASSIVE_API_KEY||'').trim();

async function massive(path){
  const k=key();
  if(!k) throw new Error('MASSIVE_API_KEY غير مهيأ.');
  const sep=path.includes('?')?'&':'?';
  let last='';
  for(let i=0;i<4;i++){
    const r=await fetch(`${MASSIVE}${path}${sep}apiKey=${encodeURIComponent(k)}`,{headers:{accept:'application/json'}});
    const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{}
    if(r.ok)return d;
    last=`Massive HTTP ${r.status}: ${d.error||d.message||text.slice(0,180)}`;
    if((r.status===429||r.status>=500)&&i<3){await sleep(700*(i+1));continue;}
    throw new Error(last);
  }
  throw new Error(last||'Massive request failed.');
}

export async function refreshIpoCache(){
  const store=getDataStore();
  const startedAt=new Date().toISOString();
  await store.setJSON('scanner-ipo-status',{state:'building',startedAt,finishedAt:null,error:null,records:0,updatedAt:null});
  try{
    // IPOs have their own data lane. Fetch the complete pending set instead of
    // tying the filter to the hourly stock-split refresh or a narrow date query.
    const statuses=['pending','new'];
    const rows=[];
    for(const status of statuses){
      let next=`/vX/reference/ipos?ipo_status=${status}&order=asc&sort=listing_date&limit=1000`;
      while(next){
        const d=await massive(next);
        if(Array.isArray(d.results))rows.push(...d.results);
        if(!d.next_url)break;
        const u=new URL(d.next_url);u.searchParams.delete('apiKey');next=u.pathname+u.search;
      }
    }
    const today=new Date(); today.setHours(0,0,0,0);
    const end=new Date(today.getTime()+90*86400000);
    const names=EXCHANGE_NAMES;
    const unique=new Map();
    for(const x of rows){
      const ex=normalizeExchange(x?.primary_exchange||x?.exchange||x?.exchange_name);
      const listing=String(x?.listing_date||'').trim();
      if(!x?.ticker||!ALLOWED_EXCHANGES.has(ex)||!/^\d{4}-\d{2}-\d{2}$/.test(listing))continue;
      const dt=new Date(`${listing}T00:00:00`);
      if(!Number.isFinite(dt.getTime())||dt<today||dt>end)continue;
      const normalized={...x,primary_exchange:ex,exchange_name:names[ex]||ex,ipo_status:String(x?.ipo_status||'pending')};
      unique.set(`${String(x.ticker).toUpperCase()}|${listing}`,normalized);
    }
    const records=[...unique.values()].sort((a,b)=>String(a.listing_date||'').localeCompare(String(b.listing_date||''))||String(a.ticker||'').localeCompare(String(b.ticker||'')));
    if(!records.length) throw new Error('لم تُرجع خدمة الاكتتابات أي سجلات صالحة؛ تم الإبقاء على الكاش السابق دون مسحه.');
    const updatedAt=new Date().toISOString();
    console.info('[ipo-refresh] scraped=',rows.length,'saved=',records.length);
    const payload={version:1,source:'massive-ipo-daily',ready:true,updatedAt,windowDays:90,records};
    await store.setJSON('scanner-ipo-v1',payload);
    await store.setJSON('scanner-ipo-status',{state:'ready',startedAt:null,finishedAt:updatedAt,error:null,records:records.length,updatedAt});
    return payload;
  }catch(e){
    const message=String(e?.message||e||'IPO refresh failed');
    console.error('[ipo-refresh] failed; previous cache retained',message);
    await store.setJSON('scanner-ipo-status',{state:'error',startedAt:null,finishedAt:new Date().toISOString(),error:message,records:0,updatedAt:null,cacheRetained:true});
    throw e;
  }
}

export async function readIpoCache(){
  const data=await getDataStore().get('scanner-ipo-v1',{type:'json',consistency:'strong'}).catch(()=>null);
  return data?.ready&&Array.isArray(data.records)?data:null;
}
