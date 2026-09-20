import * as cheerio from 'cheerio';

const FINVIZ='https://finviz.com';
const SCRAPINGANT='https://api.scrapingant.com/v2/general';

function parseNumber(value){
  if(value==null)return null;
  const s=String(value).replace(/\u00a0/g,' ').replace(/,/g,'').trim();
  const m=s.match(/(-?\d+(?:\.\d+)?)\s*(K|M|B|T)?/i);
  if(!m)return null;
  const n=Number(m[1]);
  if(!Number.isFinite(n))return null;
  return n*({K:1e3,M:1e6,B:1e9,T:1e12}[String(m[2]||'').toUpperCase()]||1);
}
function clean(s){return String(s??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();}

function parseFinviz(html){
  const $=cheerio.load(String(html||''),{decodeEntities:true});
  let freeFloat=null;
  $('td').each((_,el)=>{
    if(freeFloat!=null)return;
    const label=clean($(el).text());
    if(/^Shs Float$/i.test(label)||/^Shares Float$/i.test(label)||/^Float$/i.test(label)){
      freeFloat=parseNumber(clean($(el).next('td').text()));
    }
  });
  if(freeFloat==null){
    const body=clean($('body').text());
    const m=body.match(/(?:Shs\s*Float|Shares\s*Float|Free\s*Float)\s+([0-9.,]+\s*[KMBT]?)/i);
    if(m)freeFloat=parseNumber(m[1]);
  }
  return {freeFloat};
}

export async function fetchFinvizStockInfo(symbol,{signal}={}){
  const ticker=String(symbol||'').trim().toUpperCase();
  const key=String(process.env.SCRAPINGANT_API_KEY||'').trim();
  if(!/^[A-Z0-9.\-]{1,15}$/.test(ticker))return {ok:false,reason:'invalid-symbol'};
  if(!key)return {ok:false,reason:'missing-scrapingant-key'};

  const target=`${FINVIZ}/quote.ashx?t=${encodeURIComponent(ticker)}`;
  const qs=new URLSearchParams({url:target,'x-api-key':key,browser:'false',timeout:'15'});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  const abortExternal=()=>controller.abort();
  if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',abortExternal,{once:true});}
  try{
    const r=await fetch(`${SCRAPINGANT}?${qs.toString()}`,{signal:controller.signal,headers:{accept:'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','user-agent':'Mozilla/5.0 (compatible; NASDAQ-Scanner/1.0)'}});
    const html=await r.text();
    if(!r.ok)return {ok:false,status:r.status,reason:`scrapingant-http-${r.status}`};
    const data=parseFinviz(html);
    if(data.freeFloat!=null)return {ok:true,source:'finviz-scrapingant',status:r.status,...data};
    return {ok:false,status:r.status,reason:'finviz-no-free-float'};
  }catch(e){
    if(e?.name==='AbortError')throw e;
    return {ok:false,status:0,reason:`scrapingant-request-failed: ${String(e?.message||e)}`};
  }finally{
    clearTimeout(timer);
    if(signal)signal.removeEventListener('abort',abortExternal);
  }
}
