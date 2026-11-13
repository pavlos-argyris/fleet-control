import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{build}=await import(pathToFileURL(require.resolve('esbuild')).href),{Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-large-release-'));let mf;
try{
  fs.writeFileSync(path.join(dir,'entry.js'),`import {routeReleases} from ${JSON.stringify(path.resolve('cloudflare-worker/src/releases.js'))};
export default{async fetch(request,env){const path=new URL(request.url).pathname;if(path.startsWith('/inspect/')){const o=await env.RELEASES.head(path.slice(9));return Response.json(o?{size:o.size,sha:o.customMetadata.sha256}:null);}return await routeReleases(request,{...env,RELEASE_TOKEN:'fixture-publisher'},{json:(v,s=200)=>Response.json(v,{status:s}),secureEqual:async(a,b)=>a===b,digestHex:async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join(''),serverAuthorized:async()=>false,invalidateWeb(){}})||new Response('missing',{status:404});}};`);
  await build({entryPoints:[path.join(dir,'entry.js')],outfile:path.join(dir,'worker.js'),bundle:true,format:'esm',platform:'browser'});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.js'),'utf8'),compatibilityDate:'2026-10-01',r2Buckets:['RELEASES']}));
  const bytes=new Uint8Array(55*1024*1024).fill(7),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const send=(release,hash)=>mf.dispatchFetch('https://fixture/api/deploy/releases/'+release+'/server.apk',{method:'PUT',headers:{Authorization:'Bearer fixture-publisher','Content-Length':String(bytes.length),'X-Fleet-Content-SHA256':hash},body:bytes});
  const saved=await send('large-valid',sha);assert.equal(saved.status,200,await saved.clone().text());assert.deepEqual(await saved.json(),{uploaded:true,sha256:sha,sizeBytes:bytes.length});
  assert.deepEqual(await(await mf.dispatchFetch('https://fixture/inspect/ota/large-valid/server.apk')).json(),{size:bytes.length,sha});
  const conflict=await send('large-valid','0'.repeat(64));assert.equal(conflict.status,409,'existing immutable APK is preserved');
  const repeated=await send('large-valid',sha);assert.equal(repeated.status,200,'a complete repeated upload returns a stable idempotent acknowledgement');
  const invalid=await send('large-corrupt','0'.repeat(64));assert.equal(invalid.status,400,'R2 checks the actual body digest');
  assert.equal(await(await mf.dispatchFetch('https://fixture/inspect/ota/large-corrupt/server.apk')).json(),null,'failed checksum never publishes an object');
  console.log('PASS actual Workerd/R2 large release: 55MiB stream, exact native R2 SHA-256 verification, immutable conflict and no object after corruption. No Cloudflare account or production data.');
}finally{if(mf)await mf.dispose();fs.rmSync(dir,{recursive:true,force:true});}
