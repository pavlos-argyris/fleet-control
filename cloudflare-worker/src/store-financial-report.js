// Read-only finance projection from the Server's existing daily monetary snapshots.
// Does not re-price individual orders or query Ordexa/D1.
const assertDay=d=>{if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d+'T12:00:00Z'))||new Date(d+'T12:00:00Z').toISOString().slice(0,10)!==d)throw new TypeError('Invalid business day');return d;};
const addDays=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const validMoney=(n,label)=>{if(n===null)return null;if(!Number.isSafeInteger(n)||n<0)throw new TypeError('Invalid '+label);return n;};
const sum=(a,b)=>{const s=a+b;if(!Number.isSafeInteger(s))throw new RangeError('Reporting sum overflow');return s;};
const periodKey=(day,period)=>period==='day'?day:period==='month'?day.slice(0,7):addDays(day,-((new Date(day+'T12:00:00Z').getUTCDay()+6)%7));
export function aggregateStoreFinancials({daily=[],from,to,period='day',aliases={}}={}){
 assertDay(from);assertDay(to);if(from>to)throw new RangeError('Invalid range');
 if(!['day','week','month'].includes(period)||!Array.isArray(daily)||!aliases||Array.isArray(aliases)||typeof aliases!=='object')throw new TypeError('Invalid reporting input');
 const seen=new Map(),groups=new Map();
 for(const row of daily){
  if(!row||typeof row.storeId!=='string'||!row.storeId||typeof row.day!=='string')throw new TypeError('Invalid store/day');
  const day=assertDay(row.day),storeId=row.storeId;
  if(day<from||day>to)continue;
  const identity=JSON.stringify([storeId,day]),serialized=JSON.stringify(row);
  if(seen.has(identity)){if(seen.get(identity)!==serialized)throw new Error('Conflicting daily snapshot '+identity);continue;}
  seen.set(identity,serialized);
  const count=row.orderCount;
  if(!Number.isSafeInteger(count)||count<0)throw new TypeError('Invalid order count');
  const order=validMoney(row.orderChargeCents,'order charge'),topup=validMoney(row.minimumTopUpCents,'minimum top-up'),total=validMoney(row.totalChargeCents,'total');
  if(count===0&&(order!==0||topup!==0||total!==0))throw new Error('Zero orders must not generate charges or minimum top-up');
  if(total!==null&&order!==null&&topup!==null&&total!==sum(order,topup))throw new Error('Daily components do not balance');
  const canonical=Object.hasOwn(aliases,storeId)?aliases[storeId]:storeId;
  if(typeof canonical!=='string'||!canonical||canonical.length>180)throw new TypeError('Invalid explicit store alias');
  const key=JSON.stringify([periodKey(day,period),canonical]);
  if(!groups.has(key))groups.set(key,{period:periodKey(day,period),storeId:canonical,sourceStoreIds:[],days:0,orderCount:0,orderChargeCents:0,minimumTopUpCents:0,totalChargeCents:0,incompleteDays:0});
  const g=groups.get(key);if(!g.sourceStoreIds.includes(storeId))g.sourceStoreIds.push(storeId);
  g.days++;g.orderCount=sum(g.orderCount,count);
  if(order===null||topup===null||total===null){g.incompleteDays++;continue;}
  g.orderChargeCents=sum(g.orderChargeCents,order);g.minimumTopUpCents=sum(g.minimumTopUpCents,topup);g.totalChargeCents=sum(g.totalChargeCents,total);
 }
 const list=[...groups.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.storeId.localeCompare(b.storeId)).map(g=>({...g,sourceStoreIds:g.sourceStoreIds.sort(),complete:g.incompleteDays===0,coverageVerified:false,...(g.incompleteDays?{totalChargeCents:null,minimumTopUpCents:null,orderChargeCents:null}:{})}));
 return {from,to,period,groups:list,complete:list.every(g=>g.complete),coverageVerified:false,notice:'Only supplied Server snapshots were aggregated. Missing days and historical source coverage require explicit external verification.'};
}
