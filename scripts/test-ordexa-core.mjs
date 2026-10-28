import assert from 'node:assert/strict';
import {normalizeOrdexaReport,groupOrdexaSessions,validateOrdexaPolicy,ordexaId} from '../cloudflare-worker/src/ordexa-core.js';
import {computePayBreakdown} from '../cloudflare-worker/src/workforce-core.js';
const s=(start,end,id)=>({id,day:'2026-10-25',inAt:start,outAt:end});
const report={cityId:'city-a',day:'2026-10-25',capturedAt:'2026-10-25T23:00:00Z',report:{riders:[{riderId:17,name:'Εντελώς διαφορετικό όνομα',sessions:[s('2026-10-25T08:00:00+02:00','2026-10-25T09:00:00+02:00','one')]}]}};
const parsed=normalizeOrdexaReport(report);assert.equal(parsed.riders[0].id,ordexaId('city-a',17));assert.equal(parsed.rows[0].in_at,'2026-10-25T06:00:00.000Z');
const renamed=structuredClone(report);renamed.report.riders[0].name='Άλλο όνομα';renamed.report.riders[0].sessions[0].outAt='2026-10-25T10:00:00+02:00';assert.equal(normalizeOrdexaReport(renamed).rows[0].id,parsed.rows[0].id);
assert.throws(()=>normalizeOrdexaReport({...report,report:{riders:null}}));assert.throws(()=>normalizeOrdexaReport({...report,hasMore:true}));
for(const bad of ['2026-02-30T08:00:00Z','2026-10-25T08:00:00','08:00','2026-10-25T99:00:00Z']){const x=structuredClone(report);x.report.riders[0].sessions[0].inAt=bad;assert.throws(()=>normalizeOrdexaReport(x),bad);}
assert.throws(()=>validateOrdexaPolicy({gapMinutes:null,gapTreatment:null}));assert.throws(()=>validateOrdexaPolicy({gapMinutes:30,gapTreatment:'guess'}));
const row=(id,start,end,extra={})=>({id,employee_id:'fleet-employee',employee_name:'Fleet name',in_at:start,out_at:end,...extra});
const events=[row('a','2026-10-25T06:00:00Z','2026-10-25T07:00:00Z'),row('b','2026-10-25T07:10:00Z','2026-10-25T08:00:00Z'),row('c','2026-10-25T16:00:00Z','2026-10-25T20:00:00Z')];
let g=groupOrdexaSessions(events,{gapMinutes:15,gapTreatment:'exclude'});assert.equal(g.groups.length,2);assert.equal(g.groups[0].sessions.length,2);assert.deepEqual(g.groups[0].gaps,[['2026-10-25T07:00:00Z','2026-10-25T07:10:00Z']]);assert.deepEqual(events[0].in_at,'2026-10-25T06:00:00Z');
assert.equal(groupOrdexaSessions(events,{gapMinutes:0,gapTreatment:'exclude'}).groups.length,3);
assert.throws(()=>groupOrdexaSessions(events,{gapMinutes:15,gapTreatment:'review'}));
assert.equal(groupOrdexaSessions([row('a','2026-10-25T06:00:00Z',null)],{gapMinutes:0,gapTreatment:'exclude'}).blocked.length,1);
assert.equal(groupOrdexaSessions([row('a','2026-10-25T06:00:00Z','2026-10-25T07:00:00Z',{employee_id:null})],{gapMinutes:0,gapTreatment:'exclude'}).groups.length,0);
assert.equal(groupOrdexaSessions([row('a','2026-10-25T06:00:00Z','2026-10-25T07:00:00Z',{ignored:1,review:1})],{gapMinutes:0,gapTreatment:'exclude'}).blocked.length,1);
// DST repeated hour is actual elapsed time; no guessed local timezone.
const dst=normalizeOrdexaReport({...report,report:{riders:[{riderId:'r',name:'DST',sessions:[s('2026-10-25T03:30:00+03:00','2026-10-25T03:30:00+02:00','dst')]}]}});assert.equal((Date.parse(dst.rows[0].out_at)-Date.parse(dst.rows[0].in_at))/60000,60);
const pay={actualStart:'2026-10-25T06:01:00Z',actualEnd:'2026-10-25T08:00:00Z',rule:{normalRateCents:600,startRoundMode:'up',startRoundMinutes:30,maximumMinutes:720},timeZone:'Europe/Athens'};
assert.equal(computePayBreakdown(pay).payableMinutes,90);
assert.equal(computePayBreakdown({...pay,excludedIntervals:[['2026-10-25T07:00:00Z','2026-10-25T07:10:00Z']]}).payableMinutes,80);
assert.equal(computePayBreakdown({...pay,excludedIntervals:[['2026-10-25T07:00:00Z','2026-10-25T07:10:00Z']]}).totalPayCents,800);
assert.equal(computePayBreakdown({...pay,excludedIntervals:[['2026-10-25T07:00:00Z','2026-10-25T07:10:00Z'],['2026-10-25T07:05:00Z','2026-10-25T07:15:00Z']]}).payableMinutes,75);
console.log('PASS Ordexa core: immutable stable IDs despite different/renamed labels, strict dates/offsets/schema/completeness, DST, separate shifts, configured gaps, overlaps, pending decisions and existing payroll rounding with excluded gaps.');
