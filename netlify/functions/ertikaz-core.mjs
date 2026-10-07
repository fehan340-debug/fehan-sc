import { getDataStore, getSiteSettings } from '../../lib.js';

// Ertikaz model v1
// Daily: RSI < 30.
// Cached daily/split/short fields come from the central scanner cache.
// Daily candles: base -> resistance at any later session while the base holds -> next/second-day support retest -> 5 real trading sessions -> liquidity sweep.
// The model is deterministic and rule-based; it does not infer intent and does not use future data
// beyond the point at which each condition is evaluated.
const MASSIVE='https://api.massive.com';
const RESULT_KEY='scanner-models-ertikaz-v1';
const STATUS_KEY='scanner-models-ertikaz-status-v1';
const HISTORY_KEY='scanner-models-ertikaz-history-daily-v2';
const CONFIG_KEY='scanner-models-ertikaz-config-v1';
const CONCURRENCY=5;
const MAX_LIQUIDITY_SWEEP_PCT=10;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const apiKey=()=>String(process.env.MASSIVE_API_KEY||'').trim();
const cleanTicker=x=>String(x||'').trim().toUpperCase();
const todayET=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));
function etDate(ts){
  const n=Number(ts); if(!Number.isFinite(n))return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(n));
}
function parseDate(s){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||''));if(!m)return null;return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));}
function calendarDays(from,to){const a=parseDate(from),b=parseDate(to);return a&&b?Math.floor((b-a)/86400000):null;}
function sessionsBetween(dates,from,to){return [...new Set(dates.filter(d=>d>=from&&d<=to))].sort();}
async function massive(path){
  const k=apiKey(); if(!k)throw new Error('MASSIVE_API_KEY غير مهيأ.');
  const sep=path.includes('?')?'&':'?'; let last='';
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
function normalizeDaily(b){
  const t=Number(b?.t),o=Number(b?.o),h=Number(b?.h),l=Number(b?.l),c=Number(b?.c),v=Number(b?.v||0);
  if(!Number.isFinite(t)||![o,h,l,c].every(Number.isFinite)||h<=0||l<=0||c<=0)return null;
  const date=etDate(t); if(!date)return null;
  return {t,date,open:o,high:h,low:l,close:c,volume:Number.isFinite(v)?v:null};
}
async function fetchDaily(ticker,from,to){
  const direct=(await massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`)).results||[];
  return direct.map(normalizeDaily).filter(Boolean).sort((a,b)=>a.t-b.t);
}
async function loadHistory(t){return await getDataStore().get(`${HISTORY_KEY}:${t}`,{type:'json',consistency:'strong'}).catch(()=>null);}
async function saveHistory(t,value){await getDataStore().setJSON(`${HISTORY_KEY}:${t}`,value);}
async function getCache(){
  const store=getDataStore();
  const pointer=await store.get('scanner-cache-pointer-v2',{type:'json',consistency:'strong'}).catch(()=>null);
  if(pointer?.key){const d=await store.get(pointer.key,{type:'json',consistency:'strong'}).catch(()=>null);if(d?.ready&&Array.isArray(d.records))return d;}
  return await store.get('scanner-cache-v1',{type:'json',consistency:'strong'}).catch(()=>null)||{};
}
function rsiDaily(row){const n=Number(row?.rsi);return Number.isFinite(n)?n:null;}
function shortAvailable(row){const n=Number(row?.shortShares);return Number.isFinite(n)?n:null;}

export function detectErtikazSequence(bars,splitDate){
  const b=(Array.isArray(bars)?bars:[])
    .filter(x=>x?.date>=splitDate&&Number.isFinite(Number(x?.low))&&Number(x.low)>0&&Number.isFinite(Number(x?.high))&&Number(x.high)>0&&Number.isFinite(Number(x?.close))&&Number(x.close)>0)
    .sort((a,z)=>a.t-z.t);
  if(!b.length)return {base:null,resistance:null,support:null,liquidity:null,liquiditySweeps:[]};

  const dates=[...new Set(b.map(x=>x.date))].sort();
  const dateIndex=new Map(dates.map((d,i)=>[d,i]));
  const MAX_SWEEP=MAX_LIQUIDITY_SWEEP_PCT;
  const MIN_RECOVERY_SESSIONS=2;

  // IMPORTANT:
  // - The base is the lowest daily Low reached by the current setup.
  // - A lower Low during the first five sessions replaces the base and restarts
  //   the five-session stabilization count.
  // - Resistance may appear on ANY later daily candle; its absence never creates
  //   a new base by itself.
  // - Support is dynamic after resistance: keep the lowest Low above the base
  //   and within +5% of the base. A later lower-but-still-above-base Low updates it.
  // - Five-session stabilization is independent of resistance/support timing.
  // - Liquidity is checked ONLY after five sessions have completed.
  // - Multiple liquidity sweeps are allowed. Every sweep must recover above the
  //   base, then have at least TWO COMPLETE daily sessions above the base before
  //   another sweep can be accepted.
  // - No local-pivot/swing-pivot logic is used.

  let baseIndex=0;
  let guard=0;

  while(baseIndex<b.length && guard++<b.length+2){
    const baseBar=b[baseIndex];
    const basePrice=Number(baseBar.low);
    const baseDateIndex=dateIndex.get(baseBar.date);
    if(baseDateIndex===undefined)break;

    const holdDates=dates.slice(baseDateIndex+1,baseDateIndex+6);
    const holdThrough=holdDates.length>=5?holdDates[4]:null;
    const lowerDuringHold=b.find(x=>{
      const di=dateIndex.get(x.date);
      return di>baseDateIndex&&di<=baseDateIndex+5&&Number(x.low)<basePrice-1e-9;
    });

    // A lower Low before the five sessions are complete creates the new base.
    if(lowerDuringHold){
      baseIndex=b.findIndex(x=>x.t===lowerDuringHold.t);
      continue;
    }

    const holdConfirmed=holdDates.length>=5;
    const base={
      price:basePrice,
      date:baseBar.date,
      index:baseIndex,
      holdThrough,
      holdSessions:holdDates.length,
      holdConfirmed
    };

    const resistanceLow=basePrice*1.15;
    const resistanceHigh=basePrice*1.25;
    let resistance=null;
    let resistanceIndex=-1;
    let invalidBaseIndex=null;

    // Resistance can take 1, 2, 5, or many sessions. Only a lower Low changes
    // the base while we are still before stabilization.
    for(let i=baseIndex+1;i<b.length;i++){
      const bar=b[i];
      const di=dateIndex.get(bar.date);
      if(!holdConfirmed&&di<=baseDateIndex+5&&Number(bar.low)<basePrice-1e-9){
        invalidBaseIndex=i;
        break;
      }
      const high=Number(bar.high);
      if(high>=resistanceLow-1e-9&&high<=resistanceHigh+1e-9){
        resistance={
          price:high,
          date:bar.date,
          high,
          index:i,
          zoneLow:resistanceLow,
          zoneHigh:resistanceHigh
        };
        resistanceIndex=i;
        break;
      }
    }

    if(invalidBaseIndex!==null){
      baseIndex=invalidBaseIndex;
      continue;
    }

    // No resistance yet is NOT a failed base. Keep the base and continue the
    // search with the current daily history.
    if(!resistance){
      return {base,resistance:null,support:null,liquidity:null,liquiditySweeps:[]};
    }

    // Support is dynamic. Starting after resistance, every Low that stays above
    // the base and is <= +5% is a support candidate. The lowest such Low wins,
    // even if it occurs several sessions later. This also allows 5.10 -> 5.08
    // to update the support to 5.08 while the base remains 5.00.
    let support=null;
    let supportIndex=-1;
    const supportHigh=basePrice*1.05;
    for(let i=resistanceIndex+1;i<b.length;i++){
      const bar=b[i];
      const low=Number(bar.low);
      if(low<basePrice-1e-9){
        // Before stabilization this is a new base. After stabilization it may
        // be a valid liquidity sweep, so do not break here after holdConfirmed.
        if(!holdConfirmed){
          invalidBaseIndex=i;
          break;
        }
        continue;
      }
      if(low>=basePrice-1e-9&&low<=supportHigh+1e-9){
        if(!support||low<support.price-1e-9||(Math.abs(low-support.price)<=1e-9&&bar.t>support.t)){
          support={price:low,date:bar.date,index:i,zoneLow:basePrice,zoneHigh:supportHigh};
          supportIndex=i;
        }
      }
    }

    if(invalidBaseIndex!==null){
      baseIndex=invalidBaseIndex;
      continue;
    }

    // Liquidity is blocked until five complete sessions AFTER the base.
    if(!holdConfirmed){
      return {base,resistance,support,liquidity:null,liquiditySweeps:[]};
    }

    const holdEndIndex=dateIndex.get(holdThrough);
    const searchStart=Math.max(baseIndex+1,holdEndIndex===undefined?baseIndex+1:dates.findIndex(d=>d===holdThrough)+1);
    const liquiditySweeps=[];
    let recoveryAnchorIndex=null;

    for(let i=searchStart;i<dates.length;i++){
      const date=dates[i];
      const dayBars=b.filter(x=>x.date===date);
      if(!dayBars.length)continue;

      // After each sweep, the recovery day itself does not count. We need two
      // COMPLETE sessions with both Low and Close above the locked base.
      if(recoveryAnchorIndex!==null){
        if(i<=recoveryAnchorIndex)continue;
        const dayLows=dayBars.map(x=>Number(x.low)).filter(Number.isFinite);
        const dayCloses=dayBars.map(x=>Number(x.close)).filter(Number.isFinite);
        const brokenLow=dayLows.length>0&&Math.min(...dayLows)<basePrice-1e-9;

        // CRITICAL RESET: a lower Low during the mandatory two-session recovery
        // window is not another valid liquidity sweep. It breaks the locked base
        // before the setup has stabilized again, so the OLD sequence is invalid
        // and this exact lower-low candle becomes the NEW base.
        if(brokenLow){
          const newBaseBar=dayBars.find(x=>Number(x.low)<basePrice-1e-9);
          const newBaseIndex=newBaseBar?b.findIndex(x=>x.t===newBaseBar.t):-1;
          if(newBaseIndex>=0){
            baseIndex=newBaseIndex;
            break;
          }
        }

        const stayedAbove=dayLows.length>0&&dayCloses.length>0&&
          Math.min(...dayLows)>basePrice+1e-9&&Math.min(...dayCloses)>basePrice+1e-9;
        if(stayedAbove){
          const recoveredSessions=i-recoveryAnchorIndex;
          if(recoveredSessions<MIN_RECOVERY_SESSIONS)continue;
          recoveryAnchorIndex=null;
        }else{
          // Recovery was not stable for two complete sessions yet. The setup
          // remains blocked from accepting another sweep.
          continue;
        }
      }

      const q=dayBars.find(x=>Number(x.low)<basePrice-1e-9);
      if(!q)continue;

      const qLow=Number(q.low);
      const sweepPct=((basePrice-qLow)/basePrice)*100;
      const qIndex=b.findIndex(x=>x.t===q.t);
      if(qIndex<0)continue;

      if(sweepPct>MAX_SWEEP+1e-9){
        // Beyond the allowed sweep range: this is a real new lower base.
        baseIndex=qIndex;
        break;
      }

      // Valid sweep: it must close above the base on the same day or next day.
      const di=dateIndex.get(q.date);
      const recoveryDates=new Set(dates.slice(di,di+2));
      let recovery=null;
      for(let j=qIndex;j<b.length;j++){
        const rb=b[j];
        if(!recoveryDates.has(rb.date))break;
        if(Number(rb.close)>basePrice+1e-9){recovery=rb;break;}
      }
      if(!recovery){
        // It did not recover in time, so this is not a valid sweep. Treat the
        // lower Low as the new base and restart the whole sequence.
        baseIndex=qIndex;
        break;
      }

      const sweep={
        sweepDate:q.date,
        sweepLow:qLow,
        recoveryDate:recovery.date,
        recoveryClose:Number(recovery.close),
        sweepPct:Number(sweepPct.toFixed(2)),
        maxSweepPct:MAX_SWEEP
      };
      liquiditySweeps.push(sweep);

      // Recovery day is excluded from the two-session count.
      recoveryAnchorIndex=dateIndex.get(recovery.date);
    }

    // A sweep deeper than the allowed range or a failed recovery can create a
    // new base. Re-run the entire sequence from that exact lower-low candle.
    if(baseIndex!==b.findIndex(x=>x.t===baseBar.t))continue;

    const liquidity=liquiditySweeps.at(-1)||null;
    return {base,resistance,support,liquidity,liquiditySweeps};
  }

  return {base:null,resistance:null,support:null,liquidity:null,liquiditySweeps:[]};
}

export function evaluateErtikazRules(ticker,row,bars,nowDate){
  const rsi=rsiDaily(row), short=shortAvailable(row), splitDate=String(row?.splitDate||'');
  const elapsed=calendarDays(splitDate,nowDate);
  const seq=splitDate?detectErtikazSequence(bars,splitDate):{base:null,resistance:null,support:null,liquidity:null};
  const checks=[
    {key:'rsi',label:'RSI يومي أقل من 30',passed:rsi!==null&&rsi<30,value:rsi===null?null:Number(rsi.toFixed(2)),detail:rsi===null?'RSI غير متاح':`RSI اليومي ${rsi.toFixed(2)} ${rsi<30?'أقل من 30':'ليس أقل من 30'}`},
    {key:'shortAvailable',label:'Short Available ≤ 10,000',passed:short!==null&&short<=10000,value:short,detail:short===null?'Short Available غير متاح':`${short.toLocaleString()} سهم متاح`},
    {key:'splitDays',label:'أيام منذ التقسيم 20 / 30 / 50',passed:elapsed!==null&&elapsed>=20,value:elapsed,detail:elapsed===null?'تاريخ التقسيم غير متاح':`${elapsed} يومًا منذ ${splitDate}` ,milestones:{20:elapsed!==null&&elapsed>=20,30:elapsed!==null&&elapsed>=30,50:elapsed!==null&&elapsed>=50}},
    {key:'baseHold',label:'المحافظة على القاع 5 جلسات تداول فعلية',passed:Boolean(seq.base?.holdConfirmed),value:seq.base?.price??null,detail:seq.base?`قاع ${seq.base.price.toFixed(4)} — ${seq.base.holdConfirmed?`ثبت حتى ${seq.base.holdThrough}`:`لم يكتمل الثبات (${seq.base.holdSessions}/5 جلسات)`}`:'لم يتم تحديد قاع'},
    {key:'resistance',label:'اختبار المقاومة +15% إلى +25% من القاع',passed:Boolean(seq.resistance),value:seq.resistance?.high??null,detail:seq.resistance?`اختبار ${seq.resistance.high.toFixed(4)} — المنطقة ${seq.resistance.zoneLow.toFixed(4)} إلى ${seq.resistance.zoneHigh.toFixed(4)}`:'لم يحدث اختبار مقاومة ضمن المنطقة المحددة'},
    {key:'supportRetest',label:'العودة لاختبار الدعم دون كسر القاع وبحد أقصى +5%',passed:Boolean(seq.support),value:seq.support?.price??null,detail:seq.support?`إعادة اختبار ${seq.support.price.toFixed(4)} بعد المقاومة`:'لم تحدث إعادة اختبار للدعم بعد المقاومة'},
    {key:'liquiditySweep',label:'سحب سيولة حتى 10% تحت القاع والعودة خلال جلسة أو أقل',passed:Boolean(seq.liquidity),value:seq.liquidity?.sweepPct??null,detail:seq.liquidity?`آخر سحب ${seq.liquidity.sweepPct.toFixed(2)}% إلى ${seq.liquidity.sweepLow.toFixed(4)} ثم عودة ${seq.liquidity.recoveryClose.toFixed(4)} في ${seq.liquidity.recoveryDate} — إجمالي السحوبات ${seq.liquiditySweeps?.length||0}`:'لم يتحقق سحب السيولة بالتسلسل المطلوب — يجب أن يسبق كل سحب لاحق جلستان كاملتان فوق القاع'}
  ];
  const all=checks.every(x=>x.passed);
  const name=String(row?.name||row?.companyName||row?.company_name||'');
  return {version:1,ticker,name,model:'ارتكاز',qualified:all,statusLabel:all?'ارتكاز مكتمل':'ارتكاز — شروط غير مكتملة',splitDate,elapsedDays:elapsed,rsiDaily:rsi,shortAvailable:short,base:seq.base,resistance:seq.resistance,supportRetest:seq.support,liquiditySweep:seq.liquidity,liquiditySweeps:seq.liquiditySweeps||[],checks,passedCount:checks.filter(x=>x.passed).length,totalChecks:checks.length,lastDailyDate:bars.at(-1)?.date||null,barsDailyCount:bars.length,updatedAt:new Date().toISOString()};
}

export async function getErtikazConfig(){
  const raw=await getDataStore().get(CONFIG_KEY,{type:'json',consistency:'strong'}).catch(()=>null);
  return{version:2,historyTimeframe:'1D'};
}
export async function saveErtikazConfig(){
  await getDataStore().setJSON(CONFIG_KEY,{version:2,historyTimeframe:'1D',updatedAt:new Date().toISOString()});
  return getErtikazConfig();
}
export async function collectErtikazData({force=false}={}){
  const store=getDataStore(),cache=await getCache(),now=todayET();
  const rows=Array.isArray(cache?.records)?cache.records:[];
  const tickers=[...new Set(rows.map(x=>cleanTicker(x?.ticker)).filter(Boolean))];
  if(!tickers.length)return{ok:false,error:'لا توجد أسهم في الكاش المركزي.'};
  let index=0,processed=0,updated=0,unchanged=0,failed=0; const histories={};
  await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',timeframe:'1D',date:now,total:tickers.length,processed:0,updated:0,unchanged:0,failed:0});
  const byTicker=new Map(rows.map(x=>[cleanTicker(x?.ticker),x]));
  const worker=async()=>{while(true){const i=index++;if(i>=tickers.length)return;const t=tickers[i];const row=byTicker.get(t)||{};try{
    const splitDate=String(row?.splitDate||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(splitDate))throw new Error('تاريخ التقسيم غير متاح');
    const old=await loadHistory(t); let bars=Array.isArray(old?.bars)?old.bars:[];
    const from=old?.initialized&&bars.length?(old?.lastDate||splitDate):splitDate;
    if(old?.initialized){
      const fresh=await fetchDaily(t,from,now); const map=new Map(bars.map(x=>[x.t,x])); for(const x of fresh)map.set(x.t,x); bars=[...map.values()].sort((a,z)=>a.t-z.t); updated++; if(!fresh.length)unchanged++;
    }else{
      bars=await fetchDaily(t,splitDate,now); updated++;
    }
    bars=bars.filter(x=>x.date>=splitDate);
    await saveHistory(t,{version:2,timeframe:'1D',ticker:t,splitDate,initialized:true,bars,updatedAt:new Date().toISOString(),lastDate:bars.at(-1)?.date||null});
    histories[t]={ticker:t,row,bars};
  }catch(e){failed++;histories[t]={ticker:t,row,bars:[],error:String(e?.message||e)};}processed++;if(processed%10===0||processed===tickers.length)await store.setJSON(STATUS_KEY,{state:'collecting',mode:'data',timeframe:'1D',date:now,total:tickers.length,processed,updated,unchanged,failed});}};
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,tickers.length)},worker)); return{ok:true,date:now,timeframe:'1D',total:tickers.length,processed,updated,unchanged,failed,histories};
}
export async function runErtikaz({force=false}={}){
  const today=todayET(),store=getDataStore();
  if(!force){const settings=await getSiteSettings();if(settings.auto_update_enabled===false||settings.ertikazAutoUpdateEnabled===false)return{ok:true,skipped:true,reason:'ertikaz-automatic-updates-disabled'};}
  if(!force){const existing=await store.get(RESULT_KEY,{type:'json',consistency:'strong'}).catch(()=>null);if(existing?.date===today)return{ok:true,skipped:true,date:today,total:Number(existing.universeTickers||0)};}
  const collected=await collectErtikazData({force}); if(!collected.ok)return collected;
  const results=[];let done=0; await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',timeframe:'1D',date:today,total:collected.total,processed:0});
  for(const t of Object.keys(collected.histories||{})){
    const h=collected.histories[t];
    results.push(h.error?{version:1,ticker:t,model:'ارتكاز',qualified:false,statusLabel:'ارتكاز — بيانات غير مكتملة',passedCount:0,totalChecks:7,error:h.error,checks:[]} : evaluateErtikazRules(t,h.row,h.bars,today));
    done++;if(done%10===0||done===collected.total)await store.setJSON(STATUS_KEY,{state:'analyzing',mode:'analysis',date:today,total:collected.total,processed:done,collection:{updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});
  }
  const payload={version:1,ready:true,date:today,updatedAt:new Date().toISOString(),universeTickers:results.length,qualifiedCount:results.filter(x=>x.qualified).length,records:results.sort((a,b)=>a.ticker.localeCompare(b.ticker)),source:'central-cache-daily-rsi-short-plus-massive-daily-sequence',components:['Daily RSI','Short Available','Calendar days since split','Daily base hold 5 trading sessions','Daily resistance +15% to +25% at any later candle while the base is not broken','Daily support retest <=5% above base on the next or second candle after resistance','Daily liquidity sweep <=10% below base with recovery <=1 session; actual sweep depth is recorded; >10% invalidates the base']};
  await store.setJSON(RESULT_KEY,payload);await store.setJSON(STATUS_KEY,{state:'ready',mode:'analysis',timeframe:'1D',date:today,completedAt:payload.updatedAt,total:results.length,processed:results.length,qualifiedCount:payload.qualifiedCount,collection:{updated:collected.updated,unchanged:collected.unchanged,failed:collected.failed}});
  return{ok:true,date:today,total:results.length,processed:results.length,qualified:payload.qualifiedCount,updatedAt:payload.updatedAt};
}
export async function readErtikaz(){return await getDataStore().get(RESULT_KEY,{type:'json',consistency:'strong'}).catch(()=>null);}
export async function readErtikazStatus(){return await getDataStore().get(STATUS_KEY,{type:'json',consistency:'strong'}).catch(()=>null);}
