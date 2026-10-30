import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
const {call,db,env}=createSimulation(),ok=r=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const post=(action,body)=>call('/api/server/store-billing/'+action,{method:'POST',server:true,body});
try{
 const c=ok(await post('control',{scope:'budget',protocol:2,generation:'g',generationAt:1,cityId:'1',from:'2026-10-26',to:'2026-10-26'})),ctx={scope:'budget',generation:'g',epoch:c.epoch,operationId:c.job.id,lease:c.job.lease};
 const stores=Array.from({length:32},(_,i)=>({id:'shop:'+i,sourceShopId:String(i),name:'Budget '+i,blocked:false,sourceTerms:[{effectiveDay:'',supported:true,unitPriceCents:200,dailyMinimumCents:0,chargeOnZero:false}]}));
 ok(await post('catalogue',{...ctx,stores:stores.slice(0,25),complete:false}));const end=ok(await post('catalogue',{...ctx,stores:stores.slice(25),complete:true,catalogueHash:'a'.repeat(64)}));
 let queries=0;const rawPrepare=db.prepare.bind(db),rawBatch=db.batch.bind(db);
 const wrap=s=>({raw:s,bind(...v){return wrap(s.bind(...v));},first(...v){queries++;return s.first(...v);},all(...v){queries++;return s.all(...v);},run(...v){queries++;return s.run(...v);}});
 env.DB={prepare:sql=>wrap(rawPrepare(sql)),batch:s=>{queries++;return rawBatch(s.map(x=>x.raw));}};
 const base={...ctx,protocol:2,inputRevision:end.revision,runId:'budget-32',day:'2026-10-26',count:32,changedCount:32,sourceAt:'2026-10-27T04:00:00Z'};
 const rows=stores.map(s=>({storeId:s.id,storeRevision:1,retentionUsed:false,businessDay:base.day,engineVersion:1,cutoffHour:5,timeZone:'Europe/Athens',orderCount:3,retainedOrders:0,reviewCount:0,orderChargeCents:600,minimumTopUpCents:0,totalChargeCents:600}));
 ok(await post('aggregate-stage',{...base,rows}));const stageQueries=queries;assert.ok(stageQueries<50,'full 32-store stage exceeds Free D1 invocation budget: '+stageQueries);
 queries=0;ok(await post('aggregate-publish',base));const publishQueries=queries;assert.ok(publishQueries<50,'aggregate publish exceeds Free D1 invocation budget');
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM store_billing_records WHERE id LIKE 'aggregate-day:%'").get().n,32);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM store_billing_records WHERE kind IN ('order','observation')").get().n,0);
 console.log(`PASS full 32-store aggregate page: ${stageQueries} D1 calls for stage, ${publishQueries} for atomic publication; no raw orders. Includes Worker routing; batches count once.`);
}finally{db.sqlite.close();}
