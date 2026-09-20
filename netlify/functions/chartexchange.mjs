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

// Isolated ChartExchange Free Float extractor. The selector below is the
// JavaScript/Cheerio equivalent of the requested XPath selector:
// //td[contains(text(),'Shares Float') or contains(text(),'Free Float')]/following-sibling::td[1]
export function extractFloatShares(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: true });
  const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  let found = null;

  // Exact table selector: Shares Float OR Free Float -> immediate next TD.
  $('td').filter((_, el) => /Shares\s*Float|Free\s*Float/i.test(clean($(el).text()))).each((_, el) => {
    if (validFloat(found)) return;
    const value = clean($(el).next('td').first().text());
    const n = textToNumber(value);
    if (validFloat(n)) found = n;
  });
  if (validFloat(found)) return found;

  // Exact definition-list equivalent for pages that expose the same field as dt/dd.
  $('dt').filter((_, el) => /Shares\s*Float|Free\s*Float/i.test(clean($(el).text()))).each((_, el) => {
    if (validFloat(found)) return;
    const value = clean($(el).next('dd').first().text());
    const n = textToNumber(value);
    if (validFloat(n)) found = n;
  });
  if (validFloat(found)) return found;

  // Nested label/cell fallback: the label can be inside a TD/TR.
  $('tr').each((_, row) => {
    if (validFloat(found)) return;
    const cells = $(row).find('td');
    cells.each((i, cell) => {
      if (validFloat(found)) return;
      if (!/Shares\s*Float|Free\s*Float/i.test(clean($(cell).text()))) return;
      const n = textToNumber(clean(cells.eq(i + 1).text()));
      if (validFloat(n)) found = n;
    });
  });
  return validFloat(found) ? found : null;
}

export async function fetchFreeFloat(symbol, exchange='XNAS', options={}) {
  const upper=String(symbol||'').trim().toUpperCase();
  const scraperKey=String(process.env.SCRAPERAPI_KEY||'').trim();
  const signal=options?.signal;
  if(!SYMBOL_RE.test(upper)||!scraperKey)return null;
  const prefixes={XNAS:'nasdaq',XNYS:'nyse',XASE:'nyseamerican'};
  const prefix=prefixes[String(exchange||'XNAS').toUpperCase()]||'nasdaq';
  const target=`${CE}/symbol/${prefix}-${encodeURIComponent(upper.toLowerCase())}/`;
  const attempts=[{render:'false',premium:'true',country_code:'us',device_type:'desktop'},{render:'false',premium:'true',country_code:'us',device_type:'mobile'}];
  for(const extra of attempts){
    const qs=new URLSearchParams({api_key:scraperKey,url:target,country_code:'us',render:'false',...extra});
    try{
      const r=await fetch(`https://api.scraperapi.com/?${qs.toString()}`,{signal,headers:{accept:'text/html,application/xhtml+xml,text/plain,*/*;q=0.8','user-agent':'Mozilla/5.0 (compatible; NASDAQ-Scanner/1.0)'}});
      if(!r.ok)continue;
      const html=await r.text();
      const n=extractFloatShares(html);
      if(validFloat(n)){
        console.info('[free-float] ChartExchange HTML hit',{symbol:upper,exchange:String(exchange||'XNAS').toUpperCase(),freeFloat:n,scraperOptions:extra});
        return n;
      }
    }catch(e){
      if(e?.name==='AbortError')throw e;
      console.warn('[free-float] ChartExchange/ScraperAPI failed',{symbol:upper,error:String(e?.message||e)});
    }
  }
  return null;
}

