import assert from 'node:assert/strict';
import {computePayBreakdown,zonedLocalToUtc} from '../cloudflare-worker/src/workforce-core.js';
import {computePayBreakdown as minuteReference} from './fixtures/payroll-minute-reference.mjs';
const windows=[{id:'night10',startTime:'00:00',endTime:'01:00',rateCents:1000,qualified:true,priority:20},{id:'night15',startTime:'01:00',endTime:'02:00',rateCents:1500,qualified:true,priority:20},{id:'late',startTime:'22:00',endTime:'04:00',rateCents:800,qualified:true,priority:1}];
let count=0;
for(const date of ['2026-02-28','2026-03-28','2026-03-29','2026-10-24','2026-10-25','2026-12-31'])for(const time of ['00:00','01:30','02:41','20:17'])for(const minutes of [47.25,191,735.75]){
 const start=Date.parse(zonedLocalToUtc(date,time)),end=start+minutes*60000;
 const input={actualStart:new Date(start).toISOString(),actualEnd:new Date(end).toISOString(),scheduledStart:new Date(start-4*60000).toISOString(),rule:{normalRateCents:600,startRoundMode:'up',startRoundMinutes:30,lateGraceMinutes:5,endRoundMode:'none',minimumMinutes:0,maximumMinutes:1440},specialWindows:windows,timeZone:'Europe/Athens',overtimeStart:new Date(start+120.5*60000).toISOString(),overtimeRateCents:count%2?1200:null};
 assert.deepEqual(computePayBreakdown(input),minuteReference(input),date+' '+time+' '+minutes);count++;
}
const base={actualStart:'2026-10-20T08:11:11.111Z',actualEnd:'2026-10-20T15:13:13.333Z',rule:{normalRateCents:600,minimumMinutes:480,maximumMinutes:600},specialWindows:[],timeZone:'Europe/Athens'};
assert.deepEqual(computePayBreakdown(base),minuteReference(base));
console.log('PASS optimized payroll equals published minute-by-minute calculations in '+(count+1)+' cases, including fractional minutes, minimum pay, rate priorities, overtime and both daylight-saving changes.');
