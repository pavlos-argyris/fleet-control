import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {build}=await import(pathToFileURL(require.resolve('esbuild')).href);
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-cloud-runtime-'));let mf;
try{
 fs.writeFileSync(path.join(temp,'entry.mjs'),`import {CloudBusiness} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-business.js'))};
 export class BusinessFixture extends CloudBusiness{
 constructor(ctx,env){super(ctx,env,async command=>{if(command==='health.snapshot')return{at:new Date().toISOString()};throw Error('fixture unsupported host service');});this.start=ctx.blockConcurrencyWhile(async()=>{
 await ctx.storage.put('cloud-business.configuration',{active:true,authPepper:'cloud-fixture-private-pepper',eventSigningKey:'cloud-fixture-event-key-at-least-32',context:{configured:true,scope:'fixture-source',generation:'fixture-generation'}});
 ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS store_billing_local(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT '',day TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 0)");});}
 async fetch(request){await this.start;if(new URL(request.url).pathname==='/fixture/seed'){
 this.ctx.storage.sql.exec("INSERT INTO store_billing_records(id,kind,scope,store_id,day,data,updated_at) VALUES('shop','store','fixture-source','','','{\\"name\\":\\"Συνθετικό\\"}','2026-11-08T12:00:00Z')");return Response.json({ok:true});}return super.fetch(request);}}
 export default{async fetch(request,env){try{return await env.BUSINESS.get(env.BUSINESS.idFromName('fixture')).fetch(request);}catch(error){return Response.json({error:String(error.message)},{status:500});}}};`);
 await build({entryPoints:[path.join(temp,'entry.mjs')],outfile:path.join(temp,'worker.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',durableObjects:{BUSINESS:{className:'BusinessFixture',useSQLite:true}},r2Buckets:['SERVICE_DOCS','RELEASES'],bindings:{SERVER_KEY:'cloud-fixture-server-key-at-least-32'}}));
 let token='';const call=async(url,body,headers={})=>{const r=await mf.dispatchFetch('https://fixture'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});const data=await r.json();return{status:r.status,data};};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 ok(await call('/api/auth/bootstrap',{username:'owner',password:'Synthetic-2026-Cloud!',fullName:'Συνθετικός ιδιοκτήτης'},{'X-Fleet-Server-Key':'cloud-fixture-server-key-at-least-32'}));
 const login=ok(await call('/api/auth/user-login',{username:'owner',password:'Synthetic-2026-Cloud!'}));token=login.token;assert(token);
 ok(await call('/api/auth/me'));ok(await call('/fixture/seed'));
 const rule=ok(await call('/api/native/cash/rules',{storeId:'shop',category:'Α',effectiveDay:'2026-11-08',rateCents:250,expectedRevision:0},{'X-Fleet-Operation':crypto.randomUUID()}),201).rule;
 assert.equal(rule.rateCents,250);
 const rules=ok(await call('/api/native/cash/rules'));assert.equal(rules.rules.length,1);
 const report=ok(await call('/api/native/cash?from=2026-11-08&to=2026-11-08'));assert.equal(report.sync.sourceScope,'fixture-source');
 const health=ok(await call('/api/native/health'));assert.equal(health.d1.status,'unknown');
 const repeated=ok(await call('/api/native/cash/rules',{storeId:'shop',category:'Α',effectiveDay:'2026-11-08',rateCents:300,expectedRevision:0},{'X-Fleet-Operation':crypto.randomUUID()}),409);assert.equal(repeated.code,'rule_conflict');
 console.log('PASS actual Workerd shared cloud business runtime: own SQLite/core schema, PBKDF2 login/current user, request-scoped source, cash rule/CAS and health, no D1 binding or Android host. Migration/routing not activated.');
}finally{if(mf)await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
