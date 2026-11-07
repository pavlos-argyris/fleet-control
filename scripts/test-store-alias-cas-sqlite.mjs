import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {REPORT_SCHEMA} from '../server-runtime/reports.js';

// Extract the actual native route's SQL instead of testing a rewritten query.
// No production database, credentials, or network connections are involved.
const source=readFileSync(new URL('../server-runtime/reports.js',import.meta.url),'utf8');
const anchor="const saved=await env.DB.prepare('";
const start=source.indexOf(anchor,source.indexOf('export async function routeReports'));
assert.ok(start>=0,'Native alias CAS SQL must exist in routeReports');
const end=source.indexOf("').bind(scope,source,target,expected+1,stamp(),user.user_id,expected,scope,source,expected).run()",start);
assert.ok(end>start,'Native alias CAS must bind expected revision to INSERT and conflict UPDATE');
const sql=source.slice(start+anchor.length,end);
assert.match(sql,/ON CONFLICT\(scope,source_id\)/);
assert.match(sql,/WHERE native_store_aliases\.revision=\?/);

const probe=String.raw`
import json,sqlite3,sys
payload=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
for statement in payload['schema'].splitlines():
    if statement.strip(): db.execute(statement)
sql=payload['sql']
def save(scope,source,target,expected):
    cur=db.execute(sql,(scope,source,target,expected+1,'2026-11-06T12:00:00Z','admin',expected,scope,source,expected))
    return cur.rowcount
assert save('scope-a','pizza-hot-a','pizza-hot',0)==1
assert save('scope-a','pizza-hot-a','wrong-stale',0)==0
assert save('scope-a','pizza-hot-a','pizza-hot-canonical',1)==1
assert save('scope-a','pizza-hot-a','lost-update',1)==0
assert save('scope-a','pizza-hot-b','pizza-hot-canonical',0)==1
assert save('scope-b','pizza-hot-a','other-scope',0)==1
rows=db.execute('SELECT scope,source_id,target_id,revision FROM native_store_aliases ORDER BY scope,source_id').fetchall()
assert rows==[
 ('scope-a','pizza-hot-a','pizza-hot-canonical',2),
 ('scope-a','pizza-hot-b','pizza-hot-canonical',1),
 ('scope-b','pizza-hot-a','other-scope',1)
],rows
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print('PASS native alias CAS: first insert, stale inserts/updates, independent scope and source')
`;
const output=execFileSync('python3',['-c',probe],{input:JSON.stringify({schema:REPORT_SCHEMA,sql}),encoding:'utf8',timeout:30000});
assert.match(output,/PASS native alias CAS/);
console.log(output.trim());
