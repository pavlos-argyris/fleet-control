import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ordexa-d1-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'ordexa-fixture'},bindings:{SERVER_KEY:'ordexa-fixture',PIN_PEPPER:'ordexa-pepper'}}));
 const db=await runtime.getD1Database('DB');
 const call=async(url,body,token,method)=>{const response=await runtime.dispatchFetch('https://fixture'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{'X-Fleet-Server-Key':'ordexa-fixture'})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
 const boot=await call('/api/auth/bootstrap',{fullName:'Fleet different employee',username:'ordexatest',password:'OrdexaFixture!123'});assert.equal(boot.status,200);const token=boot.data.token;
 const employee=(await db.prepare("SELECT id FROM app_users WHERE username='ordexatest'").first()).id;
 const report=(day='2026-10-19',stamp=day+'T22:00:00.000Z',sessions=[{id:'s1',day,inAt:day+'T08:00:00+03:00',outAt:day+'T16:00:00+03:00'}])=>({cityId:'city-a',day,capturedAt:stamp,report:{riders:[{riderId:'provider-17',name:'Provider completely different',sessions}]}});
 assert.equal((await call('/api/server/ordexa/import',report(),'invalid-user-token')).status,401);
 let r=await call('/api/server/ordexa/import',report());assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.saved,true);
 r=await call('/api/admin/ordexa?from=2026-10-19&to=2026-10-25',undefined,token);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.riders[0].employee_id,null,'Never join by a guessed name');
 let rider=r.data.riders[0];r=await call('/api/admin/ordexa/mapping',{cityId:rider.city_id,riderId:rider.rider_id,employeeId:employee,revision:rider.revision,reason:'Explicit different-name pair'},token);assert.equal(r.status,200,JSON.stringify(r));
 assert.equal((await call('/api/admin/ordexa/mapping',{cityId:rider.city_id,riderId:rider.rider_id,employeeId:null,revision:rider.revision,reason:'Stale'},token)).status,409);
 const renamed=report('2026-10-19','2026-10-19T23:00:00Z');renamed.report.riders[0].name='Renamed label';await call('/api/server/ordexa/import',renamed);
 assert.equal((await db.prepare('SELECT employee_id FROM ordexa_riders').first()).employee_id,employee);
 const repeat=report('2026-10-19','2026-10-19T23:30:00Z');const concurrent=await Promise.all(Array.from({length:8},()=>call('/api/server/ordexa/import',repeat)));for(const item of concurrent)assert.equal(item.status,200,JSON.stringify(item));assert.equal((await db.prepare('SELECT COUNT(*) n FROM ordexa_imports WHERE captured_at=?').bind('2026-10-19T23:30:00.000Z').first()).n,1);
 const mapping=await db.prepare('SELECT * FROM ordexa_riders').first();await db.exec("CREATE TRIGGER ordexa_fixture_audit BEFORE INSERT ON audit_log WHEN NEW.action='ordexa_mapping' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
 assert.equal((await call('/api/admin/ordexa/mapping',{cityId:mapping.city_id,riderId:mapping.rider_id,employeeId:null,revision:mapping.revision,reason:'Must roll back'},token)).status,500);assert.deepEqual(await db.prepare('SELECT * FROM ordexa_riders').first(),mapping);await db.exec('DROP TRIGGER ordexa_fixture_audit;');
 const before=await db.prepare('SELECT raw_json FROM ordexa_sessions').first();assert.equal((await call('/api/server/ordexa/import',report('2026-10-19','2026-10-19T21:00:00Z',[]))).data.accepted,false);assert.deepEqual(await db.prepare('SELECT raw_json FROM ordexa_sessions').first(),before);
 assert.equal((await call('/api/server/ordexa/import',renamed)).data.replayed,true);
 for(let day=20;day<=25;day++)assert.equal((await call('/api/server/ordexa/import',report('2026-10-'+day,'2026-10-'+day+'T22:00:00Z',[]))).status,200);
 assert.equal((await call('/api/admin/ordexa/policy',{gapMinutes:15,gapTreatment:'exclude',revision:0,reason:'Explicit policy'},token)).status,200);
 assert.equal((await call('/api/admin/ordexa/policy',{gapMinutes:30,gapTreatment:'include',revision:0,reason:'Stale policy'},token)).status,409);
 await db.prepare("UPDATE system_settings SET value='ordexa' WHERE key='payroll_hours_source'").run();
 r=await call('/api/admin/payroll?start=2026-10-19&end=2026-10-25',undefined,token);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.hoursSource,'ordexa');assert.equal(r.data.blockers.length,0);assert.equal(r.data.employees.length,1);assert.ok(r.data.totals.payableHours>0);
 // An absent old event is retained and explicitly held, never silently deleted.
 await call('/api/server/ordexa/import',report('2026-10-19','2026-10-20T01:00:00Z',[]));
 const missing=await db.prepare('SELECT * FROM ordexa_sessions').first();assert.equal(missing.review,1);assert.ok(missing.missing_since);assert.equal(missing.raw_json,before.raw_json);
 r=await call('/api/admin/payroll?start=2026-10-19&end=2026-10-25',undefined,token);assert.ok(r.data.blockers.length>0);
 // Restore the disappeared event and resolve it explicitly. Source clock
 // records remain independent and cannot be counted alongside Ordexa.
 await call('/api/server/ordexa/import',report('2026-10-19','2026-10-20T02:00:00Z'));
 let current=await db.prepare('SELECT * FROM ordexa_sessions').first();assert.equal((await call('/api/admin/ordexa/review',{id:current.id,revision:current.revision,action:'accept',reason:'Verified restored original'},token)).status,200);
 await db.prepare("INSERT INTO shifts(id,employee_id,vehicle_id,current_vehicle_id,initial_km,status,actual_clock_in,actual_clock_out,payable_minutes,base_pay_cents,final_pay_cents,created_at,updated_at) VALUES('fleet-shadow',?,'__own_vehicle__fixture','__own_vehicle__fixture',0,'completed','2026-10-19T05:00:00.000Z','2026-10-19T13:00:00.000Z',480,4800,4800,'2026-10-19','2026-10-19')").bind(employee).run();
 r=await call('/api/admin/payroll?start=2026-10-19&end=2026-10-25',undefined,token);assert.equal(r.data.totals.payableHours,8,'Ordexa and Fleet shadow shift must not be summed');assert.equal(r.data.employees[0].sourceRows[0].sourceSessionIds.length,1);
 assert.equal((await call('/api/admin/payroll/lock',{startDate:'2026-10-19',endDate:'2026-10-25',reason:'Synthetic verified source'},token)).status,200);
 const snapshot=await call('/api/admin/payroll?start=2026-10-19&end=2026-10-25',undefined,token);assert.equal(snapshot.data.lockedSnapshot,true);
 const moved=report('2026-10-26','2026-10-26T23:00:00Z');assert.equal((await call('/api/server/ordexa/import',moved)).status,200);current=await db.prepare('SELECT * FROM ordexa_sessions').first();assert.equal(current.provider_day,'2026-10-26');assert.equal(current.review,1);assert.ok(current.previous_raw_json);
 assert.equal((await call('/api/admin/ordexa/review',{id:current.id,revision:current.revision,action:'accept',reason:'Would count same event in new period'},token)).status,409);
 const after=await call('/api/admin/payroll?start=2026-10-19&end=2026-10-25',undefined,token);assert.deepEqual(after.data.totals,snapshot.data.totals,'Provider correction must not change locked pay');
 const count=await db.prepare('SELECT COUNT(*) n FROM ordexa_imports').first();assert.ok(count.n>=10);
 const bad=report();delete bad.report.riders;assert.equal((await call('/api/server/ordexa/import',bad)).status,400);assert.deepEqual(await db.prepare('SELECT COUNT(*) n FROM ordexa_imports').first(),count);
 console.log('PASS actual Workerd/D1 Ordexa: auth, explicit different-name mapping, stable rename, CAS/replay/stale source fencing, complete daily coverage, configured payroll source, missing-event retention and blocked incomplete payroll. Synthetic only.');
}finally{if(runtime)await runtime.dispose();fs.rmSync(dir,{recursive:true,force:true});}
