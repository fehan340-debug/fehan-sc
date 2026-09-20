import * as cheerio from 'cheerio';

const FINVIZ = 'https://finviz.com';

function parseNumber(value){
  if(value==null) return null;
  const s=String(value).replace(/\u00a0/g,' ').replace(/,/g,'').trim();
  const m=s.match(/(-?\d+(?:\.\d+)?)\s*(K|M|B|T)?/i);
  if(!m) return null;
  const n=Number(m[1]);
  if(!Number.isFinite(n)) return null;
  return n*({K:1e3,M:1e6,B:1e9,T:1e12}[String(m[2]||'').toUpperCase()]||1);
}

function clean(s){return String(s??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();}

function parseFinviz(html){
  const $=cheerio.load(String(html||''),{decodeEntities:true});
  let freeFloat=null;
  let price=null;
  let preMarket=null;
  let afterHours=null;

  // Finviz's quote page exposes "Shs Float" in the snapshot table.
  $('td').each((_,el)=>{
    if(freeFloat!=null)return;
    const label=clean($(el).text());
    if(/^Shs Float$/i.test(label) || /^Shares Float$/i.test(label)){
      freeFloat=parseNumber(clean($(el).next('td').text()));
    }
  });

  // Generic fallbacks for the current quote after Finviz's 2026 markup changes.
  const body=clean($('body').text());
  const priceMatch=body.match(/(?:^|\s)Price\s+([0-9]+(?:\.[0-9]+)?)/i);
  if(priceMatch)price=parseNumber(priceMatch[1]);

  $('[class],[id]').each((_,el)=>{
    const key=`${$(el).attr('class')||''} ${$(el).attr('id')||''}`.toLowerCase();
    const text=clean($(el).text());
    if(price==null && /(quote-price|quote-header.*price|quote.*price)/i.test(key)){
      const n=parseNumber(text);
      if(n!=null)price=n;
    }
    if(preMarket==null && /(pre.?market|premarket)/i.test(key)){
      const n=parseNumber(text); if(n!=null)preMarket=n;
    }
    if(afterHours==null && /(after.?hours|afterhours|post.?market)/i.test(key)){
      const n=parseNumber(text); if(n!=null)afterHours=n;
    }
  });

  return {freeFloat,price,preMarket,afterHours};
}

export async function fetchFinvizStockInfo(symbol,{signal}={}){
  const ticker=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9.\-]{1,15}$/.test(ticker))return {ok:false,reason:'invalid-symbol'};
  const url=`${FINVIZ}/quote.ashx?t=${encodeURIComponent(ticker)}`;
  const headers={
    'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    'accept-language':'en-US,en;q=0.8'
  };
  try{
    const r=await fetch(url,{signal,headers});
    const html=await r.text();
    if(!r.ok)return {ok:false,status:r.status,reason:`finviz-http-${r.status}`};
    const data=parseFinviz(html);
    if(data.freeFloat!=null || data.price!=null || data.preMarket!=null || data.afterHours!=null){
      return {ok:true,source:'finviz',status:r.status,...data};
    }
    return {ok:false,status:r.status,reason:'finviz-no-float-or-price'};
  }catch(e){
    if(e?.name==='AbortError')throw e;
    return {ok:false,status:0,reason:`finviz-request-failed: ${String(e?.message||e)}`};
  }
}
