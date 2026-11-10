import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';
import {routePrimary} from '../cloudflare-worker/src/primary-authority.js';
import {makeTicket} from '../cloudflare-worker/src/change-events.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-primary-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['browser','module','main']});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'primary-fixture'},r2Buckets:{SERVICE_DOCS:'primary-docs-fixture'},durableObjects:{FLEET_EVENTS:{className:'FleetEvents',useSQLite:true}},bindings:{SERVER_KEY:'primary-fixture-server-key-at-least-32',PIN_PEPPER:'primary-fixture-pepper'}}));
 const db=await runtime.getD1Database('DB'),hub=await runtime.getDurableObjectNamespace('FLEET_EVENTS'),serverKey='primary-fixture-server-key-at-least-32';
 const raw=(url,body,extra={})=>runtime.dispatchFetch('https://fixture'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Fleet-Server-Key':serverKey,...extra},body:body?JSON.stringify(body):undefined});
 const call=async(...args)=>{const r=await raw(...args);return{status:r.status,data:await r.json()};};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 ok(await call('/api/status'));ok(await call('/api/auth/bootstrap',{username:'primary.owner',password:'Primary-Fixture-2026!',fullName:'Συνθετικός ιδιοκτήτης'}));
 // Repair distribution must retain its actual auth while a business DO fails.
 const quotaEnv={DB:db,SERVER_KEY:serverKey,FLEET_EVENTS:{idFromName(){throw Error('Exceeded allowed rows written in Durable Objects free tier.');}}};
 const independent=await worker.fetch(new Request('https://fixture/api/server-update',{headers:{'X-Fleet-Server-Key':serverKey}}),quotaEnv,{waitUntil(){}});
 assert.notEqual(independent.status,500,'Server update metadata does not enter the exhausted authority coordinator');
 const unauthorizedRepair=await worker.fetch(new Request('https://fixture/api/server-update'),quotaEnv,{waitUntil(){}});assert.equal(unauthorizedRepair.status,401,'repair distribution retains Server authorization');
 await assert.rejects(routePrimary(new Request('https://fixture/api/sync'),quotaEnv),/Exceeded allowed rows/,'business reads still require the real authority');
 // A business table omitted by an old static inventory must not remain writable
 // or disappear from the final frozen export. Use multi-byte large-cell data.
 const largePayload='Κ'.repeat(90000);
 await db.prepare('CREATE TABLE unlisted_business_data(id TEXT PRIMARY KEY,payload TEXT NOT NULL)').run();
 await db.prepare('INSERT INTO unlisted_business_data(id,payload) VALUES(?,?)').bind('fixture',largePayload).run();
 // Frozen exports must preserve exact 64-bit cents/IDs and the BLOB storage
 // class. JavaScript Number coercion or a NULL/deferred mix-up is data loss.
 await db.prepare('CREATE TABLE typed_business_fixture(id INTEGER PRIMARY KEY,big_positive INTEGER NOT NULL,big_negative INTEGER NOT NULL,small_blob BLOB NOT NULL,empty_blob BLOB NOT NULL,null_blob BLOB,safe_integer INTEGER NOT NULL,real_one REAL NOT NULL,real_fraction REAL NOT NULL,real_exponent REAL NOT NULL)').run();
 await db.prepare("INSERT INTO typed_business_fixture VALUES(1,9223372036854775807,-9007199254740992,x'00FF8001',x'',NULL,9007199254740991,1.0,0.1,1e-300)").run();
 const documents=await runtime.getR2Bucket('SERVICE_DOCS');
 await Promise.all(Array.from({length:26},(_,i)=>documents.put('service-documents/fixture/'+String(i).padStart(2,'0')+'.pdf','%PDF-1.4 synthetic '+i,{httpMetadata:{contentType:'application/pdf'},customMetadata:{displayName:'Συνθετικό '+i+'.pdf'}})));
 const recoveryToken=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),recoveryHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(recoveryToken))).toString('hex');
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicKey=Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64url');
 const input=()=>({generation:crypto.randomUUID(),ticket:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),publicKey,publicSalt:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),recoveryHash,username:'primary.owner',password:'Primary-Fixture-2026!'});
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
 assert.equal((await call('/api/primary/seed')).status,403,'Server credential alone cannot export migration secrets');
 const seed=ok(await call('/api/primary/seed',null,ticket));assert.equal(seed.authPepper,'primary-fixture-pepper');assert.equal(seed.publicKey,publicKey);assert.equal(seed.generation,migration.generation);assert(seed.eventSigningKey.length>40);
 const firstObjects=ok(await call('/api/primary/objects',null,ticket));assert.equal(firstObjects.objects.length,25);assert(firstObjects.cursor);
 const lastObjects=ok(await call('/api/primary/objects?cursor='+encodeURIComponent(firstObjects.cursor),null,ticket));assert.equal(lastObjects.objects.length,1);assert.equal(lastObjects.cursor,null);assert.equal(new Set([...firstObjects.objects,...lastObjects.objects].map(o=>o.key)).size,26);
 const document=firstObjects.objects[0];assert.equal(document.httpMetadata.contentType,'application/pdf');assert(document.customMetadata.displayName.includes('Συνθετικό'));
 assert.equal((await call('/api/primary/document',{key:document.key,etag:'stale'},ticket)).status,409,'changed source object rejected');
 const documentResponse=await raw('/api/primary/document',{key:document.key,etag:document.etag},ticket);assert.equal(documentResponse.status,200);assert.equal(documentResponse.headers.get('X-Fleet-Source-Etag'),document.etag);assert.equal(Buffer.byteLength(await documentResponse.text()),document.size);
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
 for(const [name,number] of [['real_one',1.0],['real_fraction',0.1],['real_exponent',1e-300]]){
   assert.equal(typedRow[name],null,'REAL never travels as untyped JSON number: '+name);
   assert.equal(meta(name).type,'real');
   assert.equal(Number(meta(name).decimal),number,'REAL binary64 round-trip: '+name);
 }
 assert(meta('real_one').decimal.includes('.'),'REAL 1.0 retains storage class');
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
 // A paused old invocation must not re-fence D1 after two different aborts.
 let releaseDelayed,enteredDelayed;const delayed=new Promise(resolve=>{releaseDelayed=resolve;}),entered=new Promise(resolve=>{enteredDelayed=resolve;});
 const cancelledA=input(),delayedEnv={SERVER_KEY:serverKey,FLEET_EVENTS:hub,DB:{prepare:db.prepare.bind(db),batch:async queries=>{enteredDelayed();await delayed;return db.batch(queries);}}};
 const delayedPrepare=routePrimary(new Request('https://fixture/api/primary/prepare',{method:'POST',headers:{'X-Fleet-Server-Key':serverKey},body:JSON.stringify(cancelledA)}),delayedEnv);
 await entered;ok(await call('/api/primary/abort',{}, {'X-Fleet-Primary-Ticket':cancelledA.ticket}));
 const cancelledB=input();ok(await call('/api/primary/prepare',cancelledB));ok(await call('/api/primary/abort',{}, {'X-Fleet-Primary-Ticket':cancelledB.ticket}));
 releaseDelayed();assert.equal((await delayedPrepare).status,409,'stale first fence remains cancelled after a second abort');assert.equal((await db.prepare('SELECT mode FROM fleet_primary_fence WHERE id=1').first()).mode,'cloud');
 assert((await db.prepare('SELECT COUNT(*) n FROM fleet_primary_cancellations').first()).n>=3,'all cancellation tombstones survive different tickets');
 assert.equal(ok(await call('/api/primary/descriptor')).mode,'cloud');
 migration=input();ok(await call('/api/primary/prepare',migration));const activeTicket={'X-Fleet-Primary-Ticket':migration.ticket};const activeSeed=ok(await call('/api/primary/seed',null,activeTicket));
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
 ws.addEventListener('message',event=>{if(event.data==='pong')return;const value=JSON.parse(event.data);if(value.type!=='request')return;messages++;assert.deepEqual(value.request,packet);assert.equal(value.request.body,undefined);assert.match(value.peerHash,/^[a-f0-9]{64}$/);ws.send(JSON.stringify({id:value.id,response:{...packet,ciphertext:'r'.repeat(100)}}));});
 const delivered=await worker.fetch(new Request('https://fixture/api/primary/request',{method:'POST',body:JSON.stringify(packet)}),unavailable);assert.equal(delivered.status,200);assert.equal((await delivered.json()).ciphertext,'r'.repeat(100));assert.equal(messages,1);assert.equal(reads,0,'active transport and static load do not touch D1');
 const signalTicket=await makeTicket({EVENT_SIGNING_KEY:activeSeed.eventSigningKey},{permissions:['cash.view']});
 const signalConnection=await runtime.dispatchFetch('https://fixture/api/events?ticket='+encodeURIComponent(signalTicket),{headers:{Upgrade:'websocket'}});assert.equal(signalConnection.status,101);const signalSocket=signalConnection.webSocket;signalSocket.accept();
 const signal=new Promise(resolve=>signalSocket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.type==='changed')resolve(value);}));
 const changeId=crypto.randomUUID(),changeAck=new Promise(resolve=>ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.type==='changes-ack')resolve(value);}));
 ws.send(JSON.stringify({type:'changes',id:changeId,scopes:['cash','fleet','unknown'],privateData:'must-never-broadcast'}));assert.equal((await changeAck).id,changeId,'durable native outbox receives scope-only delivery acknowledgement');assert.deepEqual(await signal,{type:'changed',scopes:['cash']},'authenticated primary socket only broadcasts allowed scope names, never data');signalSocket.close(1000,'test complete');
 const reused=await runtime.dispatchFetch('https://fixture/api/primary/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':serverKey,'X-Fleet-Primary-Proof':JSON.stringify(proof)}});assert.equal(reused.status,401,'challenge is single use');
 const oldDirect=await call('/api/direct/request',packet,{'X-Fleet-Direct-Key':'a'.repeat(64)});assert.equal(oldDirect.status,409,'stale legacy authorization is disabled after handover');
 const lease=new Promise(resolve=>ws.addEventListener('message',event=>{if(event.data==='pong')return;const value=JSON.parse(event.data);if(value.type==='lease')resolve(value);}));ws.send(JSON.stringify({type:'lease',nonce:'fixture-renewal'}));assert.equal((await lease).generation,migration.generation);
 // Recovery reserves the authority without D1, retires old sockets/proofs,
 // and waits out every old lease before a fresh identity can become active.
 const unused=ok(await call('/api/primary/challenge',{generation:migration.generation})),unusedProof={nonce:unused.nonce,generation:migration.generation,signature:Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(unused.message))).toString('base64url')};
 const candidateKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),candidatePublic=Buffer.from(await crypto.subtle.exportKey('spki',candidateKeys.publicKey)).toString('base64url');
 const nextToken=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),tokenHash=async token=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
 const replacement={recoveryToken,generation:crypto.randomUUID(),publicKey:candidatePublic,publicSalt:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),newRecoveryHash:await tokenHash(nextToken),contentHash:'c'.repeat(64),restoreVerified:true,documentsVerified:true,accountsReviewed:true};
 const recover=async(path,body)=>{const response=await worker.fetch(new Request('https://fixture/api/primary/recovery/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Fleet-Server-Key':serverKey},body:JSON.stringify(body)}),unavailable);return{status:response.status,data:await response.json()};};
 assert.equal((await recover('prepare',{...replacement,accountsReviewed:false})).status,409);assert.equal((await recover('prepare',{...replacement,recoveryToken:'w'.repeat(43)})).status,403);
 const reservation=ok(await recover('prepare',replacement));assert.equal(ok(await call('/api/primary/descriptor')).mode,'recovering');
 assert.deepEqual(ok(await recover('prepare',replacement)),reservation,'lost prepare ACK does not reset the lease gap');
 const rejectedOldSocket=await runtime.dispatchFetch('https://fixture/api/primary/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':serverKey,'X-Fleet-Primary-Proof':JSON.stringify(unusedProof)}});assert.equal(rejectedOldSocket.status,409,'an unused old signed challenge cannot reconnect during recovery');
 const firstFinish={recoveryToken,generation:replacement.generation,reservation:reservation.reservation,newBackupVerified:true,newBackupHash:'d'.repeat(64)};
 assert.equal((await recover('finish',{...firstFinish,newBackupVerified:false})).status,409);assert.equal((await recover('finish',firstFinish)).data.waiting,true,'new identity cannot overlap an old valid lease');
 // A second phone failing mid-recovery must not strand the verified candidate
 // backup; its pending capability can authorize a new third-device identity.
 const finalKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),finalPublic=Buffer.from(await crypto.subtle.exportKey('spki',finalKeys.publicKey)).toString('base64url');
 const finalToken=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),third={...replacement,recoveryToken:nextToken,generation:crypto.randomUUID(),publicKey:finalPublic,newRecoveryHash:await tokenHash(finalToken)};
 const finalReservation=ok(await recover('prepare',third));assert.notEqual(finalReservation.reservation,reservation.reservation);assert.equal((await recover('finish',firstFinish)).status,403,'cancelled second-device reservation cannot activate later');
 const finish={recoveryToken:nextToken,generation:third.generation,reservation:finalReservation.reservation,newBackupVerified:true,newBackupHash:'e'.repeat(64)};
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,finalReservation.notBefore-Date.now()+100)));
 const restored=ok(await recover('finish',finish));assert.equal(restored.generation,third.generation);assert(restored.eventSigningKey.length>40);assert.deepEqual(ok(await recover('finish',finish)),restored,'lost handover ACK is idempotent');
 assert.equal((await recover('prepare',{...replacement,generation:crypto.randomUUID()})).status,403,'original backup capability retired');assert.equal((await recover('prepare',{...third,generation:crypto.randomUUID()})).status,403,'authorizing candidate capability rotated after successful handover');
 const recoveredDescriptor=ok(await call('/api/primary/descriptor'));assert.equal(recoveredDescriptor.generation,third.generation);assert.equal(recoveredDescriptor.publicKey,finalPublic);assert.equal(recoveredDescriptor.eventKey,undefined);assert.equal(reads,0,'recovery controls and replacement never access unavailable D1');
 ws.close(1000,'test complete');
 await assert.rejects(db.prepare("UPDATE fleet_snapshot SET version=999 WHERE id=1").run(),/fleet_primary_writer_fenced/);
 console.log('PASS actual Workerd/D1/Durable Object including paired object/seed export, durable cancellation across migrations, recovery with third-device continuation/new-backup gate/lease gap/old-proof retirement and zero D1 access; also: owner and new-table race rejection, all-business-table atomic fence, bounded paged export and exact large Unicode cell slices, session exclusion, abort/activation exclusion, lost-ACK replay, sealed P-256 registration, legacy revocation, opaque encrypted relay, lease renewal, offline/no-D1 static and request paths.');
}finally{await runtime?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
