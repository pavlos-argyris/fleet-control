import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';
import {routePrimary} from '../cloudflare-worker/src/primary-authority.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-primary-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'primary-fixture'},durableObjects:{FLEET_EVENTS:{className:'FleetEvents',useSQLite:true}},bindings:{SERVER_KEY:'primary-fixture-server-key-at-least-32',PIN_PEPPER:'primary-fixture-pepper'}}));
 const db=await runtime.getD1Database('DB'),hub=await runtime.getDurableObjectNamespace('FLEET_EVENTS'),serverKey='primary-fixture-server-key-at-least-32';
 const raw=(url,body,extra={})=>runtime.dispatchFetch('https://fixture'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Fleet-Server-Key':serverKey,...extra},body:body?JSON.stringify(body):undefined});
 const call=async(...args)=>{const r=await raw(...args);return{status:r.status,data:await r.json()};};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 ok(await call('/api/status'));ok(await call('/api/auth/bootstrap',{username:'primary.owner',password:'Primary-Fixture-2026!',fullName:'Συνθετικός ιδιοκτήτης'}));
 // A business table omitted by an old static inventory must not remain writable
 // or disappear from the final frozen export. Use multi-byte large-cell data.
 const largePayload='Κ'.repeat(90000);
 await db.prepare('CREATE TABLE unlisted_business_data(id TEXT PRIMARY KEY,payload TEXT NOT NULL)').run();
 await db.prepare('INSERT INTO unlisted_business_data(id,payload) VALUES(?,?)').bind('fixture',largePayload).run();
 // Frozen exports must preserve exact 64-bit cents/IDs and the BLOB storage
 // class. JavaScript Number coercion or a NULL/deferred mix-up is data loss.
 await db.prepare('CREATE TABLE typed_business_fixture(id INTEGER PRIMARY KEY,big_positive INTEGER NOT NULL,big_negative INTEGER NOT NULL,small_blob BLOB NOT NULL,empty_blob BLOB NOT NULL,null_blob BLOB,safe_integer INTEGER NOT NULL)').run();
 await db.prepare("INSERT INTO typed_business_fixture VALUES(1,9223372036854775807,-9007199254740992,x'00FF8001',x'',NULL,9007199254740991)").run();
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicKey=Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64url');
 const input=()=>({generation:crypto.randomUUID(),ticket:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),publicKey,publicSalt:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),recoveryHash:'a'.repeat(64),username:'primary.owner',password:'Primary-Fixture-2026!'});
 let migration=input();
 assert.equal((await call('/api/primary/prepare',{...migration,password:'wrong'})).status,401);
 assert.equal(ok(await call('/api/primary/descriptor')).mode,'cloud');
 // Real D1 race: privilege changes after password verification, immediately
 // before the atomic writer fence. It must not commit using stale authority.
 const originalHash=(await db.prepare("SELECT password_hash FROM app_users WHERE username='primary.owner'").first()).password_hash;
 let inject=true;const env={SERVER_KEY:serverKey,FLEET_EVENTS:hub,DB:{prepare:db.prepare.bind(db),batch:async queries=>{if(inject){inject=false;await db.prepare("UPDATE app_users SET password_hash=? WHERE username='primary.owner'").bind('c'.repeat(64)).run();}return db.batch(queries);}}};
 const raced=await routePrimary(new Request('https://fixture/api/primary/prepare',{method:'POST',headers:{'X-Fleet-Server-Key':serverKey},body:JSON.stringify(migration)}),env);
 assert.equal(raced.status,409);assert.equal((await db.prepare('SELECT mode FROM fleet_primary_fence WHERE id=1').first()).mode,'cloud');
 await db.prepare("UPDATE app_users SET password_hash=? WHERE username='primary.owner'").bind(originalHash).run();
 // Simulate a CREATE TABLE by a concurrent old request after the table scan.
 let schemaRace=true;
 const racedSchemaEnv={SERVER_KEY:serverKey,FLEET_EVENTS:hub,DB:{prepare:db.prepare.bind(db),batch:async queries=>{if(schemaRace){schemaRace=false;await db.prepare('CREATE TABLE raced_business_data(id TEXT PRIMARY KEY)').run();}return db.batch(queries);}}};
 const schemaRaced=await routePrimary(new Request('https://fixture/api/primary/prepare',{method:'POST',headers:{'X-Fleet-Server-Key':serverKey},body:JSON.stringify(migration)}),racedSchemaEnv);
 assert.equal(schemaRaced.status,409,'new table during fence is a migration conflict');
 assert.equal((await db.prepare('SELECT mode FROM fleet_primary_fence WHERE id=1').first()).mode,'cloud');
 await db.prepare('DROP TABLE raced_business_data').run();
 const prepared=ok(await call('/api/primary/prepare',migration));assert.equal(prepared.fenced,true);assert.equal(prepared.mode,'preparing');
 const ticket={'X-Fleet-Primary-Ticket':migration.ticket};
 await assert.rejects(db.prepare("UPDATE app_users SET full_name='late stale cloud writer' WHERE username='primary.owner'").run(),/fleet_primary_writer_fenced/);
 await assert.rejects(db.prepare("INSERT INTO fleet_operations VALUES('late','fixture','late','{}','pending','now',NULL)").run(),/fleet_primary_writer_fenced/);
 await assert.rejects(db.prepare("UPDATE unlisted_business_data SET payload='stale' WHERE id='fixture'").run(),/fleet_primary_writer_fenced/);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'primary_fence_fleet_releases_%'").first()).n,0,'cloud release metadata remains outside business writer fence');
 assert.equal((await call('/api/auth/user-login',{username:'primary.owner',password:'Primary-Fixture-2026!'})).status,503);
 const inventory=ok(await call('/api/primary/inventory',null,ticket));assert.equal(inventory.schemaVersion,3);assert(inventory.tables.length>30);assert(!inventory.tables.some(t=>t.name==='auth_sessions'),'old cloud sessions are never imported');
 assert(inventory.tables.some(t=>t.name==='unlisted_business_data'&&t.rows===1),'unknown business rows are exported rather than silently lost');
 assert(!inventory.tables.some(t=>t.name==='fleet_releases'),'cloud OTA metadata stays in distribution');
 const users=ok(await call('/api/primary/rows?table=app_users',null,ticket)).rows;assert.equal(users.length,1);assert.equal(users[0].full_name,'Συνθετικός ιδιοκτήτης');
 assert.equal((await call('/api/primary/rows?table=app_users%3BDROP%20TABLE%20app_users',null,ticket)).status,400);
 const frozen=ok(await call('/api/primary/rows?table=unlisted_business_data',null,ticket));
 assert.equal(frozen.schemaVersion,3);assert.equal(frozen.rows.length,1);assert.equal(frozen.rows[0].payload,null);
 const deferred=JSON.parse(frozen.rows[0]._primaryOversize).find(c=>c?.name==='payload');
 assert.equal(deferred.bytes,Buffer.byteLength(largePayload));assert.equal(deferred.type,'text');
 const parts=[];for(let offset=0;offset<deferred.bytes;offset+=32768){
   const part=ok(await call('/api/primary/cell?table=unlisted_business_data&column=payload&rowid='+frozen.rows[0]._primaryRowid+'&offset='+offset+'&size=32768',null,ticket));
   assert.equal(part.offset,offset);assert.equal(part.bytes,deferred.bytes);parts.push(Buffer.from(part.hex,'hex'));
 }
 assert.equal(Buffer.concat(parts).toString('utf8'),largePayload,'byte slices round-trip large Unicode exactly');
 const typed=ok(await call('/api/primary/rows?table=typed_business_fixture',null,ticket));
 assert.equal(typed.schemaVersion,3);assert.equal(typed.rows.length,1);
 const typedRow=typed.rows[0],typedMeta=JSON.parse(typedRow._primaryOversize).filter(Boolean);
 const meta=name=>typedMeta.find(c=>c.name===name);
 assert.equal(typedRow.big_positive,null);assert.equal(meta('big_positive').type,'integer');
 assert.equal(meta('big_positive').decimal,'9223372036854775807','max SQLite signed integer must not round in D1 JSON');
 assert.equal(typedRow.big_negative,null);assert.equal(meta('big_negative').decimal,'-9007199254740992');
 assert.equal(typedRow.safe_integer,9007199254740991,'safe integers stay inline');
 assert.equal(typedRow.small_blob,null);assert.equal(meta('small_blob').type,'blob');assert.equal(meta('small_blob').bytes,4);
 assert.equal(typedRow.empty_blob,null);assert.equal(meta('empty_blob').type,'blob');assert.equal(meta('empty_blob').bytes,0);
 assert.equal(typedRow.null_blob,null);assert.equal(meta('null_blob'),undefined,'SQL NULL is not an empty BLOB');
 const binary=ok(await call('/api/primary/cell?table=typed_business_fixture&column=small_blob&rowid=1&offset=0&size=4',null,ticket));
 assert.equal(binary.schemaVersion,3);assert.equal(binary.kind,'blob');assert.equal(binary.hex,'00FF8001');
 assert.equal((await call('/api/primary/cell?table=typed_business_fixture&column=empty_blob&rowid=1&offset=0',null,ticket)).status,416,'zero-byte BLOB needs no slices');
 assert.equal((await call('/api/primary/cell?table=unlisted_business_data&column=payload%3BDROP&rowid=1&offset=0',null,ticket)).status,400);
 assert.equal((await call('/api/primary/cell?table=unlisted_business_data&column=payload&rowid=1&offset='+deferred.bytes,null,ticket)).status,416);
 assert.equal((await call('/api/primary/rows?table=unlisted_business_data&limit=26',null,ticket)).status,400);
 const control=hub.get(hub.idFromName('fleet')),reserve=await control.fetch('https://internal/primary/start-abort',{method:'POST',body:JSON.stringify({ticketHash:prepared.ticketHash})});assert.equal(reserve.status,200);
 assert.equal((await call('/api/primary/activate',{contentHash:'b'.repeat(64),restoreVerified:true,documentsVerified:true},ticket)).status,409,'abort reservation excludes activation');
 ok(await call('/api/primary/abort',{},ticket));assert.equal(ok(await call('/api/primary/descriptor')).mode,'cloud');
 await db.prepare("UPDATE unlisted_business_data SET payload=payload WHERE id='fixture'").run();
 await db.prepare("UPDATE app_users SET full_name='Συνθετικός ιδιοκτήτης' WHERE username='primary.owner'").run();
 migration=input();ok(await call('/api/primary/prepare',migration));const activeTicket={'X-Fleet-Primary-Ticket':migration.ticket};
 assert.equal((await call('/api/primary/activate',{contentHash:'b'.repeat(64),restoreVerified:false,documentsVerified:true},activeTicket)).status,409);
 const activation={contentHash:'b'.repeat(64),restoreVerified:true,documentsVerified:true};ok(await call('/api/primary/activate',activation,activeTicket));ok(await call('/api/primary/activate',activation,activeTicket));
 const descriptor=ok(await call('/api/primary/descriptor'));assert.equal(descriptor.mode,'active');assert.equal(descriptor.publicKey,publicKey);assert.equal(descriptor.eventKey,undefined);assert.equal(descriptor.ticketHash,undefined);assert.equal(descriptor.recoveryHash,undefined);
 assert.equal((await call('/api/primary/abort',{},activeTicket)).status,409);assert.equal((await call('/api/primary/rows?table=app_users',null,activeTicket)).status,409);
 let reads=0;const unavailable={FLEET_EVENTS:hub,SERVER_KEY:serverKey,get DB(){reads++;throw Error('D1 quota fully unavailable');},ASSETS:{fetch:()=>new Response('native primary static entry')}};
 assert.equal((await worker.fetch(new Request('https://fixture/api/primary/descriptor'),unavailable)).status,200);
 assert.equal(await (await worker.fetch(new Request('https://fixture/'),unavailable)).text(),'native primary static entry');
 const packet={v:1,nonce:'1'.repeat(32),epk:'e'.repeat(122),iv:'i'.repeat(16),ciphertext:'c'.repeat(100)};
 assert.equal((await worker.fetch(new Request('https://fixture/api/primary/request',{method:'POST',body:JSON.stringify(packet)}),unavailable)).status,503,'offline primary is honest without D1 fallback');
 const challenge=ok(await call('/api/primary/challenge',{generation:migration.generation}));
 const signature=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(challenge.message))).toString('base64url');
 const proof={nonce:challenge.nonce,generation:migration.generation,signature};
 const connected=await runtime.dispatchFetch('https://fixture/api/primary/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':serverKey,'X-Fleet-Primary-Proof':JSON.stringify(proof)}});assert.equal(connected.status,101);const ws=connected.webSocket;ws.accept();let messages=0;
 ws.addEventListener('message',event=>{if(event.data==='pong')return;const value=JSON.parse(event.data);if(value.type!=='request')return;messages++;assert.deepEqual(value.request,packet);assert.equal(value.request.body,undefined);ws.send(JSON.stringify({id:value.id,response:{...packet,ciphertext:'r'.repeat(100)}}));});
 const delivered=await worker.fetch(new Request('https://fixture/api/primary/request',{method:'POST',body:JSON.stringify(packet)}),unavailable);assert.equal(delivered.status,200);assert.equal((await delivered.json()).ciphertext,'r'.repeat(100));assert.equal(messages,1);assert.equal(reads,0,'active transport and static load do not touch D1');
 const reused=await runtime.dispatchFetch('https://fixture/api/primary/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':serverKey,'X-Fleet-Primary-Proof':JSON.stringify(proof)}});assert.equal(reused.status,401,'challenge is single use');
 const oldDirect=await call('/api/direct/request',packet,{'X-Fleet-Direct-Key':'a'.repeat(64)});assert.equal(oldDirect.status,409,'stale legacy authorization is disabled after handover');
 const lease=new Promise(resolve=>ws.addEventListener('message',event=>{if(event.data==='pong')return;const value=JSON.parse(event.data);if(value.type==='lease')resolve(value);}));ws.send(JSON.stringify({type:'lease',nonce:'fixture-renewal'}));assert.equal((await lease).generation,migration.generation);ws.close(1000,'test complete');
 await assert.rejects(db.prepare("UPDATE fleet_snapshot SET version=999 WHERE id=1").run(),/fleet_primary_writer_fenced/);
 console.log('PASS actual Workerd/D1/Durable Object: owner and new-table race rejection, all-business-table atomic fence, bounded paged export and exact large Unicode cell slices, session exclusion, abort/activation exclusion, lost-ACK replay, sealed P-256 registration, legacy revocation, opaque encrypted relay, lease renewal, offline/no-D1 static and request paths.');
}finally{await runtime?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
