import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));const {Miniflare,convertV4MiniflareOptions}=require('miniflare');const {build}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-d1-offload-'));let mf;
try{
await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(temp,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'offload-fixture'},r2Buckets:['RELEASES','SERVICE_DOCS'],bindings:{SERVER_KEY:'d1-fixture-key',PIN_PEPPER:'d1-test-pepper'}}));
const headers={'X-Fleet-Server-Key':'d1-fixture-key','Content-Type':'application/json'};
let res=await mf.dispatchFetch('https://fixture.invalid/api/status',{headers});assert.equal(res.status,200,await res.text());
const db=await mf.getD1Database('DB');assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'fleet_mirror_%'").first()).n,99);
await db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES('delta-fixture','one','now') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
let head=await db.prepare('SELECT epoch,(SELECT seq FROM sqlite_sequence WHERE name=\'fleet_mirror_changes\') cursor FROM fleet_mirror_state WHERE id=1').first();
await db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES('delta-fixture','two','later') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
res=await mf.dispatchFetch('https://fixture.invalid/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+head.cursor,{headers});assert.equal(res.status,200);let data=await res.json();assert.ok(data.changes.some(c=>c.row?.key==='delta-fixture'&&c.row.value==='two'));
const cursor=data.nextCursor;await db.prepare("DELETE FROM system_settings WHERE key='delta-fixture'").run();res=await mf.dispatchFetch('https://fixture.invalid/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor,{headers});data=await res.json();assert.ok(data.changes.some(c=>c.table==='system_settings'&&c.row===null));
res=await mf.dispatchFetch('https://fixture.invalid/api/server/exchange',{method:'POST',headers,body:JSON.stringify({serverVersion:'2.2.3',sinceVersion:-1,knownJobs:[],acknowledgements:[],includeStatus:true})});assert.equal(res.status,200,await res.clone().text());data=await res.json();assert.equal(data.protocol,1);assert.ok(Array.isArray(data.snapshot.bikes));
console.log('OK real Workers/D1 runtime: schema installation, 99 triggers, outer UPSERT, coalesced delta/deletion and combined exchange.');
}finally{if(mf)await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
