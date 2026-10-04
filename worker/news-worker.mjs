import { store } from './store.mjs';

const NEWS_KEY = 'scanner-news-v1';
const NEWS_TICKER_PREFIX = 'scanner-news-ticker-v2:';
const STATUS_KEY = 'scanner-news-status';
const CACHE_KEY = 'scanner-cache-v1';
const POINTER_KEY = 'scanner-cache-pointer-v2';
const SCRAPE_URL = 'https://api.scrapingant.com/v2/general';
const INVESTING_SEARCH = 'https://sa.investing.com/search/?q=';
const INITIAL_MAX_PAGES = 4;
const INCREMENTAL_MAX_PAGES = 2;

const env = name => String(process.env[name] || '').trim();
const cleanTicker = v => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stripHtml(s){return String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();}
function absoluteUrl(href){try{return new URL(href,'https://sa.investing.com').toString();}catch{return null;}}
function parseDate(text){
  const s=String(text||'');
  const months={يناير:0,فبراير:1,مارس:2,أبريل:3,ابريل:3,مايو:4,يونيو:5,يوليو:6,أغسطس:7,اغسطس:7,سبتمبر:8,أكتوبر:9,اكتوبر:9,نوفمبر:10,ديسمبر:11,January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11};
  let m=s.match(/(?:•|\|)\s*(\d{1,2})\s+([\u0600-\u06FF]+|[A-Za-z]+)\s+(\d{4})/);
  if(m&&months[m[2]]!==undefined)return new Date(Date.UTC(Number(m[3]),months[m[2]],Number(m[1]),12));
  m=s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/); if(m)return new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),12));
  m=s.match(/(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/); if(m)return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),12));
  return null;
}
function classifyImpact(text){
  const s=String(text||'').toLowerCase();
  const p=[/ارتفاع|يرتفع|صعد|يصعد|قفز|مكاسب|نمو|أرباح قياسية|تفوق التوقعات|رفع السعر المستهدف|ترقية|شراء|استحواذ|موافقة|إطلاق|إيرادات قياسية|زيادة التوقعات|ارتفاع الطلب/,/surge|rises?|jumps?|gains?|growth|record profit|beats? estimates?|raises? target|upgrade|buy|acquisition|approval|launch|record revenue|raises? guidance|strong demand/];
  const n=[/انخفاض|ينخفض|هبط|يهبط|تراجع|خسائر|هبوط|خفض السعر المستهدف|تخفيض|بيع|تحذير|دعاوى|غرامة|رفض|تسريح|خفض التوقعات|انخفاض الطلب/,/falls?|drops?|declines?|loss|downturn|cuts? target|downgrade|sell|warning|lawsuit|fine|rejection|layoffs|cuts? guidance|weak demand/];
  const pc=p.filter(r=>r.test(s)).length,nc=n.filter(r=>r.test(s)).length;
  return pc>nc&&pc>0?'إيجابي':nc>pc&&nc>0?'سلبي':'محايد';
}
async function scrape(url,{browser=false}={}){
  const key=env('SCRAPINGANT_API_KEY'); if(!key)throw new Error('Missing SCRAPINGANT_API_KEY');
  const qs=new URLSearchParams({url,browser:String(browser)});
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(`${SCRAPE_URL}?${qs}`,{headers:{'x-api-key':key,accept:'application/json'}});const text=await r.text();
    if(r.ok){try{const j=JSON.parse(text);return String(j.content||j.html||'');}catch{return text;}}
    if([403,409,429,500,502,503,504].includes(r.status)&&attempt<3){await sleep(1200*(attempt+1));continue;}
    throw new Error(`ScrapingAnt HTTP ${r.status}: ${text.slice(0,220)}`);
  }
  throw new Error('ScrapingAnt failed');
}
function companyTokens(row={}){
  const raw=String(row?.name||row?.companyName||row?.company_name||'').trim();
  return raw
    .replace(/\b(adr|ads|corp|corporation|inc|incorporated|ltd|limited|plc|co|company|class|common|shares?|stock)\b/gi,' ')
    .split(/[^A-Za-z0-9\u0600-\u06FF]+/)
    .map(x=>x.trim().toLowerCase())
    .filter(x=>x.length>=3);
}
function companyArticleMatches(article,ticker,row={}){
  const t=cleanTicker(ticker).toLowerCase();
  const hay=`${String(article?.title||'')} ${String(article?.summary||'')}`.toLowerCase();
  // Investing's company tab is the primary source. This second gate is a hard
  // safety filter so general market/gold/index articles can never enter the
  // ticker cache if Investing serves the broader news list to the scraper.
  const tickerHit=Boolean(t && hay.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).includes(t.toUpperCase()));
  if(tickerHit)return true;
  const tokens=companyTokens(row);
  const hits=tokens.filter(tok=>hay.includes(tok));
  return hits.length>=2;
}
async function findInvestingNewsUrl(ticker,row={}){
  const searchUrl=INVESTING_SEARCH+encodeURIComponent(ticker);
  let html=await scrape(searchUrl);
  let links=[...html.matchAll(/href=["'](\/equities\/[^"']+)["']/gi)].map(m=>m[1].split('#')[0].split('?')[0]);
  if(!links.length) { html=await scrape(searchUrl,{browser:true}); links=[...html.matchAll(/href=["'](\/equities\/[^"']+)["']/gi)].map(m=>m[1].split('#')[0].split('?')[0]); }
  const unique=[...new Set(links)];
  const chosen=unique.find(x=>/-news(?:[\/]|$)/i.test(x))||unique.find(x=>/\/equities\//i.test(x));
  if(!chosen)return null;
  let path=chosen.replace(/-company-profile$/i,'-news').replace(/\/$/,'');
  if(!/-news(?:\/\d+)?$/i.test(path))path+='-news';
  // Investing exposes the stock-news tabs from the same company-news route.
  // Explicitly select the Company tab instead of the default Recent/market mix.
  const u=new URL(absoluteUrl(path));
  u.searchParams.set('tab','company');
  return u.toString();
}
function extractArticles(html,{ticker,row}={}){
  const out=new Map(),re=/<a[^>]+href=["'](\/news\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let sourceOrder=0;
  for(const m of html.matchAll(re)){
    const url=absoluteUrl(m[1]),title=stripHtml(m[2]);if(!url||!title||title.length<8)continue;
    if(/^(أخبار|تحليلات|المزيد|قراءة المزيد|إعلانات)$/i.test(title))continue;
    const idx=m.index??0,around=stripHtml(html.slice(Math.max(0,idx-180),Math.min(html.length,idx+2200)));
    const dt=parseDate(around),sourceMatch=around.match(/(?:بواسطة|By)\s*([^•|]{2,80})/i),source=sourceMatch?sourceMatch[1].trim():'Investing.com';
    let summary=around.replace(title,'').replace(/^(?:بواسطة|By)\s*[^•|]+[•|]?/i,'').replace(/^[-•|\s]+/,'').trim().slice(0,520);
    const article={url,title,summary,publishedDate:dt?dt.toISOString().slice(0,10):null,source,sourceOrder:sourceOrder++};
    if(!companyArticleMatches(article,ticker,row))continue;
    const key=url.split('?')[0];
    if(!out.has(key))out.set(key,article);
  }
  return [...out.values()];
}
function pageUrl(base,page){
  if(page<=1)return base;
  const u=new URL(base);
  u.pathname=u.pathname.replace(/\/$/,'')+'/'+page;
  return u.toString();
}
function toNewsItem(a,page=1){return{id:Buffer.from(a.url).toString('base64url').slice(0,64),url:a.url,title:a.title,titleAr:a.title,summary:a.summary,summaryAr:a.summary,source:a.source||'Investing.com',publishedAt:a.publishedDate,language:'ar',impactAr:classifyImpact(`${a.title} ${a.summary}`),sourceOrder:(Number(page)||1)*100000+(Number(a.sourceOrder)||0),addedAt:new Date().toISOString()};}
function sortNews(items){
  return [...items].sort((a,b)=>{
    const dateCmp=String(b?.publishedAt||'').localeCompare(String(a?.publishedAt||''));
    if(dateCmp)return dateCmp;
    const ao=Number(a?.sourceOrder),bo=Number(b?.sourceOrder);
    if(Number.isFinite(ao)&&Number.isFinite(bo)&&ao!==bo)return ao-bo;
    const at=Date.parse(String(a?.addedAt||'')),bt=Date.parse(String(b?.addedAt||''));
    if(Number.isFinite(at)&&Number.isFinite(bt)&&at!==bt)return bt-at;
    return String(a?.url||'').localeCompare(String(b?.url||''));
  });
}
async function loadTickerCache(ticker){return await store.get(`${NEWS_TICKER_PREFIX}${ticker}`).catch(()=>null);}
function normalizeSeed(old){return old&&typeof old==='object'?old:null;}
function buildTickerRecord(ticker,row,map,newsUrl,cutoff,extra={}){
  const news=sortNews([...map.values()].filter(x=>{
    const published=String(x?.publishedAt||'');
    if(!published)return true;
    const d=new Date(published+'T12:00:00Z');
    return Number.isFinite(d.getTime())&&d>=cutoff;
  }));
  const datedNews=news.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x?.publishedAt||'')));
  const coverageStart=datedNews.length?datedNews.reduce((m,x)=>!m||x.publishedAt<m?x.publishedAt:m,''):null;
  const complete=Boolean(coverageStart&&new Date(coverageStart+'T12:00:00Z')<=cutoff);
  return{ticker,name:row?.name||row?.companyName||'',newsUrl,news,coverageStart,coverageEnd:news[0]?.publishedAt||null,coverageComplete:complete,initialized:Boolean(newsUrl),...extra,updatedAt:new Date().toISOString()};
}
async function collectTicker(ticker,row,seed,cutoff,isInitial,{onPageSaved}={}){
  const old=normalizeSeed(seed),existingNews=Array.isArray(old?.news)?old.news:[];
  const companyName=row?.name||row?.companyName||row?.company_name||'';
  const oldCompanyNews=existingNews.filter(x=>companyArticleMatches({title:x?.title,summary:x?.summary},ticker,row));
  let newsUrl=old?.newsUrl||null;
  if(newsUrl){
    try{const u=new URL(newsUrl);u.searchParams.set('tab','company');newsUrl=u.toString();}catch{newsUrl=null;}
  }
  if(!newsUrl)newsUrl=await findInvestingNewsUrl(ticker,row);
  if(!newsUrl){
    const preserved=existingNews.length||old?.initialized?buildTickerRecord(ticker,row,new Map(oldCompanyNews.filter(x=>x?.url).map(x=>[x.url,x])),old?.newsUrl||null,cutoff,{coverageStart:old?.coverageStart||null,coverageEnd:old?.coverageEnd||null,coverageComplete:Boolean(old?.coverageComplete),nextInitialPage:Number(old?.nextInitialPage||1),error:'لم يتم العثور على صفحة أخبار Investing.com لهذا السهم.'}):{ticker,name:row?.name||row?.companyName||'',news:[],newsUrl:null,initialized:false,coverageStart:null,coverageEnd:null,coverageComplete:false,nextInitialPage:1,error:'لم يتم العثور على صفحة أخبار Investing.com لهذا السهم.',updatedAt:new Date().toISOString()};
    return preserved;
  }
  const map=new Map(oldCompanyNews.filter(x=>x?.url).map(x=>[x.url,x]));
  const lastKnown=oldCompanyNews.reduce((m,x)=>{const d=String(x?.publishedAt||'');return d>m?d:m;},'');
  let pages=0,addedCount=0,oldestSeen=null,reachedCutoff=false,reachedExisting=false,pageError=null;
  const maxPages=isInitial?INITIAL_MAX_PAGES:INCREMENTAL_MAX_PAGES;
  const startPage=isInitial?Math.max(1,Number(seed?.nextInitialPage||1)):1;
  for(let offset=0;offset<maxPages;offset++){
    const page=startPage+offset;
    let articles=[];
    try{
      let html=await scrape(pageUrl(newsUrl,page));
      articles=extractArticles(html,{ticker,row});
      if(!articles.length){html=await scrape(pageUrl(newsUrl,page),{browser:true});articles=extractArticles(html,{ticker,row});}
    }catch(e){pageError=String(e?.message||e);break;}
    if(!articles.length)break;
    pages++;
    let pageOld=0,pageExisting=0;
    for(const a of articles){
      if(!a.publishedDate){
        if(!map.has(a.url)){map.set(a.url,toNewsItem(a,page));addedCount++;}
        continue;
      }
      if(!oldestSeen||a.publishedDate<oldestSeen)oldestSeen=a.publishedDate;
      const articleDate=new Date(a.publishedDate+'T12:00:00Z');
      if(articleDate<cutoff){pageOld++;continue;}
      if(map.has(a.url)){if(!isInitial&&lastKnown&&a.publishedDate<=lastKnown)pageExisting++;continue;}
      if(!isInitial&&lastKnown&&a.publishedDate<lastKnown){pageExisting++;continue;}
      map.set(a.url,toNewsItem(a,page));addedCount++;
    }
    if(isInitial){
      if(pageOld>=Math.max(2,Math.floor(articles.length*0.4)))reachedCutoff=true;
    }else if(lastKnown&&pageExisting>=Math.max(2,Math.floor(articles.length*0.4)))reachedExisting=true;
    const interimComplete=Boolean([...map.values()].some(x=>{const d=String(x?.publishedAt||'');return /^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d+'T12:00:00Z')<=cutoff;}));
    const interim=buildTickerRecord(ticker,row,map,newsUrl,cutoff,{addedCount,pagesFetched:pages,initialized:true,nextInitialPage:isInitial&&!interimComplete?(page+1):1,oldestSeen,error:null});
    if(typeof onPageSaved==='function')await onPageSaved(interim);
    if(reachedCutoff||reachedExisting)break;
  }
  const final=buildTickerRecord(ticker,row,map,newsUrl,cutoff,{addedCount,pagesFetched:pages,initialized:true,nextInitialPage:isInitial&&!reachedCutoff&&!pageError?(startPage+pages):isInitial&&!reachedCutoff?startPage+pages:1,oldestSeen,error:pageError||null});
  if(typeof onPageSaved==='function'&&pages===0)await onPageSaved(final);
  return final;
}
function todayET(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function atMarketOpenET(){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const h=Number(p.find(x=>x.type==='hour')?.value),m=Number(p.find(x=>x.type==='minute')?.value);return h===9&&m>=25&&m<=45;}
async function readCentralCache(){const pointer=await store.get(POINTER_KEY).catch(()=>null);if(pointer?.key){const d=await store.get(pointer.key).catch(()=>null);if(d?.ready&&Array.isArray(d.records))return d;}return await store.get(CACHE_KEY)||{};}
async function readModelAutoEnabled(){const settings=await store.getSiteSettings().catch(()=>null);return settings?.auto_update_enabled!==false&&settings?.newsAutoUpdateEnabled!==false;}
function manifestEntry(r){
  return{ticker:r.ticker,name:r.name,newsUrl:r.newsUrl,newsCount:Array.isArray(r.news)?r.news.length:0,coverageStart:r.coverageStart,coverageEnd:r.coverageEnd,coverageComplete:Boolean(r.coverageComplete),initialized:Boolean(r.initialized),updatedAt:r.updatedAt,error:r.error||null};
}
async function saveNewsManifest(records,date){
  const payload={version:2,ready:true,date,updatedAt:new Date().toISOString(),universeTickers:records.length,records:records.sort((a,b)=>a.ticker.localeCompare(b.ticker)),source:'Investing.com-ar-via-ScrapingAnt',lookbackDays:183,storage:'per-ticker'};
  await store.setJSON(NEWS_KEY,payload);
  return payload;
}
export async function runNews({force=false}={}){
  const today=todayET();
  if(!force&&!await readModelAutoEnabled())return{ok:true,skipped:true,reason:'news-automatic-updates-disabled',date:today};
  const cache=await readCentralCache(),rows=Array.isArray(cache?.records)?cache.records:[],byTicker=new Map(rows.map(x=>[cleanTicker(x?.ticker),x])),tickers=[...byTicker.keys()].filter(Boolean);
  if(!tickers.length)return{ok:false,error:'لا توجد أسهم في الكاش المركزي.'};
  const previous=await store.get(NEWS_KEY).catch(()=>null)||{version:2,records:[]},oldRecords=Array.isArray(previous.records)?previous.records:[],oldMap=new Map(oldRecords.map(x=>[cleanTicker(x?.ticker),x]));
  const hasNewTicker=tickers.some(t=>!oldMap.has(t));
  const existingStatus=await store.get(STATUS_KEY).catch(()=>null);
  if(!force&&existingStatus?.date===today&&existingStatus?.state==='ready'&&!hasNewTicker)return{ok:true,skipped:true,reason:'already-completed-today',date:today};
  if(!force&&!atMarketOpenET())return{ok:true,skipped:true,reason:'not-market-open-window',date:today};
  const cutoff=new Date(Date.now()-183*86400000);
  let processed=0,initial=0,incremental=0,failed=0,added=0,incomplete=0;
  const currentSet=new Set(tickers);
  const liveManifest=new Map();
  for(const ticker of tickers){
    const old=oldMap.get(ticker);if(old)liveManifest.set(ticker,old);
  }
  // Publish the current universe immediately, so the page is never empty while the worker runs.
  await saveNewsManifest([...liveManifest.values()],today);
  await store.setJSON(STATUS_KEY,{state:'collecting',date:today,total:tickers.length,processed:0,initial:0,incremental:0,failed:0,added:0,incomplete:0});

  for(const ticker of tickers){
    const row=byTicker.get(ticker)||{};
    const oldManifest=oldMap.get(ticker)||{};
    const oldTicker=await loadTickerCache(ticker);
    const seed=oldTicker||oldManifest;
    const isInitial=!seed?.initialized||!seed?.coverageComplete||!seed?.coverageStart||new Date(String(seed.coverageStart)+'T12:00:00Z')>cutoff;
    let tickerHadError=false;
    try{
      const r=await collectTicker(ticker,row,seed,cutoff,isInitial,{onPageSaved:async snapshot=>{
        // Every successfully scraped page is written immediately. If the Action is
        // cancelled after this point, the already collected news is still preserved.
        await store.setJSON(`${NEWS_TICKER_PREFIX}${ticker}`,snapshot);
        liveManifest.set(ticker,manifestEntry(snapshot));
        await saveNewsManifest([...liveManifest.values()],today);
      }});
      // The final snapshot is also written even when no page was successfully fetched.
      await store.setJSON(`${NEWS_TICKER_PREFIX}${ticker}`,r);
      liveManifest.set(ticker,manifestEntry(r));
      await saveNewsManifest([...liveManifest.values()],today);
      if(isInitial)initial++;else incremental++;
      added+=Number(r.addedCount||0);
      if(isInitial&&!r.coverageComplete)incomplete++;
      if(r.error)tickerHadError=true;
      if(tickerHadError)failed++;
    }catch(e){
      failed++;
      // Never replace an existing ticker cache with an empty result after an error.
      // Preserve whatever was already stored, including pages saved earlier in this run.
      const preserved=await loadTickerCache(ticker)||oldTicker||oldManifest;
      if(preserved&&typeof preserved==='object'){
        const kept={...preserved,ticker,name:preserved.name||row?.name||row?.companyName||'',error:String(e?.message||e),updatedAt:new Date().toISOString()};
        await store.setJSON(`${NEWS_TICKER_PREFIX}${ticker}`,kept);
        liveManifest.set(ticker,manifestEntry(kept));
      }else{
        liveManifest.set(ticker,{ticker,name:row?.name||row?.companyName||'',newsUrl:null,newsCount:0,coverageStart:null,coverageEnd:null,coverageComplete:false,initialized:false,updatedAt:new Date().toISOString(),error:String(e?.message||e)});
      }
      await saveNewsManifest([...liveManifest.values()],today);
      incomplete++;
    }
    processed++;
    await store.setJSON(STATUS_KEY,{state:'collecting',date:today,total:tickers.length,processed,initial,incremental,failed,added,incomplete,universeTickers:liveManifest.size});
  }

  // Remove news cache only for stocks that are no longer in the central universe.
  for(const old of oldRecords){
    const t=cleanTicker(old?.ticker);
    if(t&&!currentSet.has(t)){
      await store.delete(`${NEWS_TICKER_PREFIX}${t}`).catch(()=>{});
      liveManifest.delete(t);
    }
  }
  const payload=await saveNewsManifest([...liveManifest.values()].filter(x=>currentSet.has(cleanTicker(x?.ticker))),today);
  const finalState=failed===tickers.length?'error':(failed>0||incomplete>0?'partial':'ready');
  await store.setJSON(STATUS_KEY,{state:finalState,date:today,completedAt:payload.updatedAt,total:tickers.length,processed,initial,incremental,failed,added,incomplete,universeTickers:payload.universeTickers});
  return{ok:true,date:today,total:tickers.length,processed,initial,incremental,failed,added,incomplete};
}
runNews({force:env('FORCE_NEWS_RUN')==='true'}).then(r=>{console.log(JSON.stringify(r,null,2));if(!r?.ok&&!r?.skipped)process.exit(1);}).catch(e=>{console.error(e);process.exit(1);});
