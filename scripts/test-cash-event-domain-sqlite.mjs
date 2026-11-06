import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {CASH_SCHEMA} from '../server-runtime/cash.js';

// Execute the exact production CASH_SCHEMA against isolated SQLite. Android's
// BusinessSqlite executes one SQL statement per line, including trigger bodies.
const probe=String.raw`
import sqlite3,sys
db=sqlite3.connect(':memory:')
for sql in sys.stdin.read().splitlines():
 sql=sql.strip()
 if sql:db.execute(sql)
cols=['id','kind','business_day','courier_id','courier_name','store_id','category','quantity','rate_cents','amount_cents','rule_id','reverses_id','source_key','notes','actor_id','actor_name','created_at']
insert='INSERT INTO native_cash_events('+','.join(cols)+') VALUES('+','.join('?' for _ in cols)+')'
base=dict(id='a1',kind='assessment',business_day='2026-11-04',courier_id='c1',courier_name='Courier One',store_id='store-250',category='A',quantity=2,rate_cents=250,amount_cents=500,rule_id='rule-1',reverses_id=None,source_key='manual:a1',notes='fixture',actor_id='owner',actor_name='Owner',created_at='2026-11-04T12:00:00Z')
def put(row):db.execute(insert,[row[c] for c in cols])
def count():return db.execute('SELECT COUNT(*) FROM native_cash_events').fetchone()[0]
def reject(change,label):
 before=count()
 row=dict(base,id='bad-'+label,source_key=None,**change)
 try:put(row)
 except sqlite3.IntegrityError as error:
  assert 'cash_assessment_domain_mismatch' in str(error),label+': '+str(error)
  assert count()==before,label+' changed ledger'
  return
 raise AssertionError(label+' accepted')
put(base)
put(dict(base,id='a2',store_id='store-300',quantity=1,rate_cents=300,amount_cents=300,rule_id='rule-2',source_key='manual:a2'))
for label,change in [
 ('zero-quantity',{'quantity':0,'amount_cents':0}),
 ('huge-quantity',{'quantity':1000001,'amount_cents':250000250}),
 ('blank-store',{'store_id':''}),
 ('blank-category',{'category':''}),
 ('missing-rule',{'rule_id':None}),
 ('wrong-amount',{'amount_cents':501}),
 ('huge-amount',{'quantity':400001,'amount_cents':100000250}),
 ('wrong-rate',{'rate_cents':300})
]:reject(change,label)
receipt=dict(base,id='r1',kind='receipt',store_id='',category='',quantity=0,rate_cents=0,amount_cents=300,rule_id=None,source_key=None)
put(receipt)
put(dict(receipt,id='r2',amount_cents=100000000))
for label,change in [
 ('receipt-quantity',{'quantity':1}),
 ('receipt-rate',{'rate_cents':1}),
 ('receipt-store',{'store_id':'store-250'}),
 ('receipt-category',{'category':'A'}),
 ('receipt-rule',{'rule_id':'rule-1'}),
 ('receipt-zero',{'amount_cents':0}),
 ('receipt-huge',{'amount_cents':100000001})
]:
 before=count()
 row=dict(receipt,id='bad-'+label,**change)
 try:put(row)
 except sqlite3.IntegrityError as error:
  assert 'cash_receipt_domain_mismatch' in str(error),label+': '+str(error)
  assert count()==before,label+' changed ledger'
  continue
 raise AssertionError(label+' accepted')
assert count()==4
assert db.execute('SELECT SUM(amount_cents) FROM native_cash_events WHERE kind="assessment"').fetchone()[0]==800
try:db.execute("UPDATE native_cash_events SET amount_cents=1 WHERE id='a1'")
except sqlite3.IntegrityError:pass
else:raise AssertionError('immutable cash amount changed')
assert db.execute("SELECT amount_cents FROM native_cash_events WHERE id='a1'").fetchone()[0]==500
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print('PASS native SQLite cash event domains: 2.50/3.00 rates, invalid assessments/receipts, immutability and integrity')
`;
const result=execFileSync('python3',['-c',probe],{input:CASH_SCHEMA,encoding:'utf8',timeout:30000});
assert.match(result,/PASS native SQLite cash event domains/);
console.log(result.trim());
