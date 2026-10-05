// US equity market calendar helpers. Times are interpreted in America/New_York.
function utcDate(year, month, day){return new Date(Date.UTC(year, month-1, day));}
function nthWeekday(year, month, weekday, nth){
  const d=utcDate(year,month,1); const shift=(weekday-d.getUTCDay()+7)%7; d.setUTCDate(1+shift+(nth-1)*7); return d;
}
function lastWeekday(year, month, weekday){
  const d=new Date(Date.UTC(year,month,0)); const shift=(d.getUTCDay()-weekday+7)%7; d.setUTCDate(d.getUTCDate()-shift); return d;
}
function easterSunday(year){
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return utcDate(year,month,day);
}
function observedWeekday(d){
  const x=new Date(d.getTime()), day=x.getUTCDay();
  if(day===6)x.setUTCDate(x.getUTCDate()-1);
  else if(day===0)x.setUTCDate(x.getUTCDate()+1);
  return x;
}
function key(d){return d.toISOString().slice(0,10);}
export function usEquityMarketHolidays(year){
  const holidays=[];
  holidays.push(utcDate(year,1,1)); // New Year's Day
  holidays.push(nthWeekday(year,1,1,3)); // MLK Day
  holidays.push(nthWeekday(year,2,1,3)); // Presidents Day
  holidays.push(lastWeekday(year,5,1)); // Memorial Day
  holidays.push(utcDate(year,6,19)); // Juneteenth
  holidays.push(utcDate(year,7,4)); // Independence Day
  holidays.push(nthWeekday(year,9,1,1)); // Labor Day
  holidays.push(nthWeekday(year,11,4,4)); // Thanksgiving
  holidays.push(utcDate(year,12,25)); // Christmas
  const easter=easterSunday(year); const goodFriday=new Date(easter.getTime()-2*86400000); holidays.push(goodFriday);
  return new Set(holidays.map(observedWeekday).map(key));
}
export function isUsEquityMarketHoliday(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(x=>[x.type,x.value]));
  const y=Number(parts.year); const dateKey=`${parts.year}-${parts.month}-${parts.day}`;
  return usEquityMarketHolidays(y-1).has(dateKey)||usEquityMarketHolidays(y).has(dateKey)||usEquityMarketHolidays(y+1).has(dateKey);
}
export function isUsEquityTradingDay(date=new Date()){
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(date);
  return weekday!=='Sat'&&weekday!=='Sun'&&!isUsEquityMarketHoliday(date);
}
export function marketSession(date=new Date()){
  if(!isUsEquityTradingDay(date))return 'closed';
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
  const mins=Number(p.hour)*60+Number(p.minute);
  if(mins>=240&&mins<570)return 'pre';
  if(mins>=570&&mins<960)return 'regular';
  if(mins>=960&&mins<1200)return 'after';
  return 'closed';
}
