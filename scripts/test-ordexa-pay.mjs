import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import '../cloudflare-worker/public/ordexa-pay-core.js';
const C=globalThis.FleetOrdexaPayCore,p={...C.defaults,enabled:true};
for(const [minute,expected] of [[0,'18:00'],[14,'18:00'],[15,'18:30'],[29,'18:30'],[30,'18:30'],[44,'18:30'],[45,'19:00'],[59,'19:00']])assert.equal(C.clockLabel(18,minute,'start',p),expected);
for(const [minute,expected] of [[0,'20:00'],[20,'20:00'],[21,'20:30'],[40,'20:30'],[46,'20:30'],[47,'21:00'],[59,'21:00']])assert.equal(C.clockLabel(20,minute,'end',p),expected);
assert.equal(C.round('2026-10-19T18:14:59.999+03:00','start',p),'2026-10-19T15:00:00.000Z');
assert.equal(C.round('2026-10-19T18:15:00+03:00','start',p),'2026-10-19T15:30:00.000Z');
assert.equal(C.round('2026-10-19T23:47:00+03:00','end',p),'2026-10-19T21:00:00.000Z','Midnight rounding retains next-day local date');
const {db,call}=createSimulation(),ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const {token,user}=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic wage worker',username:'payprofile',password:'SyntheticPayProfile!7'}}));
const request=(path,body,method='POST')=>call(path,{token,method,body});
const empty=ok(await call('/api/admin/ordexa/pay-policy',{token}));assert.equal(empty.policy.enabled,false);
ok(await call('/api/admin/ordexa/pay-policy'),401);
ok(await request('/api/admin/ordexa/pay-policy',{policy:p,revision:0,reason:'Explicit synthetic half-hour profile'}));
ok(await request('/api/admin/ordexa/pay-policy',{policy:p,revision:0,reason:'Stale update'}),409);
db.sqlite.exec("UPDATE pay_rules SET normal_rate_cents=600,start_round_mode='up',start_round_minutes=30,end_round_mode='none',minimum_minutes=0,maximum_minutes=1440 WHERE id='default-general'; UPDATE system_settings SET value='ordexa' WHERE key='payroll_hours_source';");
const plan=(day,start='08:00',end='16:00')=>{const a=day+'T'+start+':00+03:00',b=day+'T'+end+':00+03:00';db.sqlite.prepare("INSERT INTO schedules(id,employee_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,?,'planned',?,'fixture','fixture')").run('plan-'+day,user.id,new Date(a).toISOString(),new Date(b).toISOString(),user.id);};
let capture=0;
const send=async(day,start,end,id=day)=>{const body={cityId:'7',day,capturedAt:new Date(Date.parse('2026-10-28T20:00:00Z')+(++capture)*1000).toISOString(),report:{riders:[{riderId:'17',name:'Different provider name',sessions:start?[{id,day,inAt:start,outAt:end}]:[]}]}};return ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body}));};
plan('2026-10-19');await send('2026-10-19','2026-10-19T08:10:00+03:00','2026-10-19T16:20:00+03:00');
let rider=db.sqlite.prepare('SELECT * FROM ordexa_riders').get();ok(await request('/api/admin/ordexa/mapping',{cityId:'7',riderId:'17',employeeId:user.id,revision:rider.revision,reason:'Explicit synthetic mapping'}));
ok(await request('/api/admin/ordexa/policy',{gapMinutes:15,gapTreatment:'include',revision:0,reason:'Explicit synthetic continuity'}));
const payroll=async day=>ok(await call('/api/admin/payroll?start='+day+'&end='+day,{token}));
let result=await payroll('2026-10-19');assert.equal(result.totals.payableHours,8);assert.equal(result.totals.finalCents,4800);assert.equal(result.ordexaReviews.length,0);assert.equal(result.blockers.length,0,'Small deviations follow the published program without warnings');
const approve=async(review,startChoice='program',endChoice='program',extra={})=>ok(await request('/api/admin/ordexa/pay-review',{id:review.id,revision:review.revision,fingerprint:review.fingerprint,chosenScheduleId:review.chosenScheduleId,startChoice,endChoice,reason:'Synthetic direct shift decision',...extra}));
plan('2026-10-20');await send('2026-10-20','2026-10-20T08:20:00+03:00','2026-10-20T16:05:00+03:00');
result=await payroll('2026-10-20');assert.equal(result.totals.payableHours,7.5);assert.equal(result.ordexaReviews.length,1);assert.equal(result.ordexaReviews[0].reasons[0].key,'late_start');let late=result.ordexaReviews[0];
ok(await request('/api/admin/payroll/lock',{startDate:'2026-10-20',endDate:'2026-10-20',reason:'Unreviewed late clock must block'}),409);
await approve(late,'clock','program');result=await payroll('2026-10-20');assert.equal(result.totals.payableHours,7.5);assert.equal(result.ordexaReviews.length,0);assert.equal(result.blockers.length,0);
ok(await request('/api/admin/ordexa/pay-review',{id:late.id,revision:late.revision,fingerprint:late.fingerprint,startChoice:'program',endChoice:'program',reason:'Stale decision'}),409);
plan('2026-10-21');await send('2026-10-21','2026-10-21T08:35:00+03:00','2026-10-21T16:00:00+03:00');result=await payroll('2026-10-21');assert.equal(result.totals.payableHours,7);await approve(result.ordexaReviews[0],'program','program');assert.equal((await payroll('2026-10-21')).totals.payableHours,8,'Manager can explicitly retain the program');
plan('2026-10-22');await send('2026-10-22','2026-10-22T07:41:00+03:00','2026-10-22T16:01:00+03:00');result=await payroll('2026-10-22');assert.equal(result.totals.payableHours,8);assert.equal(result.ordexaReviews[0].reasons[0].key,'early_start');let early=result.ordexaReviews[0];
await payroll('2026-10-22');assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM system_alerts WHERE object_id=? AND type='ordexa_pay_review'").get(early.id).n,1,'Repeated reads/sync never create duplicate notifications for the shift');
const alert=db.sqlite.prepare("SELECT * FROM system_alerts WHERE object_id=? AND type='ordexa_pay_review'").get(early.id);ok(await request('/api/admin/alerts/'+alert.id+'/resolve',{}),409,'A payment warning cannot be dismissed without a decision');
await approve(early);assert.equal((await payroll('2026-10-22')).ordexaReviews.length,0);
// Completing/correcting an out preserves a valid approved start, and reopens
// the same notification only for the newly changed side.
await send('2026-10-22','2026-10-22T07:41:00+03:00','2026-10-22T16:40:00+03:00');
let raw=db.sqlite.prepare("SELECT * FROM ordexa_sessions WHERE source_id='2026-10-22'").get();assert.equal(raw.review,1);
ok(await request('/api/admin/ordexa/review',{id:raw.id,revision:raw.revision,action:'accept',reason:'Synthetic corrected raw out accepted'}));
result=await payroll('2026-10-22');let changed=result.ordexaReviews[0];assert.equal(changed.reasons.length,1);assert.equal(changed.reasons[0].side,'end');assert.equal(changed.actualEnd,'2026-10-22T13:40:00.000Z');assert.equal(changed.clockEnd,'2026-10-22T13:30:00.000Z');assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM system_alerts WHERE object_id=? AND type='ordexa_pay_review'").get(early.id).n,1);
const before=db.sqlite.prepare('SELECT * FROM ordexa_pay_decisions WHERE id=?').get(changed.id);
db.sqlite.exec("CREATE TRIGGER pay_audit_rollback BEFORE INSERT ON audit_log WHEN NEW.action='ordexa_pay_decision' BEGIN SELECT RAISE(ABORT,'synthetic pay rollback'); END;");
ok(await request('/api/admin/ordexa/pay-review',{id:changed.id,revision:changed.revision,fingerprint:changed.fingerprint,startChoice:'program',endChoice:'clock',reason:'Must roll back'}),500);assert.deepEqual(db.sqlite.prepare('SELECT * FROM ordexa_pay_decisions WHERE id=?').get(changed.id),before);db.sqlite.exec('DROP TRIGGER pay_audit_rollback;');
await approve(changed,'program','clock');result=await payroll('2026-10-22');assert.equal(result.totals.payableHours,8.5);assert.equal(result.totals.finalCents,5100);assert.equal(result.blockers.length,0);
ok(await request('/api/admin/payroll/lock',{startDate:'2026-10-22',endDate:'2026-10-22',reason:'Synthetic checked decision'}));const locked=(await payroll('2026-10-22')).totals;
ok(await request('/api/admin/ordexa/pay-review',{id:changed.id,revision:changed.revision+1,fingerprint:changed.fingerprint,startChoice:'clock',endChoice:'clock',reason:'Cannot change locked pay'}),409);assert.deepEqual((await payroll('2026-10-22')).totals,locked);
// No published program: actual endpoints use the explicit half-hour profile,
// bypassing older per-rule endpoint rounding while preserving the raw times.
await send('2026-10-25','2026-10-25T18:14:00+02:00','2026-10-25T20:20:00+02:00');result=await payroll('2026-10-25');assert.equal(result.totals.payableHours,2);assert.equal(result.totals.finalCents,1200);assert.equal(result.ordexaReviews.length,0);
const stored=db.sqlite.prepare("SELECT raw_json FROM ordexa_sessions WHERE source_id='2026-10-25'").get();assert.match(stored.raw_json,/18:14:00/);assert.match(stored.raw_json,/20:20:00/);
// Planned midnight starts belong to the program's day, even if the employee
// clocked early on the preceding calendar date.
plan('2026-10-24','00:00','08:00');await send('2026-10-23','2026-10-23T23:41:00+03:00','2026-10-24T08:05:00+03:00');await send('2026-10-24',null,null);
assert.equal((await payroll('2026-10-23')).totals.payableHours,0);result=await payroll('2026-10-24');assert.equal(result.totals.payableHours,8);assert.equal(result.ordexaReviews.length,1);assert.equal(result.ordexaReviews[0].anchorDate,'2026-10-24');
// A published-plan update between preview and transaction invalidates both a
// direct decision and a payroll lock, even when the raw provider rows did not change.
const originalBatch=db.batch.bind(db);let intercepted=false;
const previousAudit=db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='ordexa_pay_decision'").get().n;
db.batch=async statements=>{if(!intercepted&&statements.some(s=>s.sql.includes('INSERT INTO ordexa_pay_decisions'))){intercepted=true;db.sqlite.exec("UPDATE schedules SET end_at='2026-10-24T05:30:00.000Z' WHERE id='plan-2026-10-24'");}return originalBatch(statements);};
const midnightReview=result.ordexaReviews[0];ok(await request('/api/admin/ordexa/pay-review',{id:midnightReview.id,revision:midnightReview.revision,fingerprint:midnightReview.fingerprint,startChoice:'program',endChoice:'program',reason:'Reject concurrent schedule update'}),409);assert.ok(intercepted);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='ordexa_pay_decision'").get().n,previousAudit);
db.batch=originalBatch;result=await payroll('2026-10-24');await approve(result.ordexaReviews[0]);
intercepted=false;const snapshotCount=db.sqlite.prepare('SELECT COUNT(*) n FROM payroll_snapshots').get().n;
db.batch=async statements=>{if(!intercepted&&statements.some(s=>s.sql.includes('INSERT INTO payroll_snapshots'))){intercepted=true;db.sqlite.exec("UPDATE schedules SET end_at='2026-10-24T06:00:00.000Z' WHERE id='plan-2026-10-24'");}return originalBatch(statements);};
ok(await request('/api/admin/payroll/lock',{startDate:'2026-10-24',endDate:'2026-10-24',reason:'Reject concurrent schedule update at lock'}),409);assert.ok(intercepted);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM payroll_snapshots').get().n,snapshotCount);db.batch=originalBatch;
console.log('PASS Ordexa half-hour/program policy: every threshold/tie, midnight, program priority, 20-minute lateness/15-minute early/30-minute out warning, one notification per shift, direct reasoned choices, stale/audit rollback guards, retained start approval after new out, immutable locked pay, raw timestamps and no-plan fallback. Synthetic only.');
