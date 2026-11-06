import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {CASH_SCHEMA} from '../server-runtime/cash.js';

// Real isolated SQLite exercises the same single-statement-per-line SQL used
// by Android BusinessSqlite, including the native expected-revision INSERT.
const probe=String.raw`
import sqlite3,sys
db=sqlite3.connect(':memory:')
for statement in sys.stdin.read().splitlines():
 statement=statement.strip()
 if statement:db.execute(statement)
sql=('INSERT INTO native_cash_rules(id,store_id,category,effective_day,revision,rate_cents,created_at,created_by) '
 'SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM native_cash_rules '
 'WHERE store_id=? AND category=? AND effective_day=?),0)=?')
def save(id,store,category,day,revision,rate,expected):
 db.execute(sql,(id,store,category,day,revision,rate,'2026-11-04T12:00:00Z','admin',store,category,day,expected))
 return db.execute('SELECT changes()').fetchone()[0]
assert save('rule-1','store-250','A','2026-11-04',1,250,0)==1
assert save('stale','store-250','A','2026-11-04',1,300,0)==0
assert save('rule-2','store-250','A','2026-11-04',2,300,1)==1
assert save('stale-again','store-250','A','2026-11-04',2,250,1)==0
assert save('different-store','store-300','A','2026-11-04',1,300,0)==1
assert save('historical','store-250','A','2026-10-04',1,250,0)==1
assert save('different-category','store-250','B','2026-11-04',1,300,0)==1
rows=db.execute('SELECT id,rate_cents FROM native_cash_rules WHERE store_id=? AND category=? AND effective_day=? ORDER BY revision',('store-250','A','2026-11-04')).fetchall()
assert rows==[('rule-1',250),('rule-2',300)],rows
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print('PASS SQLite cash tariff CAS: stale writes rejected, history and independent keys preserved')
`;
const output=execFileSync('python3',['-c',probe],{input:CASH_SCHEMA,encoding:'utf8',timeout:30000});
assert.match(output,/PASS SQLite cash tariff CAS/);
console.log(output.trim());
