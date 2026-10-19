import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('scripts/publish-release.mjs','utf8'),body=source.match(/^async function uploadFiles\([^]*?^\}/m)?.[0];assert.ok(body);
const files=['client.apk','server.apk',...Array.from({length:12},(_,i)=>'web/file-'+i+'.js')].map((remote,i)=>({remote,local:remote,sha256:'hash-'+i,sizeBytes:i+1}));
const sandbox={manifest:{releaseId:'fixture'},fs:{readFileSync:p=>p},console};vm.createContext(sandbox);vm.runInContext(body+'\nglobalThis.upload=uploadFiles;',sandbox);
let active=0,peak=0,apkActive=0,finished=0,fail=false;const calls=[],progress=[];
async function request(path,method,bytes){const file=files.find(f=>path.endsWith('/'+f.remote));assert.ok(file);assert.equal(method,'PUT');assert.equal(bytes,file.local);calls.push(file.remote);active++;peak=Math.max(peak,active);const apk=!file.remote.startsWith('web/');if(apk){apkActive++;assert.equal(active,1);}else assert.equal(apkActive,0);try{await new Promise(r=>setImmediate(r));if(fail&&file.remote==='web/file-0.js')throw new Error('Transport fixture failure');finished++;return {sha256:file.sha256,sizeBytes:file.sizeBytes};}finally{active--;if(apk)apkActive--;}}
await sandbox.upload(files,request,s=>progress.push(s));assert.equal(finished,files.length);assert.ok(peak>1&&peak<=3);assert.deepEqual(calls.slice(0,2),['client.apk','server.apk']);assert.match(progress.at(-1),/14\/14/);
fail=true;let activated=false;calls.length=0;await assert.rejects(async()=>{await sandbox.upload(files,request,()=>{});activated=true;},/Transport fixture failure/);assert.equal(active,0,'All outstanding uploads settle before the failure is returned');assert.equal(activated,false);assert.ok(calls.length<files.length,'A failed upload stops new transfers');
await assert.rejects(()=>sandbox.upload(files,async()=>({sha256:'bad',sizeBytes:1}),()=>{}),/Upload verification failed/);
console.log('PASS actual release transport: sequential large APKs, at most three Web uploads, verified progress, hash rejection and no activation/dangling transfers after failure.');
