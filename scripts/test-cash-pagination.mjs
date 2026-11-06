import assert from 'node:assert/strict';
import {cashProjection} from '../server-runtime/cash.js';

// Regression: the final page is complete even when OFFSET is nonzero.
// All DB rows are synthetic; no production database or network is accessed.
function fixture(count) {
 const rows=Array.from({length:count},(_,i)=>({id:'event-'+i,business_day:'2026-11-04',created_at:'2026-11-04T12:00:00Z'}));
 return {DB:{prepare(sql){
   let args=[];
   return {
    bind(...values){args=values;return this;},
    async all(){
     if(sql.includes('GROUP BY e.courier_id'))return {results:[]};
     if(sql.includes('GROUP BY e.courier_id,e.store_id'))return {results:[]};
     if(sql.includes('LIMIT ? OFFSET ?'))return {results:rows.slice(args.at(-1),args.at(-1)+args.at(-2))};
     throw new Error('Unexpected SQL '+sql);
    },
    async first(){if(sql.includes('COUNT(*)'))return {n:count};throw new Error('Unexpected SQL '+sql);}
   };
 }}};
}
const from='2026-11-04',to='2026-11-04';
for(const [count,offset,limit,expectedLength,complete,more] of [
 [5,0,2,2,false,true],
 [5,2,2,2,false,true],
 [5,4,2,1,true,false],
 [5,5,2,0,true,false],
 [0,0,2,0,true,false]
]){
 const result=await cashProjection(fixture(count),from,to,'',{eventOffset:offset,eventLimit:limit});
 assert.equal(result.eventCount,count);
 assert.equal(result.events.length,expectedLength);
 assert.equal(result.eventsComplete,complete);
 assert.equal(result.hasMoreEvents,more);
 assert.equal(result.eventOffset,offset);
}
console.log('PASS cash pagination: first/middle/final/out-of-range/empty pages');
