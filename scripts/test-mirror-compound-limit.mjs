import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {mirrorDelta} from '../cloudflare-worker/src/mirror-delta.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-compound-limit-')),file=path.join(temp,'fixture.sqlite');
const epoch='0123456789abcdef0123456789abcdef';
function sql(query,params=[],mode){return JSON.parse(execFileSync('python3',['scripts/fixtures/mirror-sqlite-limit.py',file,JSON.stringify({sql:query,params,mode})],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));}
try{
 sql([
 'CREATE TABLE fleet_mirror_state(id INTEGER PRIMARY KEY,epoch TEXT,floor INTEGER)',
 "INSERT INTO fleet_mirror_state VALUES(1,'"+epoch+"',0)",
 'CREATE TABLE fleet_mirror_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT,row_id INTEGER,UNIQUE(table_name,row_id))',
 'CREATE TABLE app_users(id TEXT,full_name TEXT,notes TEXT,active INTEGER DEFAULT 1)',
 'CREATE TABLE system_settings(key TEXT,value TEXT,updated_at TEXT)'
 ].join(';'),[],'script');
 let rejected=false;try{sql(Array.from({length:20},()=> 'SELECT 1 AS row_id,1 AS seq').join(' UNION ALL '));}catch(e){rejected=/too many terms in compound SELECT/.test(String(e.stderr));}assert.equal(rejected,true,'Fixture reproduces the production compound-SELECT failure');
 for(let i=1;i<=45;i++){sql('INSERT INTO app_users(rowid,id,full_name,notes) VALUES(?,?,?,?)',[i,'u-'+i,'Δοκιμή "'+i+'"','Σημείωση \\\\ '+i]);sql('INSERT INTO fleet_mirror_changes(table_name,row_id) VALUES(?,?)',['app_users',i]);}
 sql('DELETE FROM app_users WHERE rowid=3');
 let interleaved=false,reads=0;
 const env={DB:{prepare(query){return {params:[],bind(...params){this.params=params;return this;},async first(){reads++;return sql(query,this.params)[0]||null;},async all(){reads++;const rows=sql(query,this.params);if(!interleaved&&query.startsWith('SELECT seq,table_name,row_id')){interleaved=true;sql('UPDATE app_users SET full_name=? WHERE rowid=1',['Νεότερο όνομα']);sql("DELETE FROM fleet_mirror_changes WHERE table_name='app_users' AND row_id=1");sql('INSERT INTO fleet_mirror_changes(table_name,row_id) VALUES(?,?)',['app_users',1]);}return {results:rows};}};}}};
 const request=(cursor,until)=>new Request('https://fixture/api/server/system-export/delta?epoch='+epoch+'&cursor='+cursor+(until===undefined?'':'&until='+until));
 const get=async(cursor,until)=>{const response=await mirrorDelta(request(cursor,until),env,async()=>true);assert.equal(response.status,200);return response.json();};
 let data=await get(0);assert.equal(data.changes.length,20);assert.equal(data.until,45);assert.equal(data.hasMore,true);
 assert.ok(data.changes.some(c=>c.rowId===1&&c.seq===1&&c.row.full_name==='Νεότερο όνομα'),'Captured ids survive later journal coalescing');
 assert.ok(data.changes.some(c=>c.rowId===3&&c.row===null),'Deleted canonical rows remain explicit deletion markers');
 assert.equal(data.changes.find(c=>c.rowId===2).row.full_name,'Δοκιμή "2"');assert.equal(typeof data.changes.find(c=>c.rowId===2).row,'object');
 for(let i=1;i<=4;i++){sql('INSERT INTO system_settings(rowid,key,value,updated_at) VALUES(?,?,?,?)',[i,'key-'+i,'value-'+i,'now']);sql('INSERT INTO fleet_mirror_changes(table_name,row_id) VALUES(?,?)',['system_settings',i]);}
 const changes=[...data.changes];while(data.hasMore){data=await get(data.nextCursor,45);assert.equal(data.until,45);changes.push(...data.changes);}
 assert.equal(data.nextCursor,45);assert.equal(changes.length,45);assert.equal(new Set(changes.map(c=>c.table+':'+c.rowId)).size,45,'No captured record skipped or duplicated');
 const future=await get(45);assert.equal(future.changes.length,5);assert.equal(future.hasMore,false);assert.ok(future.changes.some(c=>c.table==='app_users'&&c.rowId===1&&c.seq>45));assert.equal(future.changes.filter(c=>c.table==='system_settings').length,4);
 const unchanged=await get(future.nextCursor);assert.equal(unchanged.changes.length,0);assert.equal(unchanged.nextCursor,future.nextCursor);
 const before=reads,response=await mirrorDelta(request(0),env,async()=>false);assert.equal(response.status,401);assert.equal(reads,before,'Unauthorized requests never read the database');
 console.log('PASS actual mirror delta under a one-term compound-SELECT limit: 20-row pages, 45 complete records, Unicode JSON, deletes, coalescing races, fixed watermark, mixed tables, unchanged cursor and authorization.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
