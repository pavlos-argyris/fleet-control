import {aggregateStoreFinancials} from '../cloudflare-worker/src/store-financial-report.js';
import {list,reply,NativeError,text,day,range,actor,audit,stamp,addDay,integer,hash} from './common.js';
export const REPORT_SCHEMA="CREATE TABLE IF NOT EXISTS native_store_aliases(scope TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,PRIMARY KEY(scope,source_id));";
const native=globalThis.FleetHost;
const periodKey=(d,period)=>period==='day'?d:period==='month'?d.slice(0,7):addDay(d,-((new Date(d+'T12:00:00Z').getUTCDay()+6)%7));
async function scopeFor(url){const current=native('store.context');if(!current.configured||!current.scope)throw new NativeError(503,'Ρύθμισε πρώτα την ανάγνωση καταστημάτων στον Server.');const requested=url.searchParams.get('scope');if(requested&&requested!==current.scope)throw new NativeError(409,'Άλλαξε η ενεργή πηγή καταστημάτων. Άνοιξε ξανά την αναφορά.');return current.scope;}
export async function storeReport(env,{from,to,period='day',scope,storeId=''}){
  day(from);day(to);if(!['day','week','month'].includes(period))throw new NativeError(400,'Επίλεξε ημέρα, εβδομάδα ή μήνα.');
  const catalog=list(await env.DB.prepare("SELECT store_id,data FROM store_billing_local WHERE scope=? AND kind='store' ORDER BY store_id").bind(scope).all());
  if(!catalog.length)throw new NativeError(409,'Δεν έχει αποθηκευτεί ακόμη κατάλογος καταστημάτων.');
  const names=Object.fromEntries(catalog.map(r=>[r.store_id,JSON.parse(r.data).name||r.store_id]));
  const aliasRows=list(await env.DB.prepare('SELECT source_id,target_id,revision FROM native_store_aliases WHERE scope=?').bind(scope).all()),aliases=Object.fromEntries(aliasRows.map(r=>[r.source_id,r.target_id]));
  const stores=catalog.filter(s=>!storeId||s.store_id===storeId||aliases[s.store_id]===storeId);
  if(!stores.length)throw new NativeError(404,'Το κατάστημα δεν υπάρχει στην ενεργή πηγή.');
  const stored=list(await env.DB.prepare("SELECT store_id,day,data FROM store_billing_local WHERE scope=? AND kind='local_day' AND day BETWEEN ? AND ? ORDER BY day,store_id").bind(scope,from,to).all());
  const coverage=new Map(list(await env.DB.prepare("SELECT day,data FROM store_billing_local WHERE scope=? AND kind='coverage' AND day BETWEEN ? AND ?").bind(scope,from,to).all()).map(r=>[r.day,JSON.parse(r.data)]));
  const pending=new Set(list(await env.DB.prepare("SELECT day FROM store_billing_local WHERE scope=? AND kind='outbox' AND day BETWEEN ? AND ?").bind(scope,from,to).all()).map(r=>r.day));
  const snapshots=new Map(stored.map(r=>[r.day+'|'+r.store_id,JSON.parse(r.data)]));
  const daily=[],valid=[],missing=new Map(),issues=[];
  for(let d=from;d<=to;d=addDay(d,1))for(const shop of stores){
    const snapshot=snapshots.get(d+'|'+shop.store_id),proof=coverage.get(d),canonical=aliases[shop.store_id]||shop.store_id,key=periodKey(d,period)+'|'+canonical;
    let reason='',monetary=false;
    if(!snapshot)reason='Δεν έχει υπολογιστεί η ημέρα.';
    else if(!proof||proof.needsSourceRefresh||!proof.sourceAt||snapshot.sourceLastSuccessAt!==proof.sourceAt)reason='Δεν έχει επαληθευτεί πλήρης ανάγνωση της ημέρας.';
    else if(snapshot.storeId!==shop.store_id||snapshot.businessDay!==d||snapshot.cutoffHour!==5||snapshot.timeZone!=='Europe/Athens')reason='Ασύμβατο ημερήσιο στιγμιότυπο.';
    else if(snapshot.orderCount===0&&(snapshot.orderChargeCents!==0||snapshot.minimumTopUpCents!==0||snapshot.totalChargeCents!==0))reason='Παλιότερο αποτέλεσμα με χρέωση σε μηδενική ημέρα· χρειάζεται επανυπολογισμός.';
    else if(snapshot.billingState==='needs_terms'||[snapshot.orderChargeCents,snapshot.minimumTopUpCents,snapshot.totalChargeCents].some(n=>n===null||!Number.isSafeInteger(n)||n<0))reason='Χρειάζεται έλεγχος ιστορικών όρων χρέωσης.';
    else if(snapshot.orderChargeCents+snapshot.minimumTopUpCents!==snapshot.totalChargeCents)reason='Τα μέρη της ημερήσιας χρέωσης δεν συμφωνούν.';
    else monetary=true;
    if(!monetary){missing.set(key,(missing.get(key)||0)+1);issues.push({storeId:shop.store_id,day:d,reason});}
    const row={storeId:shop.store_id,storeName:names[shop.store_id],canonicalStoreId:canonical,day:d,orderCount:monetary?snapshot.orderCount:null,orderChargeCents:monetary?snapshot.orderChargeCents:null,minimumTopUpCents:monetary?snapshot.minimumTopUpCents:null,totalChargeCents:monetary?snapshot.totalChargeCents:null,termsId:snapshot?.termsId||null,coverageVerified:monetary,published:monetary&&!pending.has(d),sourceAt:proof?.sourceAt||null,reason,reviewCount:snapshot?.reviewCount||0};
    daily.push(row);if(monetary)valid.push(row);
  }
  const aggregated=aggregateStoreFinancials({daily:valid,from,to,period,aliases}),groups=new Map(aggregated.groups.map(g=>[g.period+'|'+g.storeId,g]));
  for(const row of daily){const key=periodKey(row.day,period)+'|'+row.canonicalStoreId;if(!groups.has(key))groups.set(key,{period:periodKey(row.day,period),storeId:row.canonicalStoreId,sourceStoreIds:[],days:0,orderCount:0,orderChargeCents:0,minimumTopUpCents:0,totalChargeCents:0});const g=groups.get(key);if(!g.sourceStoreIds.includes(row.storeId))g.sourceStoreIds.push(row.storeId);}
  const result=[...groups.entries()].map(([key,g])=>{const unknown=missing.get(key)||0;return{...g,storeName:names[g.storeId]||g.storeId,knownOrderCount:g.orderCount,knownTotalCents:g.totalChargeCents,unknownDays:unknown,coverageVerified:unknown===0,complete:unknown===0,...(unknown?{orderCount:null,orderChargeCents:null,minimumTopUpCents:null,totalChargeCents:null}:{})};}).sort((a,b)=>a.period.localeCompare(b.period)||a.storeName.localeCompare(b.storeName));
  const revision=await hash({scope,from,to,period,storeId,aliasRows,names,daily});
  const totals={knownOrders:valid.reduce((s,r)=>s+r.orderCount,0),knownTotalCents:valid.reduce((s,r)=>s+r.totalChargeCents,0),knownDays:valid.length,unknownDays:issues.length,complete:issues.length===0};
  return {from,to,period,scope,revision,totals,timeZone:'Europe/Athens',cutoffHour:5,groups:result,daily,issues,aliases:aliasRows,complete:issues.length===0,coverageVerified:issues.length===0,observedAt:stamp(),source:'server-local-daily-snapshots'};
}
export async function routeReports(request,env){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/native/store-financials'))return null;
  if(url.pathname==='/api/native/store-financials/export')return null;
  const user=await actor(request,env,request.method==='GET'?'stores.view':'stores.manage'),scope=await scopeFor(url);
  if(url.pathname==='/api/native/store-financials/alias'&&request.method==='POST'){
    const b=await request.json(),source=text(b.sourceId,200),target=text(b.targetId,200),expected=integer(b.expectedRevision);
    if(!source||!target||source===target)throw new NativeError(400,'Διάλεξε δύο διαφορετικά σταθερά IDs καταστημάτων.');
    const catalog=list(await env.DB.prepare("SELECT store_id FROM store_billing_local WHERE scope=? AND kind='store' AND store_id IN (?,?)").bind(scope,source,target).all());if(catalog.length!==2)throw new NativeError(400,'Τα καταστήματα δεν ανήκουν στην ενεργή πηγή.');
    if(await env.DB.prepare('SELECT 1 found FROM native_store_aliases WHERE scope=? AND (source_id=? OR target_id=?)').bind(scope,target,source).first())throw new NativeError(409,'Δεν επιτρέπονται αλυσίδες ή κύκλοι αντιστοιχίσεων.');
    const before=await env.DB.prepare('SELECT * FROM native_store_aliases WHERE scope=? AND source_id=?').bind(scope,source).first();if(Number(before?.revision||0)!==expected)throw new NativeError(409,'Η αντιστοίχιση άλλαξε. Άνοιξε ξανά την αναφορά.');
    // Preflight is for a useful conflict message; the SQLite write itself must
    // reject stale drafts from a second administrator, including first inserts.
    const saved=await env.DB.prepare('INSERT INTO native_store_aliases(scope,source_id,target_id,revision,updated_at,updated_by) SELECT ?,?,?,?,?,? WHERE ?=COALESCE((SELECT revision FROM native_store_aliases WHERE scope=? AND source_id=?),0) ON CONFLICT(scope,source_id) DO UPDATE SET target_id=excluded.target_id,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE native_store_aliases.revision=?').bind(scope,source,target,expected+1,stamp(),user.user_id,expected,scope,source,expected).run();
    if(Number(saved?.meta?.changes)!==1)throw new NativeError(409,'Η αντιστοίχιση άλλαξε. Άνοιξε ξανά την αναφορά.','alias_conflict');
    await audit(env,request,user,'store_report_alias','store_alias',source,before,{targetId:target,revision:expected+1},text(b.notes,500));return reply({saved:true,revision:expected+1});
  }
  if(url.pathname==='/api/native/store-financials'&&request.method==='GET'){const {from,to}=range(url),offset=integer(Number(url.searchParams.get('offset')||0),0,15000),report=await storeReport(env,{from,to,period:url.searchParams.get('period')||'day',scope,storeId:text(url.searchParams.get('storeId'),200)});if(url.searchParams.get("revision")&&url.searchParams.get("revision")!==report.revision)throw new NativeError(409,"Η αναφορά ενημερώθηκε. Φόρτωσέ την ξανά από την αρχή.");return reply({...report,groups:report.groups.slice(offset,offset+200),daily:report.daily.slice(offset,offset+200),issues:report.issues.slice(0,100),groupCount:report.groups.length,dailyCount:report.daily.length,issueCount:report.issues.length,offset,hasMore:offset+200<report.groups.length,hasMoreDaily:offset+200<report.daily.length});}
  throw new NativeError(404,'Η αναφορά δεν βρέθηκε.');
}
