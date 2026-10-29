import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ordexa-migration-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
 const options=convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'migration-fixture'},resourcePersistencePath:path.join(dir,'d1'),bindings:{SERVER_KEY:'synthetic-migration',PIN_PEPPER:'synthetic-pepper'}});
 const start=async()=>{runtime=new Miniflare(options);const response=await runtime.dispatchFetch('https://fixture/api/status');assert.equal(response.status,200,await response.text());return runtime.getD1Database('DB');};
 let db=await start();
 const count=async()=>Number((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n);
 const downgrade=async(version)=>{
  const source=await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ordexa_source_%'").all();for(const trigger of source.results)await db.exec('DROP TRIGGER "'+trigger.name+'"');
  await db.exec("DELETE FROM fleet_settings WHERE key IN ('runtime_schema_version','ordexa_server_schema_v3'); DROP TABLE store_billing_records; DROP TABLE ordexa_shift_adjustments; DROP TABLE ordexa_server_views;");
  if(version<32)await db.exec("DELETE FROM fleet_settings WHERE key='ordexa_payroll_schema_v2'; DROP TABLE ordexa_pay_decisions; DROP TRIGGER ordexa_pay_schedule_insert; DROP TRIGGER ordexa_pay_schedule_update; DROP TRIGGER ordexa_pay_schedule_delete;");
  if(version<31)await db.exec("DELETE FROM fleet_settings WHERE key='ordexa_mirror_schema_v1'; DROP TABLE ordexa_sessions; DROP TABLE ordexa_imports; DROP TABLE ordexa_riders;");
  await db.prepare("UPDATE fleet_mirror_state SET epoch=?").bind('prior-'+version).run();assert.equal(await count(),version*3);
 };
 await db.exec("INSERT INTO system_settings(key,value,updated_at) VALUES('retained-migration-fixture','keep-me','now')");
 for(const version of [28,31,32]){
  if(version>=31)await db.exec("INSERT OR REPLACE INTO ordexa_riders(id,city_id,rider_id,name,updated_at) VALUES('retained-rider','7','17','Synthetic retained','fixture')");
  await downgrade(version);await runtime.dispose();runtime=null;db=await start();
  const epoch=(await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch;assert.notEqual(epoch,'prior-'+version);assert.equal(await count(),102);
  assert.equal((await db.prepare("SELECT value FROM system_settings WHERE key='retained-migration-fixture'").first()).value,'keep-me');
  if(version>=31)assert.equal((await db.prepare("SELECT name FROM ordexa_riders WHERE id='retained-rider'").first()).name,'Synthetic retained');
  const response=await runtime.dispatchFetch('https://fixture/api/server/system-export/delta?epoch=prior-'+version+'&cursor=0',{headers:{'X-Fleet-Server-Key':'synthetic-migration'}});assert.equal((await response.json()).resetRequired,true);
  await runtime.dispose();runtime=null;db=await start();assert.equal((await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch,epoch,'Ordinary cold restart must not reset the mirror again');assert.equal(await count(),102);
 }
 console.log('PASS persistent D1 migration: old 28/84, v1 31/93 and v2 32/96 upgrade to 34/102, retain source rows, invalidate cursor once and survive cold restart. Derived Server views stay disposable. Synthetic only.');
}finally{if(runtime)await runtime.dispose();fs.rmSync(dir,{recursive:true,force:true});}
