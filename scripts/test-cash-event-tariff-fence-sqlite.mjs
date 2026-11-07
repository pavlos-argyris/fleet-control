import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {CASH_SCHEMA,CASH_EVENT_INSERT_SQL} from '../server-runtime/cash.js';

// Run the exact native cash INSERT and schema in isolated, real SQLite.
// The preflight is intentionally separated from the write: a second admin
// can insert a new tariff between them, and the old assessment must not land.
const probe=String.raw`
import json,sqlite3,sys
source=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
for sql in source['schema'].splitlines():
 sql=sql.strip()
 if sql: db.execute(sql)
insert=source['insert']
cols=['id','kind','business_day','courier_id','courier_name','store_id','category','quantity','rate_cents','amount_cents','rule_id','reverses_id','source_key','notes','actor_id','actor_name','created_at']
base=dict(id='a1',kind='assessment',business_day='2026-11-04',courier_id='courier-1',courier_name='Courier',store_id='store-1',category='A',quantity=2,rate_cents=250,amount_cents=500,rule_id='r1',reverses_id=None,source_key=None,notes='fixture',actor_id='admin-1',actor_name='Admin',created_at='2026-11-04T12:00:00Z')
def tariff(id,day,rev,rate):
 db.execute('INSERT INTO native_cash_rules(id,store_id,category,effective_day,revision,rate_cents,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)',(id,'store-1','A',day,rev,rate,'2026-11-04T12:00:00Z','admin-2'))
def put(**change):
 row=dict(base,**change)
 before=db.execute('SELECT COUNT(*) FROM native_cash_events').fetchone()[0]
 args=[row[k] for k in cols]+[row['kind'],row['rule_id'],row['store_id'],row['category'],row['business_day']]
 assert insert.count('?')==len(args),'production insert bind count changed'
 db.execute(insert,args)
 delta=db.execute('SELECT changes()').fetchone()[0]
 assert db.execute('SELECT COUNT(*) FROM native_cash_events').fetchone()[0]==before+delta
 return delta
tariff('r1','2026-11-01',1,250)
assert put()==1
# Same-day version change occurs after the first administrator's preflight.
tariff('r2','2026-11-01',2,300)
assert put(id='stale-same-day')==0
assert put(id='a2',rule_id='r2',rate_cents=300,amount_cents=600)==1
# Backdated rule can also supersede a previously selected tariff.
tariff('r3','2026-11-03',1,350)
assert put(id='stale-backdated',rule_id='r2',rate_cents=300,amount_cents=600)==0
assert put(id='a3',rule_id='r3',rate_cents=350,amount_cents=700)==1
# A future rule must not retroactively invalidate the November 4 tariff.
tariff('r4','2026-11-05',1,400)
assert put(id='a4',rule_id='r3',rate_cents=350,amount_cents=700)==1
# A missing or wrong-store tariff is never silently accepted.
assert put(id='missing-rule',rule_id='unknown')==0
assert put(id='wrong-store',store_id='store-2',rule_id='r3')==0
# Cash receipts and their exact reversals are not blocked by tariff changes.
receipt=dict(id='receipt-1',kind='receipt',quantity=0,rate_cents=0,amount_cents=300,store_id='',category='',rule_id=None)
assert put(**receipt)==1
assert put(id='reverse-receipt',kind='reversal',quantity=0,rate_cents=0,amount_cents=300,store_id='',category='',rule_id=None,reverses_id='receipt-1')==1
assert db.execute("SELECT COUNT(*) FROM native_cash_events WHERE kind='assessment'").fetchone()[0]==4
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print('PASS native cash atomic tariff fence: same-day CAS, backdated rule, future rule, missing/wrong store, receipt/reversal, unchanged history')
`;
const result=execFileSync('python3',['-c',probe],{
  input:JSON.stringify({schema:CASH_SCHEMA,insert:CASH_EVENT_INSERT_SQL}),
  encoding:'utf8',timeout:30000
});
assert.match(result,/PASS native cash atomic tariff fence/);
console.log(result.trim());
