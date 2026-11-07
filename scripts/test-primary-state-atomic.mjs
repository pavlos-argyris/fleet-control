import assert from 'node:assert/strict';import {PrimaryAuthority} from '../cloudflare-worker/src/primary-authority.js';
class Storage{
 record={mode:'cloud'};failCommit=false;
 async get(){return structuredClone(this.record);}
 async transaction(fn){let draft=structuredClone(this.record);const result=await fn({get:async()=>structuredClone(draft),put:async(key,value)=>{draft=structuredClone(value);}});if(this.failCommit)throw Error('synthetic durable commit failure');this.record=draft;return result;}
}
const storage=new Storage();let blocks=0;const ctx={storage,getWebSockets:()=>[],blockConcurrencyWhile:async fn=>{blocks++;return fn();}},authority=new PrimaryAuthority(ctx);
const call=(path,body={})=>authority.fetch(new Request('https://internal/primary/'+path,{method:'POST',body:JSON.stringify(body)}));const state=async()=>JSON.parse(await (await call('state')).text());
const body={ticketHash:'a'.repeat(64),generation:crypto.randomUUID(),publicKey:'k'.repeat(122),publicSalt:'s'.repeat(43),recoveryHash:'r'.repeat(64),realm:'https://fixture.invalid',ownerId:'owner'};
storage.failCommit=true;await assert.rejects(call('begin',body),/synthetic durable commit failure/);assert.equal(storage.record.mode,'cloud');assert.equal((await state()).mode,'cloud','A failed storage commit must not publish uncommitted authority in memory');
storage.failCommit=false;assert.equal((await call('begin',body)).status,200);assert.equal((await call('fenced',{ticketHash:body.ticketHash})).status,200);storage.failCommit=true;
await assert.rejects(call('activate',{ticketHash:body.ticketHash,contentHash:'b'.repeat(64)}),/synthetic durable commit failure/);assert.equal(storage.record.mode,'preparing');assert.equal((await state()).mode,'preparing','Failed activation never becomes active even until a restart');
storage.failCommit=false;assert.equal((await call('activate',{ticketHash:body.ticketHash,contentHash:'b'.repeat(64)})).status,200);assert.equal((await state()).mode,'active');assert.equal(storage.record.mode,'active');assert(blocks>=5,'Durable transitions fence event handlers until transaction commit');
console.log('PASS actual authority state transaction guard: failed begin/activation never publish uncommitted memory state, successful transitions match durable storage, events are fenced through commit.');
