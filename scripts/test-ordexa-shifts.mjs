import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {computePayBreakdown} from '../cloudflare-worker/src/workforce-core.js';
const {db,call}=createSimulation();
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const {token,user}=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Fleet night worker',username:'nightshifts',password:'SyntheticNight!2026'}}));
const event=(id,day,start,end)=>({id,day,inAt:start,outAt:end});
const day1='2026-10-19',day2='2026-10-20';
const first=event('night-a',day1,day1+'T18:00:00+03:00',day1+'T23:50:00+03:00');
const second=event('night-b',day2,day2+'T00:00:00+03:00',day2+'T02:10:00+03:00');
const send=async(day,sessions,extra=[])=>ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day,capturedAt:'2026-10-28T20:00:00Z',report:{riders:[{riderId:'17',name:'Different provider name',sessions},...extra]}}}));
await send(day1,[first]);await send(day2,[second]);
const list=async(from=day1,to=from,source='all',suffix='')=>ok(await call('/api/admin/shifts?from='+from+'&to='+to+'&source='+source+'&overlap=1'+suffix,{token}));
const rawBefore=db.sqlite.prepare('SELECT * FROM ordexa_sessions ORDER BY id').all().map(row=>({...row}));
let r=await list();assert.equal(r.shifts.length,1);assert.equal(r.shifts[0].source,'ordexa');assert.equal(r.shifts[0].employeeId,null);assert.ok(r.shifts[0].sourceNotes.some(x=>x.includes('Χωρίς αντιστοίχιση')));assert.equal(r.shifts[0].payableHours,null);
assert.equal((await list(day1,day1,'fleet')).shifts.length,0);
ok(await call('/api/admin/shifts?source=invalid',{token}),400);
ok(await call('/api/admin/shifts?source=ordexa'),401);
let rider=db.sqlite.prepare('SELECT * FROM ordexa_riders').get();
ok(await call('/api/admin/ordexa/mapping',{token,method:'POST',body:{cityId:'7',riderId:'17',employeeId:user.id,revision:rider.revision,reason:'Explicit synthetic night identity'}}));
ok(await call('/api/admin/ordexa/policy',{token,method:'POST',body:{gapMinutes:15,gapTreatment:'include',revision:0,reason:'Explicit synthetic overnight continuity'}}));
db.sqlite.exec("UPDATE pay_rules SET start_round_mode='none',end_round_mode='down',end_round_minutes=30,minimum_minutes=0,maximum_minutes=1440 WHERE id='default-general'; UPDATE system_settings SET value='ordexa' WHERE key='payroll_hours_source';");
for(const selected of [day1,day2]){
 r=await list(selected);assert.equal(r.shifts.length,1);const shift=r.shifts[0];assert.equal(shift.sourceSessionCount,2);assert.equal(shift.employeeName,'Fleet night worker');assert.equal(shift.actualClockIn,'2026-10-19T15:00:00.000Z');assert.equal(shift.actualClockOut,'2026-10-19T23:10:00.000Z');assert.equal(shift.payableClockOut,'2026-10-19T23:00:00.000Z');assert.equal(shift.payableHours,8);assert.equal(shift.payablePreview,true);
}
const payroll=async(day)=>ok(await call('/api/admin/payroll?start='+day+'&end='+day,{token}));
let pay=await payroll(day1);assert.equal(pay.blockers.length,0);assert.equal(pay.totals.payableHours,8);assert.equal(pay.employees[0].sourceRows.length,1);assert.equal(pay.employees[0].sourceRows[0].sourceSessionIds.length,2);
assert.equal((await payroll(day2)).totals.payableHours,0,'The tail must not be paid again on the next calendar date');
assert.deepEqual(db.sqlite.prepare('SELECT * FROM ordexa_sessions ORDER BY id').all().map(row=>({...row})),rawBefore,'List/payroll previews never rewrite provider timestamps or raw events');
// Separate morning/evening work remains separate under the same threshold.
await send('2026-10-21',[event('morning','2026-10-21','2026-10-21T08:00:00+03:00','2026-10-21T15:00:00+03:00'),event('evening','2026-10-21','2026-10-21T20:00:00+03:00','2026-10-22T00:00:00+03:00')]);
assert.equal((await list('2026-10-21')).shifts.length,2);
const evening=db.sqlite.prepare("SELECT * FROM ordexa_sessions WHERE source_id='evening'").get();ok(await call('/api/admin/ordexa/review',{token,method:'POST',body:{id:evening.id,revision:evening.revision,action:'ignore',reason:'Synthetic explicit exclusion'}}));
r=await list('2026-10-21');const ignored=r.shifts.find(shift=>shift.sourceSessionIds.includes(evening.id));assert.ok(ignored.sourceNotes.includes('Δεν προσμετράται'));assert.equal(ignored.payableHours,null);assert.equal((await payroll('2026-10-21')).totals.payableHours,7);
// An unresolved reconnect after midnight holds the prior day's payroll.
await send('2026-10-22',[event('open-a','2026-10-22','2026-10-22T18:00:00+03:00','2026-10-22T23:50:00+03:00')]);
await send('2026-10-23',[event('open-b','2026-10-23','2026-10-23T00:00:00+03:00',null)]);
r=await list('2026-10-23');assert.equal(r.shifts.length,1);assert.equal(r.shifts[0].sourceSessionCount,2);assert.equal(r.shifts[0].status,'active');assert.equal(r.shifts[0].actualClockOut,null);assert.equal(r.shifts[0].payableHours,null);assert.equal(r.shifts[0].actualClockIn,'2026-10-22T15:00:00.000Z');
pay=await payroll('2026-10-22');assert.ok(pay.blockers.length);ok(await call('/api/admin/payroll/lock',{token,method:'POST',body:{startDate:'2026-10-22',endDate:'2026-10-22',reason:'Must not lock incomplete night'}}),409);
// A legacy Fleet shift remains separately available and never gets replaced.
db.sqlite.prepare("INSERT INTO shifts(id,employee_id,vehicle_id,current_vehicle_id,initial_km,status,actual_clock_in,actual_clock_out,payable_minutes,base_pay_cents,final_pay_cents,created_at,updated_at) VALUES('shadow',?,'__own_vehicle__fixture','__own_vehicle__fixture',0,'completed','2026-10-19T15:00:00.000Z','2026-10-19T23:10:00.000Z',490,4900,4900,'2026-10-19','2026-10-19')").run(user.id);
assert.equal((await list(day1)).shifts.length,2);assert.equal((await list(day2,day2,'fleet')).shifts.length,1,'A date-overlap filter includes the whole prior-night Fleet shift');
const legacy=ok(await call('/api/admin/shifts?from='+day1+'&to='+day1,{token}));assert.equal(legacy.shifts.length,1);assert.equal(legacy.shifts[0].source,'fleet','Old callers keep their original Fleet-only semantics');assert.equal((await payroll(day1)).totals.payableHours,8,'Separate source rows are never added to Ordexa payroll');
ok(await call('/api/admin/payroll/lock',{token,method:'POST',body:{startDate:day1,endDate:day1,reason:'Synthetic checked overnight payroll'}}));
r=await list();const locked=r.shifts.find(x=>x.source==='ordexa');assert.equal(locked.payrollLocked,true);assert.equal(locked.payableHours,null,'Do not recalculate/display a new preview for already locked pay');assert.equal((await payroll(day1)).totals.payableHours,8);
for(const [out,expected] of [['2026-10-20T00:10:00+03:00','2026-10-19T21:00:00.000Z'],['2026-10-20T00:40:00+03:00','2026-10-19T21:30:00.000Z'],['2026-10-20T02:10:00+03:00','2026-10-19T23:00:00.000Z']]){
 const result=computePayBreakdown({actualStart:'2026-10-19T18:00:00+03:00',actualEnd:out,rule:{normalRateCents:600,startRoundMode:'none',endRoundMode:'down',endRoundMinutes:30,maximumMinutes:1440},timeZone:'Europe/Athens'});assert.equal(result.payableEnd,expected);
}
const dst=computePayBreakdown({actualStart:'2026-10-24T18:00:00+03:00',actualEnd:'2026-10-25T04:00:00+02:00',rule:{normalRateCents:600,startRoundMode:'none',endRoundMode:'none',maximumMinutes:1440},timeZone:'Europe/Athens'});assert.equal(dst.payableMinutes,660,'DST repeated hour is actual elapsed work, not an artificial midnight split');
console.log('PASS Ordexa shifts: real routes, visible unmapped/open rows, explicit source filters, full overnight groups on both dates, payroll anchored to first clock in, 00:10→00:00/00:40→00:30 rounding without raw mutation, split morning/evening work, incomplete-night lock guard, locked snapshots, Fleet coexistence and DST. Synthetic only.');
