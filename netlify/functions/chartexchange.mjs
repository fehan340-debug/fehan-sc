import { json, requireUser, getDataStore } from "../../lib.js";
import * as cheerio from "cheerio";

const SYMBOL_RE = /^[A-Z0-9.\-]{1,15}$/;
const CE = "https://chartexchange.com";

function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let x = String(v).trim()
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, "")
    .replace(/,/g, "");
  const m = x.match(/^\(?(-?[0-9]+(?:\.[0-9]+)?)(K|M|B|T)?\)?%?$/i);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return n * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(m[2] || "").toUpperCase()] || 1);
  }
  const n = Number(x.replace(/[()%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function cleanHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

function stripHtml(s) {
  return cleanHtml(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function csvRows(text) {
  const lines = String(text || "").split(/\r?\n/).filter(x => x.trim());
  if (lines.length < 2) return [];
  const parse = line => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const headers = parse(lines[0]).map(x => x.trim());
  return lines.slice(1).map(line => {
    const vals = parse(line), o = {};
    headers.forEach((h, i) => o[h] = vals[i] ?? "");
    return o;
  });
}

function normalizeKey(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function objectText(obj, names) {
  const wanted = names.map(normalizeKey);
  if (!obj || typeof obj !== "object") return "";
  for (const [raw, value] of Object.entries(obj)) {
    const k = normalizeKey(raw);
    if (wanted.some(n => k === n || k.includes(n))) return String(value ?? "").trim();
  }
  return "";
}

function objectNumber(obj, names) {
  const wanted = names.map(normalizeKey);
  const seen = new Set();
  function walk(v, depth = 0) {
    if (depth > 5 || v == null) return null;
    if (Array.isArray(v)) {
      for (const item of v) { const n = walk(item, depth + 1); if (n != null) return n; }
      return null;
    }
    if (typeof v !== "object") return null;
    if (seen.has(v)) return null;
    seen.add(v);
    for (const [raw, value] of Object.entries(v)) {
      const k = normalizeKey(raw);
      if (wanted.some(n => k === n || k.includes(n))) {
        const n = num(value);
        if (n != null) return n;
      }
    }
    for (const value of Object.values(v)) {
      const n = walk(value, depth + 1);
      if (n != null) return n;
    }
    return null;
  }
  return walk(obj);
}

function rowCandidates(d) {
  const out = [];
  const seen = new Set();
  function walk(v, depth = 0) {
    if (depth > 6 || v == null) return;
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v)) out.push(v);
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else for (const x of Object.values(v)) walk(x, depth + 1);
  }
  walk(d);
  return out;
}

async function fetchText(url, extra = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NASDAQ-Scanner/1.0)",
        "accept": "text/html,application/xhtml+xml,application/json,text/csv;q=0.9,*/*;q=0.8",
        "referer": `${CE}/`,
        ...extra
      }
    });
    return { r, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function apiJSON(url) {
  try {
    const { r, text } = await fetchText(url, { accept: "application/json" });
    let d = null; try { d = JSON.parse(text); } catch {}
    return {
      ok: r.ok,
      status: r.status,
      data: d,
      text: String(text || "").slice(0, 1200)
    };
  } catch (e) {
    return { ok: false, status: 0, data: null, text: "", error: String(e?.message || e) };
  }
}

async function apiCSV(url) {
  try {
    const { r, text } = await fetchText(url, { accept: "text/csv,application/json" });
    return { ok: r.ok, status: r.status, rows: csvRows(text) };
  } catch { return { ok: false, status: 0, rows: [] }; }
}

function rowsFrom(d) {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.results)) return d.results;
  if (Array.isArray(d?.data)) return d.data;
  if (d && typeof d === "object") return [d];
  return [];
}

function validFloat(n) {
  return Number.isFinite(n) && n > 0;
}

function exactSymbolInText(text, symbol) {
  return new RegExp(`(?:^|[^A-Z0-9.])${symbol.replace(/\./g, "\\.")}(?:[^A-Z0-9.]|$)`, "i").test(text);
}

