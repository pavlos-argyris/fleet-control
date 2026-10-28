import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {WORKFORCE_SCHEMA,d1ExecScript} from '../cloudflare-worker/src/workforce.js';import {MIRROR_SCHEMA} from '../cloudflare-worker/src/mirror-delta.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-personnel-d1-'));let runtime;
try{
 const module=path.resolve('cloudflare-worker/src/workforce.js'),mirror=path.resolve('cloudflare-worker/src/mirror-delta.js');
 await build({stdin:{contents:`import {ensureWorkforceSchema} from ${JSON.stringify(module)};import {MIRROR_SCHEMA} from ${JSON.stringify(mirror)};export default {async fetch(request,env){try{await ensureWorkforceSchema(env);await env.DB.exec(MIRROR_SCHEMA);return Response.json({installed:true});}catch(error){return Response.json({error:error.message},{status:500});}}};`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'neutral',outfile:path.join(temp,'worker.mjs')});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'personnel-migration-fixture'}}));
 const db=await runtime.getD1Database('DB');
 const old=WORKFORCE_SCHEMA.replace("('fleet_history','shift','schedule_assignment','employee')","('fleet_history','shift','schedule_assignment')").replace('  login_enabled INTEGER NOT NULL DEFAULT 1,\n','').replace('  deleted_at TEXT,\n','').replace('  hours_source TEXT,\n','');
 await db.exec(d1ExecScript(old));await db.exec('CREATE TABLE invoice_import_drafts(id TEXT)');await db.exec(MIRROR_SCHEMA);
 await db.prepare("INSERT INTO deleted_records(rowid,id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name) VALUES (91,'archive','fleet_history','history','Keep this row','{\"notes\":\"αρχικό\"}','old','owner','Owner')").run();
 const before=await db.prepare('SELECT rowid,* FROM deleted_records').all();
 const response=await runtime.dispatchFetch('http://fixture/install');assert.equal(response.status,200,await response.text());
 assert.deepEqual((await db.prepare('SELECT rowid,* FROM deleted_records').all()).results,before.results);
 await db.prepare("INSERT INTO deleted_records(id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name) VALUES ('staff','employee','employee-id','Staff','{}','now','owner','Owner')").run();
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,93);
 const columns=await db.prepare('PRAGMA table_info(app_users)').all();assert.ok(columns.results.some(c=>c.name==='login_enabled'));assert.ok(columns.results.some(c=>c.name==='deleted_at'));
 assert.ok((await db.prepare('PRAGMA table_info(payroll_periods)').all()).results.some(c=>c.name==='hours_source'));
 assert.equal((await runtime.dispatchFetch('http://fixture/install')).status,200);
 console.log('PASS actual Workers/D1 migration: transactional table copy/swap, preserved archive rowid/content, new personnel archive type, additive account/payroll columns, all 93 mirror triggers and repeatable installation.');
}finally{if(runtime)await runtime.dispose();fs.rmSync(temp,{recursive:true,force:true});}
