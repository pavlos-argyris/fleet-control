import assert from 'node:assert/strict';
import {beginSharedReads,finishSharedReads,sharedStoreRead} from '../server-runtime/shared-reads.js';
let revision=1,computed=0,amount=100,enabled=true;
const env={STANDALONE:true,DB:{prepare(){return{async all(){return{results:[{scope:'stores',revision}]};}};}}};
const params={scope:'fixture',from:'2026-10-01',to:'2026-10-31',period:'month',storeId:''};
const calculate=async()=>({amount,nested:{computed:++computed}});
const read=()=>sharedStoreRead(env,params,calculate);
beginSharedReads();assert.equal((await read()).amount,100);finishSharedReads(true);
beginSharedReads();const hit=await read();hit.nested.computed=99;assert.equal((await read()).nested.computed,1);finishSharedReads(true);assert.equal(computed,1,'immutable shared computation survives separate requests');
revision=2;amount=200;beginSharedReads();assert.equal((await read()).amount,200);finishSharedReads(false);
revision=2;amount=300;beginSharedReads();assert.equal((await read()).amount,300);finishSharedReads(true);assert.equal(computed,3,'rolled-back revision cannot poison a later commit');
revision=3;amount=400;beginSharedReads();await read(); // Simulate failed/abandoned native request.
beginSharedReads();amount=500;assert.equal((await read()).amount,500);finishSharedReads(true);assert.equal(computed,5,'new request drops abandoned staging');
let release;revision=4;beginSharedReads();const old=sharedStoreRead(env,params,async()=>{await new Promise(r=>release=r);return{amount:600};});await Promise.resolve();await Promise.resolve();beginSharedReads();release();await old;finishSharedReads(true);amount=700;beginSharedReads();assert.equal((await read()).amount,700);finishSharedReads(true);
revision=5;beginSharedReads();await sharedStoreRead({...env,STANDALONE:false},params,calculate);finishSharedReads(true);amount=800;beginSharedReads();assert.equal((await read()).amount,800);finishSharedReads(true);
console.log('PASS committed role-independent store computations: immutable copies, rollback revision reuse, abandoned request/epoch fencing and dormant cloud cache');