async function borrowFromScraperAPI(symbol, exchange, options = {}) {
  const key = String(process.env.SCRAPERAPI_KEY || '').trim();
  const upper = String(symbol || '').trim().toUpperCase();
  const externalSignal=options?.signal;
  if (!key || !upper) return { ok:false, reason:key ? 'empty-symbol' : 'missing-scraperapi-key' };

  const prefixes={XNAS:'nasdaq',XNYS:'nyse',XASE:'nyseamerican'};
  const ex=String(exchange||'').toUpperCase();
  const prefix=prefixes[ex];
  if(!prefix) return {ok:false,reason:'unsupported-or-missing-exchange'};
  const target = `${CE}/symbol/${prefix}-${encodeURIComponent(upper.toLowerCase())}/borrow-fee/?source=ib`;

  async function scrape(extra = {}) {
    const qs = new URLSearchParams({
      api_key: key,
      url: target,
      country_code: 'us',
      render: 'false',
      ...extra
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const abortExternal=()=>controller.abort();
    if(externalSignal){ if(externalSignal.aborted) controller.abort(); else externalSignal.addEventListener('abort',abortExternal,{once:true}); }
    try {
      const r = await fetch(`https://api.scraperapi.com/?${qs.toString()}`, {
        signal: controller.signal,
        headers: {
          'accept': 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; NASDAQ-Scanner/1.0)'
        }
      });
      return { status:r.status, ok:r.ok, text:await r.text() };
    } finally { clearTimeout(timer); if(externalSignal) externalSignal.removeEventListener('abort',abortExternal); }
  }

  // Parse the HTML returned by ScraperAPI without executing JavaScript.
  // ChartExchange's initial HTML is the source of truth for the public borrow
  // page. Cheerio lets us inspect the rendered-by-server DOM/text and data
  // attributes while keeping this path strictly HTTP/HTML based.
  const parse = (html) => {
    const $ = cheerio.load(String(html || ''), { decodeEntities: true });
    const rawHtml = String(html || '');
    $('script, style, noscript, template').remove();
    const bodyText = $('body').text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const chunks = [];
    $('body *').each((_, el) => {
      const text = $(el).text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 1000) chunks.push(text);
      for (const attr of ['data-shares-available','data-available-shares','data-sharesavailable','data-borrow-fee','data-borrow-fee-rate','data-fee-percent','data-fee','data-free-float','data-shares-float','data-free-float-shares']) {
        const value = $(el).attr(attr);
        if (value) chunks.push(`${attr} ${value}`);
      }
    });

    const candidates = [bodyText, ...chunks];
    const freeFloat = extractFloatShares(rawHtml);
    const patterns = [
      /(?:there were\s+)?([0-9.,]+\s*[KMBT]?)\s+shares\s+available\s+with\s+a\s+fee\s+of\s+([0-9.,]+)\s*%/i,
      /([0-9.,]+\s*[KMBT]?)\s+shares\s+available[^%]{0,250}?(?:fee|rate|ctb)[^0-9]{0,40}([0-9.,]+)\s*%/i,
      /shares\s+available[^0-9]{0,80}([0-9.,]+\s*[KMBT]?)[^%]{0,250}?(?:fee|rate|ctb)[^0-9]{0,40}([0-9.,]+)\s*%/i,
      /(?:available[_\s-]*shares|shares[_\s-]*available)[^0-9]{0,80}([0-9.,]+\s*[KMBT]?)[\s\S]{0,250}?(?:borrow[_\s-]*fee|fee[_\s-]*(?:percent|rate)?|ctb)[^0-9]{0,80}([0-9.,]+)\s*%/i
    ];

    for (const text of candidates) {
      for (const re of patterns) {
        const m = re.exec(text);
        if (!m) continue;
        const shares = num(m[1]);
        const fee = num(m[2]);
        if (shares != null || fee != null || freeFloat != null) return { shares, fee, freeFloat };
      }
    }

    // Some ChartExchange layouts put the values in separate DOM nodes or
    // data-* attributes. Pair explicit labels with nearby numeric values rather
    // than trusting arbitrary page numbers.
    let shares = null;
    let fee = null;
    $('[class], [id], [data-shares-available], [data-available-shares], [data-borrow-fee], [data-fee]').each((_, el) => {
      if (shares == null) {
        const key = `${$(el).attr('class') || ''} ${$(el).attr('id') || ''}`.toLowerCase();
        const value = $(el).attr('data-shares-available') || $(el).attr('data-available-shares') || $(el).text();
        if (/(shares.*available|available.*shares|shortable.*shares)/i.test(key)) shares = num(value);
      }
      if (fee == null) {
        const key = `${$(el).attr('class') || ''} ${$(el).attr('id') || ''}`.toLowerCase();
        const value = $(el).attr('data-borrow-fee') || $(el).attr('data-borrow-fee-rate') || $(el).attr('data-fee-percent') || $(el).attr('data-fee') || $(el).text();
        if (/(borrow.*fee|fee.*(percent|rate)|ctb)/i.test(key)) fee = num(value);
      }
    });
    if (shares != null || fee != null || freeFloat != null) return { shares, fee, freeFloat };
    return null;
  };

  // Direct HTML only: never ask ScraperAPI to execute JavaScript or launch a
  // headless browser. If the normal proxy path is challenged, retry the same
  // HTTP GET through Ultra Premium Proxies.
  const attempts = [
    { render: 'false', premium: 'true', country_code: 'us', device_type: 'desktop' },
    { render: 'false', premium: 'true', country_code: 'us', device_type: 'mobile' },
    { render: 'false', premium: 'true', country_code: 'us', session_number: '1' }
  ];
  let last = null;
  for (const options of attempts) {
    try {
      const r = await scrape(options);
      last = { status:r.status, preview:String(r.text || '').slice(0,500), scraperOptions:options };
      if (!r.ok) continue;
      const found = parse(r.text);
      if (found) {
        let ff=found.freeFloat ?? null;
        if(ff==null) ff=await fetchFreeFloat(upper,ex,{signal:externalSignal}).catch(e=>{ if(e?.name==='AbortError') throw e; return null; });
        console.info('[chartexchange] parsed sample', { symbol: upper, exchange: ex, shares: found.shares ?? null, fee: found.fee ?? null, freeFloat: ff, scraperOptions: options });
        return {
          ok:true,
          shares:found.shares ?? null,
          fee:found.fee ?? null,
          freeFloat:ff,
          free_float:ff,
          source:ff!=null?'scraperapi-chartexchange-direct-html+float-selector':'scraperapi-chartexchange-direct-html',
          status:r.status,
          scraperOptions:options
        };
      }
    } catch (e) {
      last = { status:0, preview:String(e?.message || e), scraperOptions:options };
    }
  }
  // Final server-side fallback: ChartExchange's public HTML page. This still
  // uses ChartExchange as the source of truth and never exposes an upstream key
  // to the browser. ScraperAPI remains the primary route.
  try {
    const pub = await borrowFromPublicPage(upper, ex);
    const ff = await fetchFreeFloat(upper, ex, {signal: externalSignal}).catch(e=>{
      if(e?.name==='AbortError') throw e;
      return null;
    });
    if(pub || ff != null) {
      return {
        ok:true,
        shares:pub?.shares ?? null,
        fee:pub?.fee ?? null,
        freeFloat:ff,
        free_float:ff,
        source:pub ? 'chartexchange-public-html-fallback' : 'scraperapi-chartexchange-float-selector',
        status:last?.status ?? 0,
        scraperOptions:last?.scraperOptions || null
      };
    }
  } catch (e) {
    if(e?.name==='AbortError') throw e;
    console.warn('[chartexchange] public fallback failed',{symbol:upper,exchange:ex,error:String(e?.message||e)});
  }
  return { ok:false, reason:'scrape-no-borrow-data', status:last?.status ?? 0, responsePreview:last?.preview || '', scraperOptions:last?.scraperOptions || null };
}