async function borrowFromPublicPage(symbol, exchange) {
  const prefixes={XNAS:"nasdaq",XNYS:"nyse",XASE:"nyseamerican"};
  const ex=String(exchange||"").toUpperCase();
  const prefix=prefixes[ex];
  if(!prefix) return null;
  const pages = [
    `${CE}/symbol/${prefix}-${encodeURIComponent(symbol.toLowerCase())}/borrow-fee/?source=ib`,
    `${CE}/symbol/${prefix}-${encodeURIComponent(symbol.toLowerCase())}/borrow-fee/`
  ];
  for (const page of pages) {
    try {
      const { r, text } = await fetchText(page);
      if (!r.ok) continue;
      const visible = stripHtml(text).replace(/\u00a0/g, " ");
      const patterns = [
        /(?:there were\s+)?([0-9.,]+\s*[KMBT]?)\s+shares\s+available\s+with\s+a\s+fee\s+of\s+([0-9.,]+)\s*%/i,
        /([0-9.,]+\s*[KMBT]?)\s+shares\s+available[^%]{0,160}?(?:fee|rate|ctb)[^0-9]{0,30}([0-9.,]+)\s*%/i
      ];
      for (const re of patterns) {
        const m = re.exec(visible);
        if (!m) continue;
        const shares = num(m[1]), fee = num(m[2]);
        if (shares != null && fee != null) return { shares, fee, source: `chartexchange-public-${ex.toLowerCase()}` };
      }
    } catch {}
  }
  return null;
}



function textToNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/\u00a0/g, ' ').trim().replace(/,/g, '');
  const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(K|M|B|T)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n * ({K:1e3,M:1e6,B:1e9,T:1e12}[String(m[2]||'').toUpperCase()] || 1);
}

export async function fetchFreeFloat(symbol, exchange='XNAS', options={}) {
  // Free Float is owned exclusively by the Finviz/ScrapingAnt lane.
  // ChartExchange is never queried for Float.
  return null;
}

async function borrowFromScrapingAnt(symbol, exchange, options = {}) {
  const key=String(process.env.SCRAPINGANT_API_KEY||'').trim();
  const upper=String(symbol||'').trim().toUpperCase();
  const externalSignal=options?.signal;
  if(!key||!upper)return {ok:false,reason:key?'empty-symbol':'missing-scrapingant-key'};
  const prefixes={XNAS:'nasdaq',XNYS:'nyse',XASE:'nyseamerican'};
  const ex=String(exchange||'').toUpperCase();
  const prefix=prefixes[ex];
  if(!prefix)return {ok:false,reason:'unsupported-or-missing-exchange'};
  const target=`${CE}/symbol/${prefix}-${encodeURIComponent(upper.toLowerCase())}/borrow-fee/?source=ib`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  const abortExternal=()=>controller.abort();
  if(externalSignal){if(externalSignal.aborted)controller.abort();else externalSignal.addEventListener('abort',abortExternal,{once:true});}
  try{
    const qs=new URLSearchParams({url:target,'x-api-key':key,browser:'false',timeout:'15'});
    const r=await fetch(`https://api.scrapingant.com/v2/general?${qs.toString()}`,{signal:controller.signal,headers:{accept:'text/html,application/xhtml+xml,text/plain,*/*;q=0.8','user-agent':'Mozilla/5.0 (compatible; NASDAQ-Scanner/1.0)'}});
    const html=await r.text();
    if(!r.ok)return {ok:false,reason:`scrapingant-http-${r.status}`,status:r.status,responsePreview:html.slice(0,500)};
    const $=cheerio.load(String(html||''),{decodeEntities:true});
    $('script,style,noscript,template').remove();
    const bodyText=$('body').text().replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const candidates=[bodyText];
    $('[class],[id],[data-shares-available],[data-available-shares],[data-borrow-fee],[data-borrow-fee-rate],[data-fee-percent],[data-fee]').each((_,el)=>{
      const text=$(el).text().replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
      if(text)candidates.push(text);
      for(const attr of ['data-shares-available','data-available-shares','data-borrow-fee','data-borrow-fee-rate','data-fee-percent','data-fee']){const value=$(el).attr(attr);if(value)candidates.push(`${attr} ${value}`);}
    });
    const patterns=[
      /(?:there were\s+)?([0-9.,]+\s*[KMBT]?)\s+shares\s+available\s+with\s+a\s+fee\s+of\s+([0-9.,]+)\s*%/i,
      /([0-9.,]+\s*[KMBT]?)\s+shares\s+available[^%]{0,250}?(?:fee|rate|ctb)[^0-9]{0,40}([0-9.,]+)\s*%/i,
      /(?:available[_\s-]*shares|shares[_\s-]*available)[^0-9]{0,100}([0-9.,]+\s*[KMBT]?)[\s\S]{0,250}?(?:borrow[_\s-]*fee|fee[_\s-]*(?:percent|rate)?|ctb)[^0-9]{0,80}([0-9.,]+)\s*%/i
    ];
    for(const text of candidates){for(const re of patterns){const m=re.exec(text);if(!m)continue;const shares=num(m[1]),fee=num(m[2]);if(shares!=null||fee!=null)return {ok:true,shares:shares??null,fee:fee??null,freeFloat:null,free_float:null,source:'scrapingant-chartexchange-direct-html',status:r.status};}}
    let shares=null,fee=null;
    $('[class],[id]').each((_,el)=>{
      const keyText=`${$(el).attr('class')||''} ${$(el).attr('id')||''}`.toLowerCase();
      const value=$(el).attr('data-shares-available')||$(el).attr('data-available-shares')||$(el).text();
      if(shares==null&&/(shares.*available|available.*shares|shortable.*shares)/i.test(keyText))shares=num(value);
      const feeValue=$(el).attr('data-borrow-fee')||$(el).attr('data-borrow-fee-rate')||$(el).attr('data-fee-percent')||$(el).attr('data-fee')||$(el).text();
      if(fee==null&&/(borrow.*fee|fee.*(percent|rate)|ctb)/i.test(keyText))fee=num(feeValue);
    });
    if(shares!=null||fee!=null)return {ok:true,shares,fee,freeFloat:null,free_float:null,source:'scrapingant-chartexchange-direct-html',status:r.status};
    return {ok:false,reason:'scrape-no-borrow-data',status:r.status,responsePreview:bodyText.slice(0,500)};
  }catch(e){if(e?.name==='AbortError')throw e;return {ok:false,reason:String(e?.message||e),status:0};}
  finally{clearTimeout(timer);if(externalSignal)externalSignal.removeEventListener('abort',abortExternal);}
}

