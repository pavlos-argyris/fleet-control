import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {nativeOrdexaEngine} from './fixtures/native-ordexa-engine.mjs';
import {projectOrdexaWeek} from './fixtures/ordexa-server-project.mjs';

const native=nativeOrdexaEngine(),{call,db}=createSimulation();
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
try{
 const {token,user}=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic daily owner',username:'dayfix',password:'SyntheticDayFix!7'}}));
 const post=(url,body,server=false)=>call(url,{token,server,method:'POST',body});
 const get=url=>call(url,{token});
 const second=ok(await post('/api/admin/employees',{fullName:'Synthetic other rider',loginEnabled:false,role:'employee'}),201).employee;
 const start='2026-09-28',end='2026-10-04';let capture=Date.now()-10000;
 const session=(id,day,a,b)=>({id,day,inAt:a,outAt:b});
 const a=[session('morning',start,start+'T08:00:00+03:00',start+'T10:00:00+03:00'),session('afternoon',start,start+'T13:00:00+03:00',start+'T15:00:00+03:00'),session('night',start,start+'T18:00:00+03:00','2026-09-29T00:55:00+03:00')];
 const b=[session('unscheduled',start,start+'T21:00:00+03:00','2026-09-29T00:55:00+03:00')];
 const send=async(day,first=a,other=b)=>ok(await post('/api/server/ordexa/import',{cityId:'7',day,capturedAt:new Date(capture++).toISOString(),report:{riders:[{riderId:'17',name:'Provider first',sessions:day===start?first:[]},{riderId:'18',name:'Provider second',sessions:day===start?other:[]}]}},true));
 for(let n=0;n<7;n++)await send(new Date(Date.parse(start+'T12:00:00Z')+n*86400000).toISOString().slice(0,10));
 for(const [riderId,employeeId] of [['17',user.id],['18',second.id]]){const r=db.sqlite.prepare('SELECT * FROM ordexa_riders WHERE rider_id=?').get(riderId);ok(await post('/api/admin/ordexa-server/employee-links',{employeeId,cityId:'7',riderId,currentId:'',currentRevision:0,targetRevision:r.revision}));}
 ok(await post('/api/admin/ordexa/policy',{gapMinutes:0,gapTreatment:'include',revision:0,reason:'Explicit synthetic zero gap'}));
 db.sqlite.prepare("INSERT INTO schedules(id,employee_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES('night-plan',?,'2026-09-28T15:00:00.000Z','2026-09-28T22:00:00.000Z','planned',?,'fixture','fixture')").run(user.id,user.id);
 const rawBefore=db.sqlite.prepare('SELECT id,in_at,out_at,raw_json FROM ordexa_sessions ORDER BY id').all();
 let result=await projectOrdexaWeek(call,native,start),rows=ok(await get('/api/admin/ordexa-server/shifts?day='+start)).shifts;
 assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.employeeId===user.id).length,3,'Separate clock pairs remain separate; the UI groups only their presentation');
 let row=rows.find(r=>r.sourceSessionIds.some(id=>id===db.sqlite.prepare("SELECT id FROM ordexa_sessions WHERE source_id='night'").get().id));
 assert.equal(row.workDate,start);assert.equal(row.actualClockOut,'2026-09-28T21:55:00.000Z');assert.equal(row.payableClockOut,'2026-09-28T22:00:00.000Z');assert.equal(row.payableHours,7);assert.equal(row.specialMinutes,60);assert.equal(row.specialPayCents,1000);
 assert.equal(result.payload.payroll.employees.find(r=>r.employeeId===user.id).payableHours,11,'The two long gaps are not paid by display grouping');
 assert.equal(result.payload.payroll.employees.find(r=>r.employeeId===user.id).finalCents,7000);assert.equal(result.payload.payroll.blockers.length,0);
 const unplanned=rows.find(r=>r.employeeId===second.id);assert.equal(unplanned.payableHours,4);assert.equal(unplanned.outOfSchedule,true);assert.match(unplanned.scheduleNotice,/Εκτός προγράμματος/);assert.equal(unplanned.totalPayCents,2400,'No program gives payable clock time; night eligibility is a separate per-shift choice');
 assert.equal(ok(await get('/api/admin/ordexa-server/shifts?day=2026-09-29')).shifts.length,0,'The overnight tail must not reappear on the next day');
 assert.deepEqual(db.sqlite.prepare('SELECT id,in_at,out_at,raw_json FROM ordexa_sessions ORDER BY id').all(),rawBefore,'Calculation does not change provider facts');
 const decision=()=>({weekStart:start,id:row.id,fingerprint:row.fingerprint,revision:row.adjustmentRevision||0,paidStart:row.payableClockIn,paidEnd:row.payableClockOut,night00Mode:'auto',night01Mode:'auto'});
 ok(await post('/api/admin/ordexa-server/adjustment',{...decision(),paidEnd:'2026-09-29T03:00:00+03:00'}),400);ok(await post('/api/admin/ordexa-server/adjustment',{...decision(),paidStart:'2026-09-28T07:00:00+03:00'}),400);
 ok(await post('/api/server/ordexa-server/publish',{...result.body,engineVersion:1},true),400);
 db.sqlite.prepare('UPDATE ordexa_server_views SET engine_version=1 WHERE week_start=?').run(start);assert.equal(ok(await get('/api/admin/ordexa-server/shifts?day='+start)).projection.readOnly,true,'Old calculations remain read-only for locking');assert.equal(ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id))).projection.editReadOnly,false);db.sqlite.prepare('UPDATE ordexa_server_views SET engine_version=3 WHERE week_start=?').run(start);
 const viewTimes=db.sqlite.prepare('SELECT computed_at,source_synced_at FROM ordexa_server_views WHERE week_start=?').get(start);
 const age=minutes=>db.sqlite.prepare('UPDATE ordexa_server_views SET computed_at=?,source_synced_at=? WHERE week_start=?').run(new Date(Date.now()-minutes*60000).toISOString(),new Date(Date.now()-minutes*60000).toISOString(),start);
 age(4);assert.equal(ok(await get('/api/admin/ordexa-server/shifts?day='+start)).projection.fresh,true,'A normal five-minute cycle must not become stale after three minutes');
 age(12);assert.equal(ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id))).projection.editReadOnly,false,'Historical shifts remain editable when the Server result is old');
 db.sqlite.prepare('UPDATE ordexa_server_views SET computed_at=?,source_synced_at=? WHERE week_start=?').run(viewTimes.computed_at,viewTimes.source_synced_at,start);
 // New source for another person makes the global projection stale, while the
 // first person's context and open editor are still valid.
 b[0].outAt='2026-09-29T01:10:00+03:00';await send(start);
 let editor=ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id)));
 assert.equal(editor.projection.readOnly,true);assert.equal(editor.projection.editReadOnly,false,'Unrelated source changes must not prevent editing this employee');
 const concurrent=await Promise.all([post('/api/admin/ordexa-server/adjustment',decision()),post('/api/admin/ordexa-server/adjustment',decision())]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='ordexa_shift_adjusted'").get().n,1);
 result=await projectOrdexaWeek(call,native,start);row=result.payload.shifts.find(r=>r.id===row.id);
 // A same-person source change is checked in SQL again at the actual write.
 const batch=db.batch.bind(db);let injected=false;
 db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql?.includes("'ordexa_shift_adjusted'"))){injected=true;db.sqlite.prepare("UPDATE ordexa_sessions SET revision=revision+1 WHERE source_id='morning'").run();}return batch(statements);};
 ok(await post('/api/admin/ordexa-server/adjustment',decision()),409);db.batch=batch;assert.equal(injected,true);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='ordexa_shift_adjusted'").get().n,1,'A race leaves no audit or partial correction');
 editor=ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id)));assert.equal(editor.projection.editReadOnly,false,'The source editor reopens immediately after a source change');
 db.sqlite.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'").run();result=await projectOrdexaWeek(call,native,start);row=result.payload.shifts.find(r=>r.id===row.id);
 db.sqlite.prepare("INSERT INTO schedules(id,employee_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES('new-candidate',?,'2026-09-28T14:00:00.000Z','2026-09-28T15:00:00.000Z','planned',?,'fixture','fixture')").run(user.id,user.id);
 ok(await post('/api/admin/ordexa-server/adjustment',decision()),409);assert.equal(ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id))).projection.editReadOnly,false,'New schedules do not block an explicit source editor');
 db.sqlite.prepare("DELETE FROM schedules WHERE id='new-candidate'").run();result=await projectOrdexaWeek(call,native,start);row=result.payload.shifts.find(r=>r.id===row.id);
 const changedSource=db.sqlite.prepare("SELECT * FROM ordexa_sessions WHERE source_id='unscheduled'").get();assert.equal(changedSource.review,1,'The other employee real provider correction still needs its own review');
 ok(await post('/api/admin/ordexa/review',{id:changedSource.id,revision:changedSource.revision,action:'accept',reason:'Synthetic explicit confirmation of corrected provider out'}));result=await projectOrdexaWeek(call,native,start);row=result.payload.shifts.find(r=>r.id===row.id);
 // A newer adjacent-week projection contains source context from Sunday. The
 // editor must still use the owning Monday-Sunday week, not latest computed_at.
 await projectOrdexaWeek(call,native,'2026-09-21');assert.equal(ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(row.id))).projection.weekStart,start);
 ok(await post('/api/admin/ordexa-server/lock',{startDate:start,reason:'Synthetic checked daily pay'}));
 ok(await post('/api/admin/ordexa-server/adjustment',decision()),409);const frozen=ok(await get('/api/admin/ordexa-server/payroll?week='+start));assert.equal(frozen.lockedSnapshot,true);
 assert.equal(frozen.employees.find(r=>r.employeeId===user.id).finalCents,7000);
 // Sunday-night pay and premium stay with Sunday in its owning week.
 const source=result.input,night={...source.sessions[0],id:'synthetic-sunday',in_at:'2026-10-04T18:00:00+03:00',out_at:'2026-10-05T00:55:00+03:00'};
 const input={...source,sessions:[night],adjustments:[],legacyDecisions:[],paid:[],coverage:undefined,schedules:[{id:'sun-plan',employee_id:user.id,start_at:'2026-10-04T18:00:00+03:00',end_at:'2026-10-05T01:00:00+03:00',status:'planned'}]};
 let projected=native.build(input,'2026-10-29T12:00:00Z');assert.equal(projected.shifts[0].workDate,end);assert.equal(projected.payroll.totals.finalCents,4600);assert.equal(projected.shifts[0].specialMinutes,60);
 projected=native.build({...input,weekStart:'2026-10-05'},'2026-10-29T12:00:00Z');assert.equal(projected.payroll.totals.finalCents,0,'The next week never pays the Sunday-night tail twice');
 console.log('PASS #40 actual native/Worker flow: 28/09→29/09 00:55 pays 01:00, premium anchored to start, separate clock pairs and unpaid gaps, unscheduled payable advisory, unrelated-source editor acceptance, concurrent CAS/one audit, atomic source/candidate races, owning week lookup, frozen totals and Sunday/Monday attribution. Synthetic only.');
}finally{native.close();}