async function borrowFromApi(symbol, key) {
  if (!key) return null;
  // ChartExchange returns historical rows. Never take an arbitrary nested
  // object (which can be a metadata/zero row); select the newest row that
  // actually belongs to the requested ticker, then read explicit fields.
  const symbols = [symbol, `NASDAQ:${symbol}`];
  const shareNames = ["shares_available","sharesavailable","available_shares","availableshares","available","shortable_shares","shortableshares","borrow_fee_available","borrowfeeavailable","shares"];
  const feeNames = ["fee_percent","feepercent","fee_rate","feerate","borrow_fee","borrowfee","borrow_fee_rate","borrowfeerate","borrow_rate","borrowrate","ctb","rate","fee"];
  const timeNames = ["timestamp","datetime","date","time","created_at","updated_at","asof","as_of"];
  const symbolNames = ["symbol","ticker","display","stock","security"];
  for (const sym of symbols) {
    const qs = new URLSearchParams({symbol:sym,api_key:key,page_size:"25",ordering:"-date"});
    const variants = [
      `${CE}/api/v1/data/stocks/borrow-fee/ib/?${qs}`,
      `${CE}/api/v1/data/stocks/borrow-fee/ib/?symbol=${encodeURIComponent(sym)}&api_key=${encodeURIComponent(key)}&page_size=25`
    ];
    for (const url of variants) {
      const j = await apiJSON(url);
      if (!j.ok || !j.data) continue;
      let candidates = rowsFrom(j.data);
      // Prefer actual result rows. Only fall back to recursive discovery when the
      // response is wrapped in an unexpected object shape.
      if (!candidates.length) candidates = rowCandidates(j.data);
      candidates = candidates.filter(row => {
        const shares = objectNumber(row, shareNames);
        const fee = objectNumber(row, feeNames);
        if (shares == null && fee == null) return false;
        const rawSymbol = objectText(row, symbolNames).toUpperCase();
        const text = JSON.stringify(row).toUpperCase();
        return !rawSymbol || rawSymbol === symbol.toUpperCase() || rawSymbol === `NASDAQ:${symbol.toUpperCase()}` || text.includes(`NASDAQ:${symbol.toUpperCase()}`);
      });
      candidates.sort((a,b)=>{
        const sa=objectText(a,symbolNames).toUpperCase();
        const sb=objectText(b,symbolNames).toUpperCase();
        const scoreA=(sa===symbol.toUpperCase()||sa===`NASDAQ:${symbol.toUpperCase()}`)?1:0;
        const scoreB=(sb===symbol.toUpperCase()||sb===`NASDAQ:${symbol.toUpperCase()}`)?1:0;
        if(scoreB!==scoreA) return scoreB-scoreA;
        const ta=String(a?.date??a?.timestamp??a?.datetime??a?.time??a?.created_at??a?.updated_at??"");
        const tb=String(b?.date??b?.timestamp??b?.datetime??b?.time??b?.created_at??b?.updated_at??"");
        return tb.localeCompare(ta);
      });
      for (const row of candidates) {
        const shares = objectNumber(row, shareNames);
        const fee = objectNumber(row, feeNames);
        if (shares != null || fee != null) return {shares, fee, source:"chartexchange-api"};
      }
    }
  }
  return null;
}


