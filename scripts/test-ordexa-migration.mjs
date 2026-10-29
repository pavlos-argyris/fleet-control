import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ordexa-migration-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
 const options=convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'migration-fixture'},resourcePersistencePath:path.join(dir,'d1'),bindings:{SERVER_KEY:'synthetic-migration',PIN_PEPPER:'synthetic-pepper'}});
 const start=async()=>{runtime=new Miniflare(options);const response=await runtime.dispatchFetch('https://fixture/api/status');assert.equal(response.status,200,await response.text());return runtime.getD1Database('DB');};
 let db=await start();
 // Recreate the prior release's 28-table mirror in a persistent synthetic DB.
 await db.exec("UPDATE fleet_mirror_state SET epoch='pre-ordexa'; DELETE FROM fleet_settings WHERE key IN ('runtime_schema_version','ordexa_mirror_schema_v1','ordexa_payroll_schema_v2'); DROP TRIGGER ordexa_pay_schedule_insert; DROP TRIGGER ordexa_pay_schedule_update; DROP TRIGGER ordexa_pay_schedule_delete; DROP TABLE ordexa_pay_decisions; DROP TABLE ordexa_sessions; DROP TABLE ordexa_imports; DROP TABLE ordexa_riders; INSERT INTO system_settings(key,value,updated_at) VALUES('retained-migration-fixture','keep-me','now');");
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,84);
 await runtime.dispose();runtime=null;db=await start();
 const epoch=(await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch;assert.notEqual(epoch,'pre-ordexa');
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,96);
 assert.equal((await db.prepare("SELECT value FROM system_settings WHERE key='retained-migration-fixture'").first()).value,'keep-me');
 const response=await runtime.dispatchFetch('https://fixture/api/server/system-export/delta?epoch=pre-ordexa&cursor=0',{headers:{'X-Fleet-Server-Key':'synthetic-migration'}});assert.equal((await response.json()).resetRequired,true);
 await runtime.dispose();runtime=null;db=await start();assert.equal((await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch,epoch,'A normal cold restart must not reset the mirror a second time');
 // Upgrade an actual v1 31-table mirror with retained Ordexa data as well.
 await db.exec("UPDATE fleet_mirror_state SET epoch='v1-31'; UPDATE fleet_settings SET value='ordexa-attendance-v1' WHERE key='runtime_schema_version'; DELETE FROM fleet_settings WHERE key='ordexa_payroll_schema_v2'; DROP TABLE ordexa_pay_decisions; DROP TRIGGER ordexa_pay_schedule_insert; DROP TRIGGER ordexa_pay_schedule_update; DROP TRIGGER ordexa_pay_schedule_delete; INSERT INTO ordexa_riders(id,city_id,rider_id,name,updated_at) VALUES('retained-rider','7','17','Synthetic retained','fixture');");
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,93);
 await runtime.dispose();runtime=null;db=await start();const v2epoch=(await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch;assert.notEqual(v2epoch,'v1-31');assert.equal((await db.prepare("SELECT name FROM ordexa_riders WHERE id='retained-rider'").first()).name,'Synthetic retained');assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,96);
 await runtime.dispose();runtime=null;db=await start();assert.equal((await db.prepare('SELECT epoch FROM fleet_mirror_state').first()).epoch,v2epoch);
 console.log('PASS real persistent D1 migration: old 28/84 and Ordexa v1 31/93 mirrors upgrade to 32/96, preserves existing rows, invalidates old cursor exactly once and survives cold restart. Synthetic only.');
}finally{if(runtime)await runtime.dispose();fs.rmSync(dir,{recursive:true,force:true});}