export async function getBorrowData(symbol, exchange) {
  const direct=await borrowFromScrapingAnt(symbol,exchange).catch(()=>null);
  if(direct?.ok&&(direct.shares!=null||direct.fee!=null))return {shares:direct.shares??null,fee:direct.fee??null,freeFloat:null,free_float:null,source:direct.source||'scrapingant-chartexchange-direct-html'};
  return {shares:null,fee:null,freeFloat:null,source:'unavailable'};
}

export async function getBorrowDataBulk(symbols, options = {}) {
  const list=[...new Set((symbols||[]).map(s=>String(s).trim().toUpperCase()).filter(Boolean))];
  const out={};
  const onProgress=typeof options.onProgress==='function'?options.onProgress:null;
  if(!list.length)return out;
  let done=0;
  for(const symbol of list){
    const exchange=options.exchangeByTicker?.[symbol]||options.exchange;
    try{
      const value=await borrowFromScrapingAnt(symbol,exchange);
      if(value?.ok&&(value.shares!=null||value.fee!=null))out[symbol]={...value,freeFloat:null,free_float:null};
    }catch(e){console.warn('[chartexchange] ScrapingAnt borrow failed',symbol,e?.message||e);}
    done++;
    if(onProgress){try{await onProgress(done,list.length,Object.keys(out).length,symbol,{phase:'scrapingant-chartexchange'});}catch{}}
  }
  return out;
}

export { borrowFromScrapingAnt };

export default async function (request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";
  const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  const exchange = String(url.searchParams.get("exchange") || "").trim().toUpperCase();

  if ((action === "borrow" || action === "float") && !SYMBOL_RE.test(symbol)) {
    return json({ error: "رمز السهم غير صالح." }, 400);
  }

  if (action === "borrow" || action === "float") {
    // Customer-facing endpoint is cache-only. The scraper engine lives outside
    // Netlify in the external Background Worker; customers never trigger it.
    const store = getDataStore();
    const pointer = await store.get("scanner-cache-pointer-v2", {type:"json", consistency:"strong"}).catch(() => null);
    const cache = (pointer?.key ? await store.get(pointer.key, {type:"json", consistency:"strong"}).catch(() => null) : null) || await store.get("scanner-cache-v1", {type:"json", consistency:"strong"}).catch(() => null);
    const row = Array.isArray(cache?.records) ? cache.records.find(x => String(x?.ticker || "").toUpperCase() === symbol) : null;
    if(action === "borrow") return json({ok:true,shares:row?.shortShares ?? null,fee:row?.borrowFee ?? null,freeFloat:row?.freeFloat ?? row?.free_float ?? null,source:"central-cache",updatedAt:row?.shortDataUpdatedAt || null});
    return json({ok:true,float:row?.freeFloat ?? row?.free_float ?? null,symbol,exchange,source:"central-cache",updatedAt:row?.freeFloatUpdatedAt || null});
  }

  return json({error:"هذا المسار غير متاح مباشرة. بيانات الشورت والـFree Float تُقرأ من الكاش المركزي فقط."},404);
}