export { borrowFromScraperAPI };

export async function borrowExactFromApi(symbol, key, {retry429=true,exchange} = {}) {
  if (!key) return { ok:false, reason:"missing-api-key" };
  const upper = String(symbol || '').trim().toUpperCase();
  if (!upper) return { ok:false, reason:"empty-symbol" };

  const symbolNames = ["symbol","ticker","stock","security","display"];
  const shareNames = [
    "shares_available","sharesavailable","available_shares","availableshares",
    "shares_available_ib","ib_shares_available","shortable_shares","shortableshares",
    "available","shares","quantity","qty"
  ];
  const feeNames = [
    "fee_percent","feepercent","fee_pct","feepct","fee_rate","feerate",
    "borrow_fee","borrowfee","borrow_fee_rate","borrowfeerate","borrow_rate",
    "borrowrate","ctb","ctb_percent","ctbpercent","rate","fee"
  ];
  const timeNames = ["timestamp","datetime","date","time","created_at","updated_at","asof","as_of"];

  function normalizedSymbol(row) {
    const raw = objectText(row, symbolNames).toUpperCase().trim();
    return raw.replace(/^(NASDAQ|NYSE|NYSEAMERICAN|XNAS|XNYS|XASE):/, "");
  }

  function parseRows(data) {
    let rows = rowsFrom(data);
    if (!rows.length) rows = rowCandidates(data);
    return rows;
  }

  function choose(rows) {
    const good = rows.map(row => {
      const rs = normalizedSymbol(row);
      const shares = objectNumber(row, shareNames);
      const fee = objectNumber(row, feeNames);
      const raw = JSON.stringify(row).toUpperCase();
      const qPrefixes=[qprefix,ex];
      const matches = !rs || rs === upper || qPrefixes.some(p=>rs===`${p}:${upper}`) || qPrefixes.some(p=>raw.includes(`${p}:${upper}`)) || raw.includes(`"${upper}"`);
      if (!matches || (shares == null && fee == null)) return null;
      const stamp = objectText(row, timeNames) || String(row?.date || row?.timestamp || "");
      return { shares: shares ?? null, fee: fee ?? null, stamp, responseKeys:Object.keys(row || {}).slice(0,30) };
    }).filter(Boolean);
    good.sort((a,b)=>String(b.stamp).localeCompare(String(a.stamp)));
    return good[0] || null;
  }

  const ex=String(exchange||'').toUpperCase();
  const prefixes={XNAS:'NASDAQ',XNYS:'NYSE',XASE:'NYSEAMERICAN'};
  const qprefix=prefixes[ex];
  if(!qprefix) return {ok:false,reason:'unsupported-or-missing-exchange'};
  const querySymbols = [`${qprefix}:${upper}`, upper];

  for (let qIndex=0; qIndex<querySymbols.length; qIndex++) {
    const querySymbol = querySymbols[qIndex];
    const qs = new URLSearchParams({
      symbol: querySymbol,
      api_key: key,
      ordering: "-date",
      page: "1",
      page_size: "1"
    });
    const url = `${CE}/api/v1/data/stocks/borrow-fee/ib/?${qs.toString()}`;

    for (let attempt=0; attempt<2; attempt++) {
      const j = await apiJSON(url);
      const data = j.data;
      const rows = parseRows(data);
      const row = choose(rows);

      if (j.status === 429) {
        if (!retry429) return {ok:false,status:429,reason:"rate-limit",querySymbol};
        await sleep(attempt === 0 ? 6000 : 15000);
        continue;
      }

      if (!j.ok) {
        return {
          ok:false,
          status:j.status,
          reason:"http-error",
          querySymbol,
          responsePreview:j.text || ""
        };
      }

      if (row) {
        return {
          ok:true,
          shares:row.shares,
          fee:row.fee,
          stamp:row.stamp,
          source:"chartexchange-api-exact",
          status:j.status,
          querySymbol,
          responseKeys:row.responseKeys
        };
      }

      // 200 + empty/unrecognized response: try the plain symbol once.
      if (qIndex === 0) break;
      return {
        ok:false,
        status:j.status,
        reason:"empty-or-unknown-response",
        querySymbol,
        responseKeys:data && typeof data === "object" ? Object.keys(data).slice(0,30) : [],
        responsePreview:j.text || ""
      };
    }
  }

  return {ok:false,reason:"no-data"};
}
async function borrowBulkFromApi(symbols, key, options = {}) {
  if (!key || !symbols?.length) return {};
  const list = [...new Set(symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  const out = {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const total = list.length, rounds = 9, perMinute = 30;
  let pending = [...list], doneAttempts = 0;
  for (let round=1; round<=rounds && pending.length; round++) {
    const batch=pending.slice(0,perMinute), retryLater=[], batchStarted=Date.now();
    // Each symbol is still an independent API request. Run a small number in
    // parallel so one slow ticker cannot consume the whole minute window.
    for (let i=0; i<batch.length; i+=5) {
      const slice=batch.slice(i,i+5);
      const results=await Promise.all(slice.map(async symbol=>{
        const exchange=options.exchangeByTicker?.[symbol]||options.exchange||null;
        try { return [symbol,await borrowExactFromApi(symbol,key,{exchange}),null]; }
        catch(e) { console.warn("borrow exact request failed",symbol,e?.message||e); return [symbol,null,e]; }
      }));
      for(const [symbol,found] of results){
        doneAttempts++;
        if(found && (found.shares!=null || found.fee!=null)) out[symbol]={...found,_stamp:found.stamp||""};
        else retryLater.push(symbol);
        if(onProgress) { try { await onProgress(doneAttempts,total,Object.keys(out).length,symbol,{round,rounds,batchSize:batch.length,pending:pending.length,attempts:doneAttempts}); } catch {} }
      }
    }
    pending=pending.slice(batch.length).concat(retryLater);
    if(pending.length && round<rounds) {
      const wait=Math.max(0,60000-(Date.now()-batchStarted));
      if(wait) await sleep(wait);
    }
  }
  for(const value of Object.values(out)) delete value._stamp;
  return out;
}

export async function getBorrowData(symbol, exchange) {
  // The symbol page HTML is the authoritative source for Free Float. Do not
  // replace it with Massive or a calculated float value. Borrow API remains a
  // fallback only for the Short Available / Borrow Fee fields.
  const direct = await borrowFromScraperAPI(symbol, exchange).catch(() => null);
  if (direct?.ok && (direct.shares != null || direct.fee != null || direct.freeFloat != null)) {
    return {
      shares: direct.shares ?? null,
      fee: direct.fee ?? null,
      freeFloat: direct.freeFloat ?? direct.free_float ?? null,
      free_float: direct.freeFloat ?? direct.free_float ?? null,
      source: direct.source || 'scraperapi-chartexchange-direct-html'
    };
  }

  const key = String(process.env.CHARTEXCHANGE_API_KEY || '').trim();
  if (key) {
    const bulk = await borrowBulkFromApi([symbol], key, {exchangeByTicker:{[String(symbol).toUpperCase()]:exchange}});
    if (bulk[symbol]) return {...bulk[symbol], freeFloat:null};
    const api = await borrowFromApi(symbol, key);
    if (api && (api.shares != null || api.fee != null)) return {...api, freeFloat:null};
  }

  const pub = await borrowFromPublicPage(symbol, exchange);
  if (pub && (Number.isFinite(Number(pub.shares)) || Number.isFinite(Number(pub.fee)))) {
    return { shares: pub.shares ?? null, fee: pub.fee ?? null, freeFloat:null, source: pub.source };
  }
  return { shares: null, fee: null, freeFloat: null, source: 'unavailable' };
}

export async function getBorrowDataBulk(symbols, options = {}) {
  const list=[...new Set((symbols||[]).map(s=>String(s).trim().toUpperCase()).filter(Boolean))];
  const key=String(process.env.CHARTEXCHANGE_API_KEY||'').trim();
  const out={}; const onProgress=typeof options.onProgress==='function'?options.onProgress:null;
  if(!list.length) return out;
  if(key){
    const bulk=await borrowBulkFromApi(list,key,{onProgress});
    for(const [symbol,value] of Object.entries(bulk||{})) if(value&&(value.shares!=null||value.fee!=null)) out[symbol]=value;
  }
  const missing=list.filter(s=>!out[s]);
  let lastPublic=0;
  for(let i=0;i<missing.length;i++){
    const symbol=missing[i], wait=Math.max(0,1100-(Date.now()-lastPublic));
    if(wait) await sleep(wait); lastPublic=Date.now();
    try{const pub=await borrowFromPublicPage(symbol, options.exchangeByTicker?.[symbol]||options.exchange); if(pub&&(pub.shares!=null||pub.fee!=null)) out[symbol]=pub;}catch(e){console.warn('borrow public fallback failed',symbol,e?.message||e);}
    if(onProgress){try{await onProgress(list.length+i+1,list.length+missing.length,Object.keys(out).length,symbol,{round:9,rounds:9,phase:'public-fallback',pending:missing.length-i-1});}catch{}}
  }
  return out;
}

export default async function (request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";
  const key = String(process.env.CHARTEXCHANGE_API_KEY || "").trim();
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

  const path = url.searchParams.get("path") || "";
  if (!path.startsWith("/") || path.includes("..") || path.includes("://")) return json({ error: "مسار غير صالح" }, 400);
  if (!key) return json({ error: "CHARTEXCHANGE_API_KEY غير مهيأ" }, 500);
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${CE}/api/v1${path}${sep}api_key=${encodeURIComponent(key)}`);
  return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "private, max-age=30" } });
}
