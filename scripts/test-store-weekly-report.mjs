import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {routeStoreBilling,storeBusinessDay} from '../cloudflare-worker/src/store-billing.js';
await import('../cloudflare-worker/public/store-weekly-report.js');const R=globalThis.FleetStoreWeeklyReport;
const {call,db}=createSimulation(),ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
try{
 const {token}=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Δοκιμαστικός Ιδιοκτήτης',username:'reportowner',password:'SyntheticReport!1'}}));
 const server=(action,body)=>call('/api/server/store-billing/'+action,{server:true,method:'POST',body}),post=body=>call('/api/admin/store-billing/bulk',{token,method:'POST',body}),get=(action,args)=>call('/api/admin/store-billing/'+action+'?'+new URLSearchParams(args),{token});
 let control=ok(await server('control',{scope:'report-scope',generation:'gen1',generationAt:1,cityId:'7',from:'2026-10-26',to:'2026-11-01'}));
 const ctx={scope:'report-scope',generation:'gen1',epoch:control.epoch,operationId:control.job.id,lease:control.job.lease};
 const catalogue=[1,2,3].map(i=>({id:'store:'+i,sourceShopId:String(i),name:'Κατάστημα '+i,blocked:false,sourceTerms:[{effectiveDay:'',supported:true,unitPriceCents:200,dailyMinimumCents:1000,chargeOnZero:false}]}));
 ok(await server('catalogue',{...ctx,stores:catalogue,complete:true,catalogueHash:'a'.repeat(64)}));
 const ids=['store:1','store:2'],args={ids:JSON.stringify(ids),from:'2026-10-26'};
 const save=async(id,effectiveDay,patch,operationId=crypto.randomUUID())=>post({stores:[{id,revision:db.sqlite.prepare('SELECT revision FROM store_billing_records WHERE id=?').get(id).revision}],effectiveDay,patch,operationId});
 ok(await save('store:1','2026-10-28',{unitPriceCents:250,dailyMinimumCents:1200}));
 let history=ok(await get('history',{storeId:'store:1'}));assert.equal(history.rows.length,1);assert.equal(history.rows[0].audit.changes.length,2);assert.deepEqual(history.rows[0].audit.changes.map(c=>[c.oldValue,c.newValue]),[[200,250],[1000,1200]]);assert.equal(history.rows[0].audit.actor.role,'owner');
 const count=db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='store_billing_terms'").get().n;
 ok(await save('store:1','2026-10-28',{unitPriceCents:250}));assert.equal(ok(await get('history',{storeId:'store:1'})).rows.length,1,'no-op creates no false terms history');assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='store_billing_terms'").get().n,count);
 // Backdated changes are new events, never overwrites, and filter on effective day.
 ok(await save('store:1','2026-10-29',{unitPriceCents:300}));
 ok(await save('store:2','2026-10-20',{unitPriceCents:180}));
 const storedTerms=()=>db.sqlite.prepare("SELECT data FROM store_billing_records WHERE kind='terms'").all().map(r=>JSON.parse(r.data));
 const insert=db.sqlite.prepare('INSERT INTO store_billing_records(id,scope,kind,store_id,day,data,updated_at) VALUES(?,?,?,?,?,?,?)');
 for(let n=0;n<7;n++){const day=R.plus(args.from,n);insert.run('pub:'+day,ctx.scope,'publication','',day,JSON.stringify({protocol:2,activeRun:'run:'+day,sourceLastSuccessAt:day+'T22:00:00Z'}),day+'T22:00:00Z');for(const id of ids){const t=R.termFor(storedTerms(),id,day),orderCount=n===1?0:2,orderChargeCents=orderCount*t.unitPriceCents,minimumTopUpCents=orderCount?Math.max(0,t.dailyMinimumCents-orderChargeCents):0;insert.run('day:'+id+':'+day,ctx.scope,'day',id,day,JSON.stringify({protocol:2,storeId:id,businessDay:day,orderCount,orderChargeCents,minimumTopUpCents,totalChargeCents:orderChargeCents+minimumTopUpCents,termsId:t.id,cutoffHour:5,timeZone:'Europe/Athens',retentionUsed:false,reviewCount:0,sourceLastSuccessAt:day+'T22:00:00Z'}),day+'T22:00:00Z');}}
 const before=db.sqlite.prepare('SELECT COUNT(*) n FROM store_billing_records').get().n;
 let raw=ok(await get('weekly-report',args)),report=R.build(raw);assert.equal(report.rows.length,14);assert.equal(report.total.incomplete,0);assert.equal(report.rows[0].orderChargeCents,400);assert.equal(report.rows[0].minimumTopUpCents,600);assert.equal(report.rows[0].totalChargeCents,1000,'2 × 2€ + 6€ = 10€');
 assert.equal(report.rows[1].minimumTopUpCents,0,'0 orders -> no top-up');assert.equal(report.rows[2].orderChargeCents,500,'effective Wednesday price');assert.equal(report.rows[3].orderChargeCents,600,'later effective price');assert.equal(report.total.totalChargeCents,13000);
 assert.equal(report.changes.length,3,'two fields Wednesday + one Thursday; pre-week change is a baseline');assert.ok(report.changes.every(c=>c.retroactive));assert.equal(report.baselines[1].term.unitPriceCents,180);
 const a=R.render(report,'stores'),b=R.render(report,'combined');for(const html of [a,b]){assert.match(html,/13\.000|130,00/);assert.match(html,/Αλλαγές τιμολόγησης/);assert.match(html,/Αναδρομική ισχύς/);assert.doesNotMatch(html,/Κατάστημα 3/);assert.equal((html.match(/Γενικό σύνολο εβδομάδας/g)||[]).length,1);}assert.equal((b.match(/Σύνολο (?:Δευτέρα|Τρίτη|Τετάρτη|Πέμπτη|Παρασκευή|Σάββατο|Κυριακή)/g)||[]).length,7);
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM store_billing_records').get().n,before,'report and toggles do not write');
 ok(await get('weekly-report',{...args,ids:JSON.stringify(['store:1','store:1'])}),400);ok(await get('weekly-report',{...args,ids:JSON.stringify(['store:absent'])}),409);ok(await get('weekly-report',{...args,from:'2026-10-27'}),400);
 const one=R.build(ok(await get('weekly-report',{...args,ids:JSON.stringify(['store:2'])})));assert.equal(one.rows.length,7);assert.equal(one.total.totalChargeCents,6000);
 ok(await save('store:1','2026-10-30',{unitPriceCents:350}));ok(await get('weekly-report',{...args,snapshot:raw.snapshot}),409,'changed snapshot cannot mix pages');raw=ok(await get('weekly-report',args));report=R.build(raw);assert.ok(report.total.incomplete>0);assert.equal(report.total.totalChargeCents,null,'stale terms never look final');
 // Deterministic proof of optimistic concurrency / no partial audit.
 const revision=db.sqlite.prepare("SELECT revision FROM store_billing_records WHERE id='store:1'").get().revision,body={stores:[{id:'store:1',revision}],effectiveDay:'2026-10-31',patch:{dailyMinimumCents:1500}};
 const saved=ok(await post({...body,operationId:'cas-first'}));ok(await post({...body,operationId:'cas-second'}),409);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM store_billing_records WHERE id='cas-second'").get().n,0);assert.equal(ok(await post({...body,operationId:'cas-first'})).replayed,true);
 for(let i=0;i<32;i++)ok(await save('store:2','2026-11-01',{unitPriceCents:200+i}));history=ok(await get('history',{storeId:'store:2'}));assert.equal(history.rows.length,30);assert.equal(history.hasMore,true);assert.equal(ok(await get('history',{storeId:'store:2',cursor:history.nextCursor})).rows.length,3);
 const latest=history.rows.map(r=>r.id);const oldRecord=db.sqlite.prepare("SELECT * FROM store_billing_records WHERE kind='terms' AND store_id='store:2' AND json_extract(data,'$.audit.schema')=1 ORDER BY json_extract(data,'$.audit.recordedAt'),id LIMIT 1").get();db.sqlite.prepare('DELETE FROM store_billing_records WHERE id=?').run(oldRecord.id);db.sqlite.prepare('INSERT INTO store_billing_records(id,scope,kind,store_id,day,revision,data,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(...['id','scope','kind','store_id','day','revision','data','updated_at'].map(k=>oldRecord[k]));assert.deepEqual(ok(await get('history',{storeId:'store:2'})).rows.map(r=>r.id),latest,'history remains chronologically stable after backup reinsertion changes SQLite rowids');
 // Real authenticated restricted reader can export/history and cannot write.
 const employee=ok(await call('/api/admin/employees',{token,method:'POST',body:{fullName:'Synthetic store reader',username:'storereader',password:'SyntheticReader!7',role:'manager',loginEnabled:true}}),201).employee;
 db.sqlite.prepare('UPDATE app_users SET permissions=? WHERE id=?').run(JSON.stringify(['!stores.manage']),employee.id);
 const reader=ok(await call('/api/auth/user-login',{method:'POST',body:{username:'storereader',password:'SyntheticReader!7',platform:'web',deviceId:'fixture-reader',deviceName:'Fixture reader'}}));
 ok(await call('/api/admin/store-billing/weekly-report?'+new URLSearchParams(args),{token:reader.token}));ok(await call('/api/admin/store-billing/history?storeId=store:1',{token:reader.token}));
 ok(await call('/api/admin/store-billing/bulk',{token:reader.token,method:'POST',body:{...body,operationId:'viewer-write'}}),403);
 db.sqlite.prepare('UPDATE app_users SET permissions=? WHERE id=?').run(JSON.stringify(['!stores.manage','!stores.view']),employee.id);
 ok(await call('/api/admin/store-billing/weekly-report?'+new URLSearchParams(args),{token:reader.token}),403);ok(await call('/api/admin/store-billing/history?storeId=store:1'),401);
 // Explicit read role gate on both endpoints; write remains stores.manage.
 const seen=[],D={authenticate:async(req,env,permission)=>{seen.push(permission);return {user_id:'viewer',full_name:'Viewer',role:'manager'};},ApiError:class extends Error{constructor(status,message){super(message);this.status=status;}},wfJson:v=>Response.json(v),bodyJson:req=>req.json()};
 await routeStoreBilling(new Request('https://fixture/api/admin/store-billing/history?storeId=store:1'),{DB:db},'/api/admin/store-billing/history',D);assert.equal(seen.pop(),'stores.view');
 await routeStoreBilling(new Request('https://fixture/api/admin/store-billing/weekly-report?'+new URLSearchParams(args)),{DB:db},'/api/admin/store-billing/weekly-report',D);assert.equal(seen.pop(),'stores.view');
 assert.equal(storeBusinessDay('2026-10-25T03:30:00+02:00'),'2026-10-24');assert.equal(storeBusinessDay('2026-03-29T03:30:00+02:00'),'2026-03-28');
 const missing=structuredClone(raw);missing.days=missing.days.slice(1);assert.equal(R.build(missing).total.totalChargeCents,null);const zero=structuredClone(one);zero.days[0].orderCount=0;zero.days[0].orderChargeCents=0;zero.days[0].minimumTopUpCents=1000;zero.days[0].totalChargeCents=1000;assert.match(R.build(zero).rows[0].problem,/χωριστή χρέωση/);
 console.log('PASS #76 Worker/SQLite + report: immutable per-store cents/actor audit, no-op/replay/CAS, retroactive/effective terms, baselines, selected stores, 7 days, 2×2+6=10, zero-order compatibility, identical A/B totals, missing/stale/invalid data, paged history, view permissions and snapshot consistency; no provider reads.');
}finally{db.sqlite.close();}
