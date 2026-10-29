import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';

// One isolate/one database, with the real Worker routes and transactional SQLite.
const {db,call}=createSimulation();
const check=(result,status=200)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data;};
const {token,user}=check(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic Fleet owner',username:'ordexalifecycle',password:'SyntheticLifecycle!7'}}));
check(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day:'2026-10-19',capturedAt:'2026-10-19T20:00:00Z',report:{riders:[{riderId:'17',name:'Synthetic provider label',sessions:[{id:'1',day:'2026-10-19',inAt:'2026-10-19T08:00:00+03:00',outAt:'2026-10-19T16:00:00+03:00'}]}]}}}));
let row=db.sqlite.prepare('SELECT * FROM ordexa_riders').get();
check(await call('/api/admin/ordexa/mapping',{token,method:'POST',body:{cityId:'7',riderId:'17',employeeId:user.id,revision:row.revision,reason:'Explicit synthetic identity'}}));
check(await call('/api/admin/ordexa/policy',{token,method:'POST',body:{gapMinutes:15,gapTreatment:'exclude',revision:0,reason:'Explicit synthetic policy'}}));
db.sqlite.prepare("UPDATE system_settings SET value='ordexa' WHERE key='payroll_hours_source'").run();
const payPolicy=check(await call('/api/admin/ordexa/pay-policy',{token})).policy;
check(await call('/api/admin/ordexa/pay-policy',{token,method:'POST',body:{policy:{...payPolicy,enabled:true},revision:payPolicy.revision,reason:'Synthetic decision backup coverage'}}));
const source=db.sqlite.prepare('SELECT * FROM ordexa_sessions').get(),review=check(await call('/api/admin/ordexa/pay-review?id='+encodeURIComponent('ordexa:'+source.id),{token})).review;
check(await call('/api/admin/ordexa/pay-review',{token,method:'POST',body:{id:review.id,revision:review.revision,fingerprint:review.fingerprint,chosenScheduleId:'none',startChoice:'clock',endChoice:'clock',reason:'Synthetic retained pay decision'}}));
const originalBatch=db.batch.bind(db);
for(const race of ['revision','source']){
 let intercepted=false;
 db.batch=async statements=>{
  if(!intercepted&&statements.some(statement=>statement.sql.includes('INSERT INTO payroll_snapshots'))){
   intercepted=true;
   db.sqlite.exec(race==='revision'?"UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'":"UPDATE system_settings SET value='clock' WHERE key='payroll_hours_source'");
  }
  return originalBatch(statements);
 };
 check(await call('/api/admin/payroll/lock',{token,method:'POST',body:{startDate:'2026-10-19',endDate:'2026-10-19',reason:'Synthetic concurrent '+race}}),409);
 assert.ok(intercepted);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM payroll_snapshots').get().n,0);
 assert.equal(db.sqlite.prepare('SELECT status FROM payroll_periods').get().status,'open');
 db.sqlite.prepare("UPDATE system_settings SET value='ordexa' WHERE key='payroll_hours_source'").run();
}
db.batch=originalBatch;
check(await call('/api/admin/payroll/lock',{token,method:'POST',body:{startDate:'2026-10-19',endDate:'2026-10-19',reason:'Synthetic final verified lock'}}));
const session=db.sqlite.prepare('SELECT * FROM ordexa_sessions').get();
check(await call('/api/admin/ordexa/review',{token,method:'POST',body:{id:session.id,revision:session.revision,action:'ignore',reason:'Synthetic retained decision'}}));
check(await call('/api/admin/pin',{server:true,method:'POST',body:{pin:'246810'}}));
const backup=check(await call('/api/server/system-export',{server:true}));
assert.equal(Object.keys(backup.workforce).length,34);
for(const table of ['ordexa_riders','ordexa_imports','ordexa_sessions','ordexa_pay_decisions'])assert.ok(backup.workforce[table].length);
const head=check(await call('/api/server/system-export/page',{server:true})).mirror;
db.sqlite.prepare("UPDATE ordexa_riders SET employee_id=NULL,name='Changed label'").run();
db.sqlite.prepare("UPDATE ordexa_sessions SET ignored=0,decision_reason='Changed decision'").run();
db.sqlite.prepare("UPDATE ordexa_imports SET accepted=0").run();
db.sqlite.prepare("UPDATE ordexa_pay_decisions SET reason='Changed pay decision'").run();
const headers={'X-Admin-Pin':'246810'};
const preview=check(await call('/api/server/system-import/preview',{server:true,method:'POST',headers,body:backup}));
check(await call('/api/server/system-import',{server:true,method:'PUT',headers,body:{...backup,restoreGuard:preview.restoreGuard}}));
for(const table of ['ordexa_riders','ordexa_imports','ordexa_sessions','ordexa_pay_decisions'])assert.deepEqual(db.sqlite.prepare('SELECT * FROM '+table).all().map(r=>({...r})),backup.workforce[table],table+' exact raw/identity/decision roundtrip');
let cursor=head.cursor,until;const changes=[];
for(let page=0;page<100;page++){
 const delta=check(await call('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor+(until==null?'':'&until='+until),{server:true}));
 changes.push(...delta.changes);cursor=delta.nextCursor;until=delta.until;if(!delta.hasMore)break;
 assert.ok(page<99,'Bounded synthetic mirror pages');
}
for(const table of ['ordexa_riders','ordexa_imports','ordexa_sessions','ordexa_pay_decisions'])assert.ok(changes.some(c=>c.table===table),table+' must reach the local mirror after restore');
console.log('PASS Ordexa lifecycle: revision/source races cannot lock stale pay, no partial snapshots, successful retry, 34-table backup and exact Ordexa identity/raw/decision restore with differential mirror. Synthetic only.');
