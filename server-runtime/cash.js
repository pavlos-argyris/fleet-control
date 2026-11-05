import {list,reply,NativeError,text,day,range,integer,actor,audit,stamp} from './common.js';

export const CASH_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_cash_rules(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,category TEXT NOT NULL,effective_day TEXT NOT NULL,revision INTEGER NOT NULL,rate_cents INTEGER NOT NULL CHECK(rate_cents>=0),created_at TEXT NOT NULL,created_by TEXT NOT NULL,UNIQUE(store_id,category,effective_day,revision));
CREATE INDEX IF NOT EXISTS native_cash_rules_lookup ON native_cash_rules(store_id,category,effective_day DESC,revision DESC);
CREATE TABLE IF NOT EXISTS native_cash_events(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('assessment','receipt','reversal')),business_day TEXT NOT NULL,courier_id TEXT NOT NULL,courier_name TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0),rate_cents INTEGER NOT NULL DEFAULT 0 CHECK(rate_cents>=0),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),rule_id TEXT,reverses_id TEXT UNIQUE,source_key TEXT UNIQUE,notes TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS native_cash_day ON native_cash_events(business_day,courier_id,created_at);
CREATE TRIGGER IF NOT EXISTS native_cash_events_immutable_update BEFORE UPDATE ON native_cash_events BEGIN SELECT RAISE(ABORT,'cash_events_are_immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_events_immutable_delete BEFORE DELETE ON native_cash_events BEGIN SELECT RAISE(ABORT,'cash_events_are_immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_rules_immutable_update BEFORE UPDATE ON native_cash_rules BEGIN SELECT RAISE(ABORT,'cash_rules_are_versioned'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_rules_immutable_delete BEFORE DELETE ON native_cash_rules BEGIN SELECT RAISE(ABORT,'cash_rules_are_versioned'); END;
`;

async function rule(request,env,user){
  const b=await request.json(),store=text(b.storeId,200),category=text(b.category,80),effectiveDay=day(b.effectiveDay),rate=integer(b.rateCents),expected=integer(b.expectedRevision);
  if(!store||!category)throw new NativeError(400,'Επίλεξε κατάστημα και κατηγορία.');
  // Explicit stable Fleet store IDs only. Names never silently create aliases.
  const exists=await env.DB.prepare("SELECT 1 found FROM store_billing_records WHERE kind='store' AND store_id=?").bind(store).first();
  if(!exists)throw new NativeError(400,'Το κατάστημα δεν βρέθηκε. Ενημέρωσε πρώτα τον κατάλογο καταστημάτων.');
  const previous=await env.DB.prepare('SELECT * FROM native_cash_rules WHERE store_id=? AND category=? AND effective_day=? ORDER BY revision DESC LIMIT 1').bind(store,category,effectiveDay).first();
  if(Number(previous?.revision||0)!==expected)throw new NativeError(409,'Ο κανόνας άλλαξε. Το προσχέδιο διατηρήθηκε.','rule_conflict');
  const id=crypto.randomUUID(),value={id,storeId:store,category,effectiveDay,rateCents:rate,revision:expected+1};
  await env.DB.prepare('INSERT INTO native_cash_rules(id,store_id,category,effective_day,revision,rate_cents,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)').bind(id,store,category,effectiveDay,expected+1,rate,stamp(),user.user_id).run();
  await audit(env,request,user,'cash_rule_version','cash_rule',id,previous,value,'Νέα έκδοση κανόνα· οι παλιές κινήσεις διατηρούν την τιμή τους');return reply({saved:true,rule:value},201);
}
async function event(request,env,user){
  const b=await request.json(),kind=b.kind;if(!['assessment','receipt','reversal'].includes(kind))throw new NativeError(400,'Επίλεξε είδος κίνησης.');
  let businessDay,courierId,courierName,store='',category='',quantity=0,rate=0,amount=0,ruleId=null,reverses=null;
  const notes=text(b.notes,500);if(!notes)throw new NativeError(400,'Γράψε σύντομη αιτιολογία της καταχώρισης.');
  if(kind==='reversal'){
    const original=await env.DB.prepare('SELECT * FROM native_cash_events WHERE id=?').bind(text(b.reversesId,100)).first();
    if(!original||original.kind==='reversal')throw new NativeError(400,'Επίλεξε αρχική κίνηση για αντιλογισμό.');
    if(await env.DB.prepare('SELECT id FROM native_cash_events WHERE reverses_id=?').bind(original.id).first())throw new NativeError(409,'Η κίνηση έχει ήδη αντιλογιστεί.');
    businessDay=original.business_day;courierId=original.courier_id;courierName=original.courier_name;store=original.store_id;category=original.category;quantity=original.quantity;rate=original.rate_cents;amount=original.amount_cents;ruleId=original.rule_id;reverses=original.id;
  }else{
    businessDay=day(b.day);courierId=text(b.courierId,100);const employee=await env.DB.prepare('SELECT id,full_name,deleted_at FROM app_users WHERE id=?').bind(courierId).first();
    if(!employee)throw new NativeError(400,'Ο διανομέας δεν βρέθηκε.');courierName=employee.full_name;
    if(kind==='assessment'){
      if(employee.deleted_at)throw new NativeError(409,'Ο εργαζόμενος είναι αρχειοθετημένος. Επίλεξε ενεργό διανομέα.');
      store=text(b.storeId,200);category=text(b.category,80);quantity=integer(b.quantity,1,1000000);
      const selected=await env.DB.prepare('SELECT * FROM native_cash_rules WHERE store_id=? AND category=? AND effective_day<=? ORDER BY effective_day DESC,revision DESC LIMIT 1').bind(store,category,businessDay).first();
      if(!selected)throw new NativeError(409,'Δεν υπάρχει κανόνας απόδοσης για το συγκεκριμένο κατάστημα, κατηγορία και ημέρα.');
      rate=selected.rate_cents;ruleId=selected.id;amount=integer(quantity*rate,0,Number.MAX_SAFE_INTEGER);
      if(b.ruleId!==ruleId)throw new NativeError(409,'Άλλαξε η τιμή απόδοσης. Έλεγξε τη νέα τιμή πριν αποθήκευση.','rule_conflict');
    }else amount=integer(b.amountCents,1,100000000);
  }
  const id=crypto.randomUUID(),at=stamp();
  await env.DB.prepare('INSERT INTO native_cash_events(id,kind,business_day,courier_id,courier_name,store_id,category,quantity,rate_cents,amount_cents,rule_id,reverses_id,source_key,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,kind,businessDay,courierId,courierName,store,category,quantity,rate,amount,ruleId,reverses,kind==='assessment'?'manual:'+id:null,notes,user.user_id,user.full_name||user.username,at).run();
  await audit(env,request,user,'cash_'+kind,'cash_event',id,null,{kind,businessDay,courierId,storeId:store,category,quantity,rateCents:rate,amountCents:amount,reversesId:reverses},notes);
  return reply({saved:true,id},201);
}
export async function cashProjection(env,from,to,courierId=''){
  const events=list(await env.DB.prepare(`SELECT e.*,o.kind reversed_kind FROM native_cash_events e LEFT JOIN native_cash_events o ON o.id=e.reverses_id WHERE e.business_day BETWEEN ? AND ? ${courierId?'AND e.courier_id=?':''} ORDER BY e.business_day,e.created_at,e.id`).bind(...(courierId?[from,to,courierId]:[from,to])).all());
  const couriers=new Map();
  for(const e of events){
    if(!couriers.has(e.courier_id))couriers.set(e.courier_id,{courierId:e.courier_id,courierName:e.courier_name,orders:0,dueCents:0,receivedCents:0,balanceCents:0,breakdown:[]});
    const c=couriers.get(e.courier_id),sign=e.kind==='reversal'?-1:1,kind=e.kind==='reversal'?e.reversed_kind:e.kind;
    if(kind==='assessment'){
      c.orders+=sign*e.quantity;c.dueCents+=sign*e.amount_cents;
      let group=c.breakdown.find(r=>r.storeId===e.store_id&&r.category===e.category);if(!group){group={storeId:e.store_id,category:e.category,orders:0,dueCents:0};c.breakdown.push(group);}group.orders+=sign*e.quantity;group.dueCents+=sign*e.amount_cents;
    }else c.receivedCents+=sign*e.amount_cents;
    c.balanceCents=c.dueCents-c.receivedCents;
    for(const n of [c.orders,c.dueCents,c.receivedCents,c.balanceCents])if(!Number.isSafeInteger(n))throw new NativeError(413,'Το ποσό υπερβαίνει το επιτρεπόμενο όριο αναφοράς.');
  }
  return {from,to,timeZone:'Europe/Athens',cutoffHour:5,source:'manual-confirmed',automaticOrderMappingVerified:false,couriers:[...couriers.values()],events,observedAt:stamp()};
}
export async function routeCash(request,env){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/native/cash'))return null;
  if(url.pathname==='/api/native/cash/export')return null;
  const user=await actor(request,env,request.method==='GET'?'cash.view':'cash.manage');
  if(url.pathname==='/api/native/cash/rules'){
    if(request.method==='POST')return rule(request,env,user);
    if(request.method==='GET')return reply({rules:list(await env.DB.prepare('SELECT * FROM native_cash_rules ORDER BY store_id,category,effective_day DESC,revision DESC').all()),employees:list(await env.DB.prepare('SELECT id,full_name,active,deleted_at FROM app_users ORDER BY full_name').all()),stores:list(await env.DB.prepare("SELECT store_id,data FROM store_billing_records WHERE kind='store' ORDER BY store_id").all()).map(s=>({id:s.store_id,name:JSON.parse(s.data).name||s.store_id})),automaticOrderMappingVerified:false});
  }
  if(url.pathname==='/api/native/cash/events'&&request.method==='POST')return event(request,env,user);
  if(url.pathname==='/api/native/cash'&&request.method==='GET'){const {from,to}=range(url);return reply(await cashProjection(env,from,to,text(url.searchParams.get('courierId'),100)));}
  throw new NativeError(404,'Η ενέργεια ταμείου δεν βρέθηκε.');
}
