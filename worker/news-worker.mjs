import { store } from './store.mjs';

const NEWS_KEY = 'scanner-news-v1';
const STATUS_KEY = 'scanner-news-status';
const CACHE_KEY = 'scanner-cache-v1';
const POINTER_KEY = 'scanner-cache-pointer-v2';
const SCRAPE_URL = 'https://api.scrapingant.com/v2/general';
const INVESTING_SEARCH = 'https://sa.investing.com/search/?q=';
const INITIAL_MAX_PAGES = 40;

const env = name => String(process.env[name] || '').trim();
const cleanTicker = v => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stripHtml(s){return String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();}
function absoluteUrl(href){try{return new URL(href,'https://sa.investing.com').toString();}catch{return null;}}
function parseDate(text, fallback){
  const s=String(text||'');
  const months={يناير:0,فبراير:1,مارس:2,أبريل:3,ابريل:3,مايو:4,يونيو:5,يوليو:6,أغسطس:7,اغسطس:7,سبتمبر:8,أكتوبر:9,اكتوبر:9,نوفمبر:10,ديسمبر:11,January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11};
  let m=s.match(/(?:•|\|)\s*(\d{1,2})\s+([\u0600-\u06FF]+|[A-Za-z]+)\s+(\d{4})/);
  if(m&&months[m[2]]!==undefined)return new Date(Date.UTC(Number(m[3]),months[m[2]],Number(m[1]),12));
  m=s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/); if(m)return new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),12));
  m=s.match(/(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/); if(m)return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),12));
  if(/منذ\s+(?:دقيقة|دقائق|ساعة|ساعتين|يوم|أيام)|منذ\s+\d+/i.test(s)||/\b(?:hour|hours|minute|minutes|day|days) ago\b/i.test(s))return fallback;
  return null;
}
function classifyImpact(text){
  const s=String(text||'').toLowerCase();
  const p=[/ارتفاع|يرتفع|صعد|يصعد|قفز|مكاسب|نمو|أرباح قياسية|تفوق التوقعات|رفع السعر المستهدف|ترقية|شراء|استحواذ|موافقة|إطلاق|إيرادات قياسية|زيادة التوقعات|ارتفاع الطلب/,/surge|rises?|jumps?|gains?|growth|record profit|beats? estimates?|raises? target|upgrade|buy|acquisition|approval|launch|record revenue|raises? guidance|strong demand/];
  const n=[/انخفاض|ينخفض|هبط|يهبط|تراجع|خسائر|هبوط|خفض السعر المستهدف|تخفيض|بيع|تحذير|دعاوى|غرامة|رفض|تسريح|خفض التوقعات|انخفاض الطلب/,/falls?|drops?|declines?|loss|downturn|cuts? target|downgrade|sell|warning|lawsuit|fine|rejection|layoffs|cuts? guidance|weak demand/];
  const pc=p.filter(r=>r.test(s)).length,nc=n.filter(r=>r.test(s)).length;
  return pc>nc&&pc>0?'إيجابي':nc>pc&&nc>0?'سلبي':'محايد';
}
async function scrape(url){
  const key=env('SCRAPINGANT_API_KEY'); if(!key)throw new Error('Missing SCRAPINGANT_API_KEY');
  const qs=new URLSearchParams({url,browser:'true'});
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(`${SCRAPE_URL}?${qs}`,{headers:{'x-api-key':key,accept:'application/json'}});const text=await r.text();
    if(r.ok){try{const j=JSON.parse(text);return String(j.content||j.html||'');}catch{return text;}}
    if([403,409,429,500,502,503,504].includes(r.status)&&attempt<3){await sleep(1200*(attempt+1));continue;}
    throw new Error(`ScrapingAnt HTTP ${r.status}: ${text.slice(0,220)}`);
  }
  throw new Error('ScrapingAnt failed');
}
async function findInvestingNewsUrl(ticker){
  const html=await scrape(INVESTING_SEARCH+encodeURIComponent(ticker));
  const links=[...html.matchAll(/href=["'](\/equities\/[^"']+)["']/gi)].map(m=>m[1].split('#')[0].split('?')[0]);
  const chosen=links.find(x=>/-news(?:[\/?]|$)/i.test(x))||links.find(x=>/\/equities\//i.test(x));
  if(!chosen)return null;
  let path=chosen.replace(/-company-profile$/i,'-news').replace(/\/$/,'');
  if(!/-news(?:\/\d+)?$/i.test(path))path+='-news';
  return absoluteUrl(path);
}
function extractArticles(html,fallbackDate){
  const out=new Map(),re=/<a[^>]+href=["'](\/news\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for(const m of html.matchAll(re)){
    const url=absoluteUrl(m[1]),title=stripHtml(m[2]);if(!url||!title||title.length<8)continue;
    if(/^(أخبار|تحليلات|المزيد|قراءة المزيد|إعلانات)$/i.test(title))continue;
    const idx=m.index??0,around=stripHtml(html.slice(Math.max(0,idx-180),Math.min(html.length,idx+1800)));
    const dt=parseDate(around,fallbackDate),sourceMatch=around.match(/(?:بواسطة|By)\s*([^•|]{2,80})/i),source=sourceMatch?sourceMatch[1].trim():'Investing.com';
    let summary=around.replace(title,'').replace(/^(?:بواسطة|By)\s*[^•|]+[•|]?/i,'').replace(/^[-•|\s]+/,'').trim().slice(0,520);
    const key=url.split('?')[0];if(!out.has(key))out.set(key,{url,title,summary,publishedDate:(dt||fallbackDate).toISOString().slice(0,10),source});
  }
  return [...out.values()];
}
function pageUrl(base,page){return page<=1?base:base.replace(/\/$/,'')+'/'+page;}
async function collectTicker(ticker,row,old,cutoff,isInitial){
  let newsUrl=old?.newsUrl||null;if(!newsUrl)newsUrl=await findInvestingNewsUrl(ticker);
  if(!newsUrl)return{...old,ticker,name:row?.name||row?.companyName||'',news:Array.isArray(old?.news)?old.news:[],newsUrl:null,error:'لم يتم العثور على صفحة أخبار Investing.com لهذا السهم.',updatedAt:new Date().toISOString()};
  const map=new Map((Array.isArray(old?.news)?old.news:[]).map(x=>[x.url,x]));const fallback=new Date();let pages=0,addedCount=0;
  for(let page=1;page<=(isInitial?INITIAL_MAX_PAGES:1);page++){
    const html=await scrape(pageUrl(newsUrl,page)),articles=extractArticles(html,fallback);pages++;if(!articles.length)break;let oldEnough=0;
    for(const a of articles){const d=new Date(a.publishedDate+'T12:00:00Z');if(d<cutoff){oldEnough++;continue;}if(map.has(a.url))continue;
      const impact=classifyImpact(`${a.title} ${a.summary}`);map.set(a.url,{id:Buffer.from(a.url).toString('base64url').slice(0,64),url:a.url,title:a.title,titleAr:a.title,summary:a.summary,summaryAr:a.summary,source:a.source||'Investing.com',publishedAt:a.publishedDate,language:'ar',impactAr:impact,addedAt:new Date().toISOString()});addedCount++;
    }
    if(!isInitial||oldEnough>=Math.max(3,Math.floor(articles.length*0.6)))break;
  }
  const news=[...map.values()].filter(x=>{const d=new Date(String(x.publishedAt||'')+'T12:00:00Z');return Number.isFinite(d.getTime())&&d>=cutoff;}).sort((a,b)=>String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return{ticker,name:row?.name||row?.companyName||'',newsUrl,news,addedCount,pagesFetched:pages,updatedAt:new Date().toISOString()};
}
function todayET(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function atMarketOpenET(){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const h=Number(p.find(x=>x.type==='hour')?.value),m=Number(p.find(x=>x.type==='minute')?.value);return h===9&&m>=25&&m<=45;}
async function readCentralCache(){const pointer=await store.get(POINTER_KEY).catch(()=>null);if(pointer?.key){const d=await store.get(pointer.key).catch(()=>null);if(d?.ready&&Array.isArray(d.records))return d;}return await store.get(CACHE_KEY)||{};}
export async function runNews({force=false}={}){
  const today=todayET();
  const cache=await readCentralCache(),rows=Array.isArray(cache?.records)?cache.records:[],byTicker=new Map(rows.map(x=>[cleanTicker(x?.ticker),x])),tickers=[...byTicker.keys()].filter(Boolean);
  if(!tickers.length)return{ok:false,error:'لا توجد أسهم في الكاش المركزي.'};
  const previous=await store.get(NEWS_KEY).catch(()=>null)||{version:1,records:[]},oldRecords=Array.isArray(previous.records)?previous.records:[],oldMap=new Map(oldRecords.map(x=>[cleanTicker(x?.ticker),x])),hasNewTicker=tickers.some(t=>!oldMap.has(t));
  const existingStatus=await store.get(STATUS_KEY).catch(()=>null);
  if(!force&&existingStatus?.date===today&&existingStatus?.state==='ready'&&!hasNewTicker)return{ok:true,skipped:true,reason:'already-completed-today',date:today};
  if(!force&&!atMarketOpenET())return{ok:true,skipped:true,reason:'not-market-open-window',date:today};
  const cutoff=new Date(Date.now()-183*86400000);
  // Fetch several tickers concurrently. The old implementation awaited every
  // ticker serially, so one slow ScrapingAnt/Investing.com request blocked the
  // entire universe and made the UI appear to finish roughly one stock every
  // couple of minutes. Keep a bounded pool so we are faster without creating
  // an uncontrolled burst against the scraper.
  const NEWS_CONCURRENCY=Math.max(1,Math.min(8,Number(env('NEWS_CONCURRENCY'))||6));
  const records=[];let nextIndex=0,processed=0,initial=0,incremental=0,failed=0,added=0;
  await store.setJSON(STATUS_KEY,{state:'collecting',date:today,total:tickers.length,processed:0,initial:0,incremental:0,failed:0,added:0,concurrency:NEWS_CONCURRENCY});

  const worker=async()=>{
    while(true){
      const i=nextIndex++;
      if(i>=tickers.length)return;
      const ticker=tickers[i],row=byTicker.get(ticker)||{},old=oldMap.get(ticker);
      try{
        const isInitial=!old||!Array.isArray(old.news)||!old.news.length;
        const r=await collectTicker(ticker,row,old,cutoff,isInitial);
        records.push(r);
        if(isInitial)initial++;else incremental++;
        added+=Number(r.addedCount||0);
      }catch(e){
        failed++;
        records.push({...old,ticker,name:row?.name||row?.companyName||'',news:Array.isArray(old?.news)?old.news:[],error:String(e?.message||e),updatedAt:new Date().toISOString()});
      }
      processed++;
      await store.setJSON(STATUS_KEY,{state:'collecting',date:today,total:tickers.length,processed,initial,incremental,failed,added,concurrency:NEWS_CONCURRENCY});
    }
  };
  await Promise.all(Array.from({length:Math.min(NEWS_CONCURRENCY,tickers.length)},worker));
  const payload={version:1,ready:true,date:today,updatedAt:new Date().toISOString(),universeTickers:records.length,records:records.sort((a,b)=>a.ticker.localeCompare(b.ticker)),source:'Investing.com-ar-via-ScrapingAnt',lookbackDays:183};await store.setJSON(NEWS_KEY,payload);await store.setJSON(STATUS_KEY,{state:'ready',date:today,completedAt:payload.updatedAt,total:tickers.length,processed,initial,incremental,failed,added,universeTickers:records.length});return{ok:true,date:today,total:tickers.length,processed,initial,incremental,failed,added};
}
runNews({force:env('FORCE_NEWS_RUN')==='true'}).then(r=>{console.log(JSON.stringify(r,null,2));if(!r?.ok&&!r?.skipped)process.exit(1);}).catch(e=>{console.error(e);process.exit(1);});
