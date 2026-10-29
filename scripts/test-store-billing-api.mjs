import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {storeBusinessDay} from '../cloudflare-worker/src/store-billing.js';
const {call,db}=createSimulation();const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
try{
 const boot=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic stores owner',username:'storesowner',password:'SyntheticStores!1'}})),token=boot.token;
 const server=(action,body)=>call('/api/server/store-billing/'+action,{server:true,method:'POST',body}),admin=(action,body)=>call('/api/admin/store-billing/'+action,{token,method:'POST',body});
 ok(await call('/api/admin/store-billing?from=2026-10-26&to=2026-10-28'),401);
 let control=ok(await server('control',{scope:'synthetic-source',generation:'gen1',generationAt:1,cityId:'7',from:'2026-10-26',to:'2026-10-28'}));
 const ctx={scope:'synthetic-source',generation:'gen1',epoch:control.epoch,operationId:control.job.id,lease:control.job.lease};
 const catalog=Array.from({length:57},(_,i)=>({id:'store:'+i,sourceShopId:String(i),name:'Synthetic store '+i,blocked:false,sourceTerms:[{effectiveDay:'',supported:true,method:'dailyMin',origin:'ordexa-bootstrap',unitPriceCents:200,dailyMinimumCents:i%2?4000:0,chargeOnZero:false}]}));
 let revision;for(let i=0;i<catalog.length;i+=25)revision=ok(await server('catalogue',{...ctx,stores:catalog.slice(i,i+25),complete:i+25>=catalog.length,catalogueHash:'a'.repeat(64)})).revision;
 let items=[],cursor=0;for(;;){const r=ok(await call('/api/server/store-billing/inputs?'+new URLSearchParams({...ctx,cursor:String(cursor),revision:String(revision)}),{server:true}));items.push(...r.rows);cursor=r.nextCursor;if(!r.hasMore)break;}
 assert.equal(items.filter(r=>r.kind==='store').length,57);assert.equal(items.filter(r=>r.kind==='terms').length,57);assert.ok(items.filter(r=>r.kind==='store').every(r=>JSON.parse(r.data).retainOrders===false),'retention defaults OFF for every store');
 const snapshot=db.sqlite.prepare('SELECT COUNT(*) n FROM store_billing_records').get().n;
 ok(await server('catalogue',{...ctx,stores:catalog.slice(0,1),complete:true,catalogueHash:'a'.repeat(64),epoch:'old'}),409);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM store_billing_records').get().n,snapshot);
 const projection=catalog.map((s,i)=>({storeId:s.id,businessDay:'2026-10-26',orderCount:i===0?9:0,orderChargeCents:i===0?1800:0,minimumTopUpCents:0,totalChargeCents:i===0?1800:0,termsId:JSON.parse(items.find(r=>r.kind==='terms'&&r.store_id===s.id).data).id,storeRevision:1,engineVersion:1,cutoffHour:5,timeZone:'Europe/Athens',retainedOrders:0,reviewCount:0,sourceLastSuccessAt:'2026-10-27T04:00:00Z'}));
 for(let i=0;i<projection.length;i+=32)ok(await server('stage',{...ctx,runId:'run1',day:'2026-10-26',rows:projection.slice(i,i+32)}));
 ok(await server('publish',{...ctx,runId:'run1',day:'2026-10-26',count:56,sourceAt:'2026-10-27T04:00:00Z'}),409);
 ok(await server('publish',{...ctx,runId:'run1',day:'2026-10-26',count:57,sourceAt:'2026-10-27T04:00:00Z'}));
 let list=ok(await call('/api/admin/store-billing?from=2026-10-26&to=2026-10-28',{token}));assert.equal(list.rows.length,50);assert.equal(list.hasMore,true);assert.equal(list.totals.orderCount,9);assert.equal(list.totals.totalChargeCents,1800);
 const last=ok(await call('/api/admin/store-billing?'+new URLSearchParams({from:'2026-10-26',to:'2026-10-28',cursor:list.nextCursor}),{token}));assert.equal(last.rows.length,7);
 const bulk={operationId:'synthetic-bulk-1',effectiveDay:'2026-10-27',stores:[{id:'store:0',revision:1},{id:'store:1',revision:1}],patch:{unitPriceCents:250}};
 ok(await admin('bulk',bulk));assert.equal(ok(await admin('bulk',bulk)).replayed,true,'same action is idempotent');
 assert.equal(ok(await call('/api/admin/store-billing?from=2026-10-26&to=2026-10-26',{token})).rows.find(r=>r.id==='store:1').pendingDays,0,'future-effective terms do not invalidate a prior day');
 const terms=ok(await call('/api/admin/store-billing/terms?storeId=store:1',{token}));assert.equal(terms.rows.at(-1).dailyMinimumCents,4000,'price-only bulk preserves different per-store minima');assert.equal(terms.rows.at(-1).unitPriceCents,250);
 assert.equal(db.sqlite.prepare("SELECT revision FROM store_billing_records WHERE id='store:2'").get().revision,1,'unselected store untouched');
 ok(await admin('bulk',{...bulk,operationId:'synthetic-stale',patch:{unitPriceCents:300}}),409);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM store_billing_records WHERE id='synthetic-stale'").get().n,0,'atomic conflict records nothing');
 ok(await admin('bulk',{operationId:'synthetic-retention',effectiveDay:'2026-10-27',stores:[{id:'store:0',revision:2}],patch:{retainOrders:true}}));
 assert.equal(JSON.parse(db.sqlite.prepare("SELECT data FROM store_billing_records WHERE id='store:0'").get().data).retainOrders,true);
 assert.equal(JSON.parse(db.sqlite.prepare("SELECT data FROM store_billing_records WHERE id='store:1'").get().data).retainOrders,false,'retention is an explicit per-store exception');
 // Source refresh preserves both Fleet price history and chosen retention.
 ok(await server('catalogue',{...ctx,stores:[{...catalog[0],name:'Renamed source',sourceTerms:[{...catalog[0].sourceTerms[0],unitPriceCents:999}]}],complete:true,catalogueHash:'b'.repeat(64)}));
 assert.equal(JSON.parse(db.sqlite.prepare("SELECT data FROM store_billing_records WHERE id='store:0'").get().data).retainOrders,true);
 assert.equal(ok(await call('/api/admin/store-billing/terms?storeId=store:0',{token})).rows.at(-1).unitPriceCents,250,'provider terms cannot overwrite local terms');
 const added={id:'store:new',sourceShopId:'new',name:'New synthetic',blocked:false,sourceTerms:catalog[0].sourceTerms};ok(await server('catalogue',{...ctx,stores:[added],complete:true,catalogueHash:'c'.repeat(64)}));
 const newStore=JSON.parse(db.sqlite.prepare("SELECT data FROM store_billing_records WHERE id='store:new'").get().data);assert.equal(newStore.pricingState,'needs_terms');assert.equal(newStore.newStore,true);assert.equal(newStore.retainOrders,false);
 const source={id:'order:1',sourceOrderId:'1',storeId:'store:0',sourceShopId:'0',businessDay:'2026-10-26',at:'2026-10-27T02:30:00+02:00',active:true};
 ok(await server('archive',{...ctx,records:[{id:source.id,kind:'order',storeId:source.storeId,day:source.businessDay,data:source}]}));
 ok(await server('archive',{...ctx,records:[{id:source.id,kind:'order',storeId:source.storeId,day:source.businessDay,data:{...source,active:false}}]}));
 assert.equal(JSON.parse(db.sqlite.prepare("SELECT data FROM store_billing_records WHERE id='order:1'").get().data).active,false,'default deletion status can be archived without losing original identity');
 const pending=ok(await admin('sync',{from:'2026-10-26',to:'2026-10-28'}),202),same=ok(await admin('sync',{from:'2026-10-26',to:'2026-10-28'}),202);assert.equal(pending.operation.id,same.operation.id,'manual sync coalesces');
 // Old visible amounts stay readable after terms change and source becomes stale.
 list=ok(await call('/api/admin/store-billing?from=2026-10-26&to=2026-10-28',{token}));assert.equal(list.totals.totalChargeCents,1800);assert.ok(list.rows.some(r=>r.pendingDays>0));assert.ok(list.operations.every(r=>!r.lease),"viewers never receive a Server job lease");
 assert.equal(storeBusinessDay('2026-10-26T04:59:59+02:00'),'2026-10-25');assert.equal(storeBusinessDay('2026-10-26T05:00:00+02:00'),'2026-10-26');
 console.log('PASS Worker/SQLite stores:57 stores, paged inputs/results, bootstrap, explicit default-off retention, atomic partial-field price changes/replay/CAS, immutable price history, new-store alert state, staged publication and stale readable results.');
}finally{db.sqlite.close();}
