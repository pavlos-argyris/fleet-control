import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyProbeAuthority,expectedPrimaryFence,verifyProbeWebAsset} from './probe-primary-policy.mjs';

const origin='https://fleet-control.pavlosargyris.workers.dev';
const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const publicKey=Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64url');
const identity={mode:'active',realm:origin,generation:crypto.randomUUID(),publicKey,publicSalt:crypto.randomBytes(32).toString('base64url'),fingerprint:await globalThis.FleetPrimaryCrypto.hash(publicKey),connected:true};
assert.deepEqual(await verifyProbeAuthority(identity,origin),{mode:'active',backend:'android',connected:true,transitional:false});
await assert.rejects(()=>verifyProbeAuthority({...identity,fingerprint:'0'.repeat(64)},origin));
await assert.rejects(()=>verifyProbeAuthority({...identity,mode:'unknown'},origin));
const fence={code:'primary_transport_required',mode:'active',generation:identity.generation};
assert.equal(expectedPrimaryFence(new Response('',{status:503}),fence,identity),true);
for(const bad of [{...fence,code:'database_failed'},{...fence,mode:'recovering'},{...fence,generation:crypto.randomUUID()}])assert.equal(expectedPrimaryFence(new Response('',{status:503}),bad,identity),false);
assert.equal(expectedPrimaryFence(undefined,fence,identity),false);
assert.equal(expectedPrimaryFence(new Response('',{status:200}),fence,identity),false);

const targetId=crypto.randomUUID(),inventoryHash='a'.repeat(64);
const signature=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode('fleet-cloud-return-v1|'+origin+'|'+identity.generation+'|'+targetId+'|'+inventoryHash))).toString('base64url');
const returned={...identity,mode:'cloud',backend:'cloud-sqlite',cloudBusiness:targetId,cloudReturn:{realm:origin,sourceGeneration:identity.generation,targetId,inventoryHash,signature}};
assert.equal((await verifyProbeAuthority(returned,origin)).backend,'cloud-sqlite');
await assert.rejects(()=>verifyProbeAuthority({...returned,cloudReturn:{...returned.cloudReturn,inventoryHash:'b'.repeat(64)}},origin),/certificate/);
assert.equal((await verifyProbeAuthority({mode:'cloud',connected:false},origin)).backend,'d1');
await assert.rejects(()=>verifyProbeAuthority({mode:'cloud',backend:'unknown'},origin),/backend/);

const bytes=Buffer.from('Ελεγμένη σελίδα Fleet'),expected={sha256:crypto.createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
let calls=0;
const verified=await verifyProbeWebAsset(new URL(origin),'portal.html',expected,async(url,options)=>{
 assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);calls++;
 return calls===1?new Response(null,{status:307,headers:{Location:'/portal'}}):new Response(bytes);
});
assert.equal(calls,2);assert.equal(verified.verified,true);assert.deepEqual(verified.redirects,[{status:307,from:'/portal.html',to:'/portal'}]);
for(const location of ['https://other.example/portal','/login','/portal?next=secret','https://name:pass@fleet-control.pavlosargyris.workers.dev/portal']){
 let requested=0;await assert.rejects(()=>verifyProbeWebAsset(new URL(origin),'portal.html',expected,async()=>{requested++;return new Response(null,{status:302,headers:{Location:location}});}),/redirect/);assert.equal(requested,1);
}
await assert.rejects(()=>verifyProbeWebAsset(new URL(origin),'portal.html',expected,async()=>new Response('different bytes')),/differs/);
await assert.rejects(()=>verifyProbeWebAsset(new URL(origin),'assets/v5.62.0/app.js',expected,async()=>new Response(null,{status:302,headers:{Location:'/portal'}})),/redirect/);
await assert.rejects(()=>verifyProbeWebAsset(new URL(origin),'portal.html',expected,async()=>new Response(null,{status:307,headers:{Location:'/portal'}})),/redirect/);
console.log('PASS read-only release probe: shipped native identity and real cloud-return signature, exact expected native fence only, pinned Web bytes and canonical same-origin HTML redirects; unrelated 503, tampering, external/login/credential/loop redirects and wrong bytes rejected.');
