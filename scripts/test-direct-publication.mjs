import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import worker,{DIRECT_ORIGIN} from '../cloudflare-worker/src/redirect.js';
import {verifyDirectPublication,verifyRedirect} from './verify-direct-publication.mjs';
const dist=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-direct-publication-')),origin='https://fleet-control.pavlosargyris.workers.dev',commit='1'.repeat(40);
const manifest={releaseId:'v5.67.0-'+commit.slice(0,12),sourceCommit:commit,publication:{mode:'direct-github',directOrigin:DIRECT_ORIGIN}};
let sums='';const payloads=new Map();
for(const[kind,version]of [['client','5.67.0'],['server','2.16.0'],['source','5.67.0']]){
 const name='Fleet_Control_'+kind[0].toUpperCase()+kind.slice(1)+'_v'+version+(kind==='source'?'.zip':'.apk'),bytes=Buffer.from('synthetic-'+kind),sha256=crypto.createHash('sha256').update(bytes).digest('hex');payloads.set(name,bytes);fs.writeFileSync(path.join(dist,name),bytes);sums+=sha256+'  '+name+'\n';if(kind!=='source')manifest[kind]={file:name,sizeBytes:bytes.length,sha256};
}
fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),sums);
let corrupt=false,wrongManifest=false;const seen=[];
const fetcher=async(url,options={})=>{
 seen.push(String(url));assert.equal(options.headers,undefined,'public checks transmit no Fleet/Ordexa credential');
 if(String(url).startsWith(origin))return worker.fetch(new Request(url,options));
 const name=String(url).split('/').at(-1);if(name==='release-manifest.json')return new Response(JSON.stringify(wrongManifest?{...manifest,notes:'changed'}:manifest));if(name==='SHA256SUMS.txt')return new Response(sums);
 const value=payloads.get(name);assert.ok(value,'only pinned public artifacts are fetched');return new Response(corrupt?Buffer.from('corrupt'):value);
};
try{
 const result=await verifyDirectPublication({manifest,workerOrigin:origin,dist,fetcher});assert.equal(result.complete,true);assert.equal(result.files.length,3);assert.equal(result.downloadsVerified,true);assert.equal(result.androidInstallationVerified,false);assert.equal(result.cloudBusinessActivation,false);
 assert.ok(!seen.some(url=>url.startsWith(DIRECT_ORIGIN)),'publication probe does not read/write the production Android database');
 wrongManifest=true;await assert.rejects(verifyDirectPublication({manifest,workerOrigin:origin,dist,fetcher}),/manifest differs/);wrongManifest=false;
 corrupt=true;await assert.rejects(verifyDirectPublication({manifest,workerOrigin:origin,dist,fetcher}),/bytes differ/);corrupt=false;
 await assert.rejects(verifyDirectPublication({manifest:{...manifest,sourceCommit:'2'.repeat(40)},workerOrigin:origin,dist,fetcher}),/pinned Direct/);
 await assert.rejects(verifyRedirect(origin,async()=>new Response(null,{status:307,headers:{Location:DIRECT_ORIGIN+'/api/private'}})),/verification failed/);
 console.log('PASS Direct public release verification: pinned manifest, exact signed-file/source bytes, corrupt/mismatched rejection, redirect/write policies and truthful installation status without production business access');
}finally{fs.rmSync(dist,{recursive:true,force:true});}
