import assert from 'node:assert/strict';
import {reviewPayrollAttendance} from '../cloudflare-worker/src/payroll-review-core.js';
const sh=(id,employeeId,startedAt,endedAt)=>({id,employeeId,startedAt,endedAt});
const base=sh('s1','c1','2026-11-04T19:00:00+02:00','2026-11-05T02:00:00+02:00');
const schedule=[{day:'2026-11-04',employeeId:'c1'}];
let v=reviewPayrollAttendance({shifts:[base],schedule,now:'2026-11-05T09:00:00+02:00'});assert.equal(v.alerts.length,0);assert.equal(v.changesApplied,0);
v=reviewPayrollAttendance({shifts:[{...base,endedAt:'2026-11-05T02:10:00+02:00'}],schedule,now:'2026-11-05T09:00:00+02:00'});assert(v.alerts.some(a=>a.type==='clock-out-after-close'));
v=reviewPayrollAttendance({shifts:[],schedule,now:'2026-11-05T09:00:00+02:00'});assert(v.alerts.some(a=>a.type==='missing-clock-in'));
v=reviewPayrollAttendance({shifts:[{...base,endedAt:null}],schedule,now:'2026-11-06T10:00:00+02:00'});assert(v.alerts.some(a=>a.type==='open-clock-out'));
v=reviewPayrollAttendance({shifts:[base,{...base,id:'s2',startedAt:'2026-11-04T20:00:00+02:00'}],schedule,now:'2026-11-05T09:00:00+02:00'});assert(v.alerts.some(a=>a.type==='overlap'));assert(v.alerts.some(a=>a.type==='multiple-clock-pairs'));
const active=Array.from({length:4},(_,i)=>sh('n'+i,'c'+i,'2026-11-04T23:30:00+02:00','2026-11-05T01:30:00+02:00'));
v=reviewPayrollAttendance({shifts:active,schedule:active.map(x=>({day:'2026-11-04',employeeId:x.employeeId})),now:'2026-11-05T10:00:00+02:00'});assert(v.alerts.some(a=>a.type==='night-capacity-00'));assert(v.alerts.some(a=>a.type==='night-capacity-01'));assert(v.alerts.every(a=>a.day==='2026-11-04'));

// Exact interval capacity: five-minute sampling misses all four simultaneous
// people when each short shift starts in a different minute.
const night=(id,employeeId,start,end)=>sh(id,employeeId,'2026-11-05T'+start+'+02:00','2026-11-05T'+end+'+02:00');
const nightReview=shifts=>reviewPayrollAttendance({shifts,schedule:shifts.map(s=>({day:'2026-11-04',employeeId:s.employeeId})),now:'2026-11-05T09:00:00+02:00'});
const nightWarnings=shifts=>nightReview(shifts).alerts.filter(a=>a.type.startsWith('night-capacity-'));
const staggered00=['00:00:30','00:01:30','00:02:30','00:03:00'].map((start,i)=>night('short00-'+i,'person-'+i,start,'00:03:30'));
let warnings=nightWarnings(staggered00);
assert.equal(warnings.length,1);assert.equal(warnings[0].type,'night-capacity-00');assert.equal(warnings[0].actualCount,4);assert.equal(warnings[0].day,'2026-11-04');
const staggered01=['01:00:00','01:01:00','01:03:00'].map((start,i)=>night('short01-'+i,'person-'+i,start,'01:03:30'));
warnings=nightWarnings(staggered01);
assert.equal(warnings.length,1);assert.equal(warnings[0].type,'night-capacity-01');assert.equal(warnings[0].actualCount,3);
// Back-to-back seconds inside one minute must not cause a false warning.
const sequential=['00:00:00','00:00:10','00:00:20','00:00:30'].map((start,i)=>night('sequential-'+i,'person-'+i,start,['00:00:10','00:00:20','00:00:30','00:00:40'][i]));
assert.equal(nightWarnings(sequential).length,0);
// Overlapping sessions of the SAME employee count as one person.
assert.equal(nightWarnings([night('dup1','same','00:00:00','00:20:00'),night('dup2','same','00:05:00','00:10:00'),night('other1','b','00:05:00','00:10:00'),night('other2','c','00:05:00','00:10:00')]).length,0);
// A shift ending exactly at 01:00 never contributes to the 01:00-02:00 slot.
assert.equal(nightWarnings([night('boundary1','a','00:58:00','01:00:00'),night('boundary2','b','00:58:00','01:00:00'),night('boundary3','c','01:00:00','01:05:00'),night('boundary4','d','01:00:00','01:05:00')]).length,0);
// Greece DST changes after 02:00: preserve the business-day attribution.
const dst=['00:00:30','00:01:30','00:02:30','00:03:00'].map((start,i)=>sh('dst-'+i,'person-'+i,'2026-10-25T'+start+'+03:00','2026-10-25T00:03:30+03:00'));
v=reviewPayrollAttendance({shifts:dst,schedule:dst.map(s=>({day:'2026-10-24',employeeId:s.employeeId})),now:'2026-10-25T09:00:00+02:00'});
assert(v.alerts.some(a=>a.type==='night-capacity-00'&&a.day==='2026-10-24'&&a.actualCount===4));

console.log('PASS payroll warnings: missed in/out, overlapping multi-shifts, 02:00 closure, 3/2 night caps, no edits.');
