import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {CASH_SCHEMA} from '../server-runtime/cash.js';

// Exercise the real SQLite trigger, not a JavaScript imitation of its rules.
// Only an in-memory synthetic database is used; no production access.
const probe=String.raw`
import sqlite3,sys
db=sqlite3.connect(':memory:')
# Match the Android BusinessSqlite sql.exec capability: one statement per line.
# executescript() would incorrectly accept multiline triggers that fail on-device.
for statement in sys.stdin.read().splitlines():
 statement=statement.strip()
 if statement:db.execute(statement)
columns=['id','kind','business_day','courier_id','courier_name','store_id','category','quantity','rate_cents','amount_cents','rule_id','reverses_id','source_key','notes','actor_id','actor_name','created_at']
insert_sql='INSERT INTO native_cash_events('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')'
def put(row):
 db.execute(insert_sql,[row[c] for c in columns])
def count():
 return db.execute('SELECT COUNT(*) FROM native_cash_events').fetchone()[0]
def rejected(row,label):
 before=count()
 try:put(row)
 except sqlite3.IntegrityError:
  assert count()==before,label+' changed the ledger'
  return
 raise AssertionError(label+' unexpectedly accepted')
base=dict(id='assessment-1',kind='assessment',business_day='2026-11-04',courier_id='courier-1',courier_name='Courier One',store_id='store-250',category='A',quantity=2,rate_cents=250,amount_cents=500,rule_id='rule-1',reverses_id=None,source_key='manual:assessment-1',notes='initial',actor_id='admin-1',actor_name='Admin',created_at='2026-11-04T12:00:00Z')
put(base)
receipt=dict(base,id='receipt-1',kind='receipt',store_id='',category='',quantity=0,rate_cents=0,amount_cents=300,rule_id=None,source_key=None)
put(receipt)
def reverse(original,identifier):
 return dict(original,id=identifier,kind='reversal',reverses_id=original['id'],source_key=None,notes='correction',created_at='2026-11-04T13:00:00Z')
assessment_reversal=reverse(base,'reverse-assessment')
put(assessment_reversal)
put(reverse(receipt,'reverse-receipt'))
assert count()==4
rejected(reverse(base,'duplicate-reversal'),'duplicate reversal')
rejected(dict(reverse(base,'unknown-source'),reverses_id='missing'),'missing original')
rejected(dict(reverse(base,'null-source'),reverses_id=None),'null original')
rejected(dict(reverse(assessment_reversal,'reverse-of-reversal')),'reversal of reversal')
rejected(dict(base,id='linked-assessment',reverses_id=base['id'],source_key=None),'assessment with reversal link')
rejected(dict(receipt,id='linked-receipt',reverses_id=base['id']),'receipt with reversal link')
for field,value in [
 ('business_day','2026-11-05'),('courier_id','courier-2'),
 ('courier_name','Another Courier'),('store_id','store-300'),
 ('category','B'),('quantity',3),('rate_cents',300),
 ('amount_cents',501),('rule_id',None)
]:
 row=reverse(base,'mismatch-'+field)
 row[field]=value
 # Use a new original so the unique reversal link cannot mask mismatch.
 original=dict(base,id='original-'+field,source_key='manual:'+field)
 put(original)
 row['reverses_id']=original['id']
 rejected(row,'mismatched '+field)
assert db.execute("SELECT amount_cents FROM native_cash_events WHERE id='assessment-1'").fetchone()[0]==500
assert db.execute("PRAGMA integrity_check").fetchone()[0]=='ok'
print('PASS SQLite cash reversal: exact amount/identity, missing original, duplicate, invalid links, unchanged history')
`;
const output=execFileSync('python3',['-c',probe],{input:CASH_SCHEMA,encoding:'utf8',timeout:30000});
assert.match(output,/PASS SQLite cash reversal/);
console.log(output.trim());
