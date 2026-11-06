import assert from 'node:assert/strict';
import {projectCourierCash} from '../cloudflare-worker/src/courier-cash-core.js';
const day='2026-11-04',tariffs=[{storeId:'pizza-hot',category:'A',effectiveDay:'2026-01-01',amountCents:200}];
const order=i=>({id:'o'+i,day,courierId:'c1',storeId:'pizza-hot',category:'A',status:'delivered'});
let r=projectCourierCash({day,orders:Array.from({length:15},(_,i)=>order(i)),tariffs});
assert.equal(r.complete,true);assert.equal(r.couriers[0].orders,15);assert.equal(r.couriers[0].dueCents,3000);assert.equal(r.couriers[0].differenceCents,3000);
r=projectCourierCash({day,orders:[order(1),order(1),{...order(2),status:'cancelled'}],tariffs,receipts:[{id:'r1',day,courierId:'c1',kind:'received',amountCents:200},{id:'r1',day,courierId:'c1',kind:'received',amountCents:200}]});
assert.equal(r.couriers[0].dueCents,200);assert.equal(r.couriers[0].receivedCents,200);assert.equal(r.couriers[0].differenceCents,0);
assert.throws(()=>projectCourierCash({day,orders:[order(1),{...order(1),courierId:'c2'}],tariffs}),/Conflicting order/);
r=projectCourierCash({day,orders:[{...order(1),courierId:''}],tariffs});assert.equal(r.complete,false);assert.equal(r.issues[0].type,'missing-courier');
r=projectCourierCash({day,orders:[order(1)],tariffs:[]});assert.equal(r.couriers[0].dueCents,null);assert.equal(r.issues[0].type,'missing-tariff');
r=projectCourierCash({day,orders:[order(1)],tariffs:[...tariffs,{...tariffs[0],effectiveDay:'2026-11-04',amountCents:250}]});assert.equal(r.couriers[0].dueCents,250);
r=projectCourierCash({day,orders:[],tariffs,receipts:[]});assert.equal(r.couriers.length,0);assert.equal(r.complete,true);
r=projectCourierCash({day,orders:[order(1)],tariffs,receipts:[{id:'r1',day,courierId:'c1',kind:'received',amountCents:300},{id:'r2',day,courierId:'c1',kind:'reversal',amountCents:100}]});assert.equal(r.couriers[0].receivedCents,200);
assert.throws(()=>projectCourierCash({day,orders:[order(1)],tariffs:[tariffs[0],{...tariffs[0],amountCents:300}]}),/Ambiguous tariff/);
// Only explicitly selected stores contribute; 2.50€/3.00€ rates are
// effective-dated, while unrelated deliveries never become missing-tariff debt.
const selectedOrders=[
 {...order(101),storeId:'store-250',category:'A'},
 {...order(102),storeId:'store-250',category:'A'},
 {...order(103),storeId:'store-300',category:'B'},
 {...order(104),storeId:'not-participating',courierId:'',category:''},
 {...order(105),storeId:'not-participating',category:'A'}
];
const selectedTariffs=[
 {storeId:'store-250',category:'A',effectiveDay:'2026-01-01',amountCents:250},
 {storeId:'store-300',category:'B',effectiveDay:'2026-01-01',amountCents:300}
];
r=projectCourierCash({day,orders:selectedOrders,tariffs:selectedTariffs,participatingStoreIds:['store-250','store-300']});
assert.equal(r.complete,true);assert.equal(r.issues.length,0);assert.equal(r.excludedOrders,2);
assert.equal(r.couriers[0].orders,3);assert.equal(r.couriers[0].dueCents,800);
assert.deepEqual(r.couriers[0].breakdown.map(x=>x.dueCents),[500,300]);
r=projectCourierCash({day,orders:selectedOrders,tariffs:selectedTariffs,participatingStoreIds:[]});
assert.equal(r.complete,true);assert.equal(r.couriers.length,0);assert.equal(r.excludedOrders,5);
r=projectCourierCash({day,orders:selectedOrders,tariffs:selectedTariffs.slice(0,1),participatingStoreIds:['store-250','store-300']});
assert.equal(r.complete,false);assert.equal(r.issues[0].type,'missing-tariff');
assert.throws(()=>projectCourierCash({day,participatingStoreIds:'all'}),/participatingStoreIds/);
assert.throws(()=>projectCourierCash({day,participatingStoreIds:['']}),/participating store/);
console.log('PASS cash core: 0/1/15 orders, effective tariffs, idempotency, reversals, missing IDs, cancellation; no wage mutation.');

// Exercise the native cash ledger's paginated report alongside the projection.
await import('./test-cash-pagination.mjs');
