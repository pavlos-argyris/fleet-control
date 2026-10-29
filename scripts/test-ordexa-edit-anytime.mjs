import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {nativeOrdexaEngine} from './fixtures/native-ordexa-engine.mjs';
import {projectOrdexaWeek} from './fixtures/ordexa-server-project.mjs';

const {call,db}=createSimulation(),native=nativeOrdexaEngine(),week='2026-09-28';
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
try{
 const {token,user}=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic anytime owner',username:'anytime',password:'SyntheticAnytime!7'}}));
 const get=path=>call(path,{token}),post=(path,body)=>call(path,{token,method:'POST',body});
 ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day:week,capturedAt:new Date().toISOString(),report:{riders:[{riderId:'17',name:'Source owner',sessions:[{id:'morning',day:week,inAt:week+'T08:00:00+03:00',outAt:week+'T10:00:00+03:00'},{id:'night',day:week,inAt:week+'T18:00:00+03:00',outAt:'2026-09-29T00:55:00+03:00'}]}]}}}));
 const rider=db.sqlite.prepare('SELECT * FROM ordexa_riders').get();ok(await post('/api/admin/ordexa-server/employee-links',{employeeId:user.id,cityId:'7',riderId:'17',currentId:'',currentRevision:0,targetRevision:rider.revision}));
 ok(await post('/api/admin/ordexa/policy',{gapMinutes:0,gapTreatment:'include',revision:0,reason:'Explicit synthetic zero gap'}));
 for(let n=1;n<7;n++)ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day:new Date(Date.parse(week+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),capturedAt:new Date().toISOString(),report:{riders:[{riderId:'17',name:'Source owner',sessions:[]}]}}}));
 const beforeRaw=db.sqlite.prepare('SELECT id,in_at,out_at,raw_json FROM ordexa_sessions ORDER BY id').all();
 let list=ok(await get('/api/admin/ordexa-server/shifts?day='+week));assert.equal(list.shifts.length,2,'New source is visible before the first Server calculation');assert.equal(list.projection.editReadOnly,false);assert.equal(list.projection.readOnly,true);
 const night=list.shifts.find(s=>s.actualClockOut?.includes('21:55'));
 const read=async id=>ok(await get('/api/admin/ordexa-server/shift?id='+encodeURIComponent(id)));
 const decision=editor=>({weekStart:editor.projection.weekStart,id:editor.shift.id,fingerprint:editor.shift.fingerprint,revision:editor.shift.adjustmentRevision,paidStart:week+'T15:00:00.000Z',paidEnd:week+'T22:00:00.000Z',night00Mode:'auto',night01Mode:'auto',notes:'Saved while Server unavailable'});
 let editor=await read(night.id),draft=decision(editor);assert.match(draft.fingerprint,/^edit-v1:/);ok(await post('/api/admin/ordexa-server/adjustment',draft));
 editor=await read(night.id);assert.equal(editor.shift.adjustmentRevision,1);assert.equal(editor.shift.notes,draft.notes);assert.equal(editor.shift.payableClockOut,draft.paidEnd);
 ok(await post('/api/admin/ordexa-server/adjustment',{...decision(editor),paidEnd:week+'T22:30:00.000Z'}));
 editor=await read(night.id);assert.equal(editor.shift.adjustmentRevision,2,'Second save needs no Server heartbeat');
 list=ok(await get('/api/admin/ordexa-server/shifts?day='+week));let row=list.shifts.find(s=>s.id===night.id);assert.equal(row.payableClockOut,week+'T22:30:00.000Z');assert.equal(row.payableHours,null,'No Worker wage calculation is fabricated while waiting');assert.equal(row.awaitingServer,true);
 let result=await projectOrdexaWeek(call,native,week);row=result.payload.shifts.find(s=>s.id===night.id);assert.equal(row.adjustmentRevision,2);assert.equal(row.payableClockOut,week+'T22:30:00.000Z');assert.equal(row.payableHours,7.5);assert.equal(row.totalPayCents,5350);assert.equal(row.reasons.length,0,'The native engine recognizes the direct-source approval');
 db.sqlite.prepare('UPDATE ordexa_server_views SET engine_version=1,computed_at=NULL,source_synced_at=NULL').run();
 editor=await read(night.id);assert.equal(editor.projection.editReadOnly,false);assert.equal(editor.projection.readOnly,true);draft=decision(editor);
 // Unrelated imports, even for this same employee, are not edit dependencies.
 db.sqlite.prepare("UPDATE ordexa_sessions SET revision=revision+1 WHERE source_id='morning'").run();
 const concurrent=await Promise.all([post('/api/admin/ordexa-server/adjustment',draft),post('/api/admin/ordexa-server/adjustment',draft)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
 editor=await read(night.id);draft=decision(editor);const auditCount=()=>db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='ordexa_shift_adjusted'").get().n;const count=auditCount(),batch=db.batch.bind(db);let injected=false;
 db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql?.includes("'ordexa_shift_adjusted'"))){injected=true;db.sqlite.prepare("UPDATE ordexa_sessions SET revision=revision+1 WHERE source_id='night'").run();}return batch(statements);};
 ok(await post('/api/admin/ordexa-server/adjustment',draft),409);db.batch=batch;assert.equal(auditCount(),count,'A source race leaves neither an audit nor a partial adjustment');
 editor=await read(night.id);assert.equal(editor.projection.editReadOnly,false,'A changed source can be reopened immediately without a Server calculation');ok(await post('/api/admin/ordexa-server/adjustment',decision(editor)));
 // Policy/program changes do not block an explicit absolute manual interval.
 editor=await read(night.id);draft=decision(editor);db.sqlite.prepare("UPDATE system_settings SET value='{}' WHERE key='ordexa_pay_policy'").run();ok(await post('/api/admin/ordexa-server/adjustment',draft));
 editor=await read(night.id);draft=decision(editor);db.sqlite.prepare("UPDATE fleet_mirror_state SET epoch='anytime-restored'").run();ok(await post('/api/admin/ordexa-server/adjustment',draft),409);
 editor=await read(night.id);ok(await post('/api/admin/ordexa-server/adjustment',decision(editor)));
 editor=await read(night.id);ok(await post('/api/admin/ordexa-server/adjustment',{...decision(editor),paidEnd:'2026-09-29T00:00:00.000Z'}),400);
 result=await projectOrdexaWeek(call,native,week);assert.equal(result.payload.payroll.blockers.length,0);ok(await post('/api/admin/ordexa-server/lock',{startDate:week}));
 editor=await read(night.id);assert.equal(editor.shift.payrollLocked,true);ok(await post('/api/admin/ordexa-server/adjustment',decision(editor)),409);
 assert.deepEqual(db.sqlite.prepare('SELECT id,in_at,out_at,raw_json FROM ordexa_sessions ORDER BY id').all(),beforeRaw,'Only manual Fleet decisions changed; original timestamps remain intact');
 // An edit made before grouping is available must not silently expand to a
 // later merged shift. The current whole group can be approved immediately.
 const groupDay='2026-10-05',report={riders:[{riderId:'17',name:'Source owner',sessions:[{id:'pair-a',day:groupDay,inAt:groupDay+'T08:00:00+03:00',outAt:groupDay+'T10:00:00+03:00'},{id:'pair-b',day:groupDay,inAt:groupDay+'T10:05:00+03:00',outAt:groupDay+'T12:00:00+03:00'}]}]};
 ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day:groupDay,capturedAt:new Date().toISOString(),report}}));
 ok(await post('/api/admin/ordexa/policy',{gapMinutes:15,gapTreatment:'include',revision:1,reason:'Explicit synthetic grouped shift'}));
 let pairs=ok(await get('/api/admin/ordexa-server/shifts?day='+groupDay)).shifts;const secondPair=pairs.find(s=>s.actualClockIn.includes('07:05'));
 editor=await read(secondPair.id);ok(await post('/api/admin/ordexa-server/adjustment',{...decision(editor),paidStart:groupDay+'T07:00:00.000Z',paidEnd:groupDay+'T08:30:00.000Z'}));
 result=await projectOrdexaWeek(call,native,groupDay);assert.equal(result.payload.shifts.length,1);assert.match(result.payload.shifts[0].reasons.join(),/επιμέρους παρουσίας/,'A standalone correction cannot silently pay an expanded group');
 editor=await read(result.payload.shifts[0].id);assert.equal(editor.shift.sourceSessionIds.length,2);ok(await post('/api/admin/ordexa-server/adjustment',{...decision(editor),paidStart:groupDay+'T05:00:00.000Z',paidEnd:groupDay+'T09:30:00.000Z'}));
 result=await projectOrdexaWeek(call,native,groupDay);assert.equal(result.payload.shifts[0].payableHours,4.5);assert.equal(result.payload.shifts[0].reasons.length,0);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM ordexa_shift_adjustments WHERE id IN(SELECT 'ordexa:'||id FROM ordexa_sessions WHERE source_id IN ('pair-a','pair-b'))").get().n,2,'The earlier member decision remains in the retained history');
 ok(await call('/api/server/ordexa/import',{server:true,method:'POST',body:{cityId:'7',day:'2026-10-06',capturedAt:new Date().toISOString(),report:{riders:[{riderId:'17',name:'Source owner',sessions:[{id:'after-midnight',day:'2026-10-06',inAt:'2026-10-06T01:00:00+03:00',outAt:'2026-10-06T01:30:00+03:00'}]}]}}}));
 const afterMidnight=ok(await get('/api/admin/ordexa-server/shifts?day=2026-10-06')).shifts;assert.equal(afterMidnight.length,1);assert.equal(afterMidnight[0].workDate,'2026-10-06','Raw fallback dates use the business timezone, not the UTC substring');
 console.log('PASS anytime editing: no projection, missing/old Server version and timestamps, repeated saves, immediate persisted times/notes, native acceptance, same-employee unrelated changes, CAS, atomic source race, reopen without Server, restore epoch, 02:00 cap and locked snapshot protection. Synthetic only.');
}finally{native.close();}
