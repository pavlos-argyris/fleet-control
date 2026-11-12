// Match production's in-gate error boundary: throwing out of blockConcurrencyWhile resets the entire actor and can abort the other successful concurrent request.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {build}=await import(pathToFileURL(require.resolve('esbuild')).href);
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-cloud-db-'));let mf;
try{
 fs.writeFileSync(path.join(temp,'entry.mjs'),`import {cloudBusinessDatabase,cloudBusinessTransaction} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-business-db.js'))};
 export class BusinessFixture{
 constructor(ctx){this.ctx=ctx;this.db=cloudBusinessDatabase(ctx.storage);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS money(id TEXT PRIMARY KEY,amount INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY);');}
 async fetch(request){return this.ctx.blockConcurrencyWhile(async()=>{try{let b=await request.json();if(b.kind==='read')return Response.json({...await this.db.prepare('SELECT * FROM money ORDER BY id').all(),audit:(await this.db.prepare('SELECT id FROM audit ORDER BY id').all()).results,receipts:(await this.db.prepare('SELECT id FROM receipts ORDER BY id').all()).results});return await cloudBusinessTransaction(this.ctx.storage,async()=>{
  await this.db.prepare('INSERT INTO money VALUES(?,?)').bind(b.id,b.amount).run();await Promise.resolve();
  await this.db.batch([this.db.prepare('INSERT INTO audit VALUES(?)').bind(b.id),this.db.prepare('INSERT INTO receipts VALUES(?)').bind(b.id)]);
  if(b.kind==='throw')throw Error('synthetic-rollback');return Response.json({saved:true},{status:b.kind==='fail'?500:200});
 });}catch{return Response.json({failed:true},{status:500});}});}}
 export default{async fetch(request,env){try{return await env.BUSINESS.get(env.BUSINESS.idFromName('fixture')).fetch(request);}catch{return Response.json({failed:true},{status:500});}}};`);
 await build({entryPoints:[path.join(temp,'entry.mjs')],outfile:path.join(temp,'worker.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',durableObjects:{BUSINESS:{className:'BusinessFixture',useSQLite:true}}}));
 const call=body=>mf.dispatchFetch('https://fixture/api/test',{method:'POST',body:JSON.stringify(body)});
 assert.equal((await call({id:'one',amount:250})).status,200);
 assert.equal((await call({id:'two',amount:300,kind:'fail'})).status,500);
 assert.equal((await call({id:'three',amount:300,kind:'throw'})).status,500);
 const read=await(await call({kind:'read'})).json();assert.deepEqual(read.results,[{id:'one',amount:250}]);assert.deepEqual(read.audit,[{id:'one'}]);assert.deepEqual(read.receipts,[{id:'one'}]);
 const concurrent=await Promise.all([call({id:'race',amount:250}),call({id:'race',amount:300})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,500]);
 const after=await(await call({kind:'read'})).json();assert.equal(after.results.length,2);assert.deepEqual(after.audit,after.results.map(({id})=>({id})));assert.deepEqual(after.receipts,after.audit);
 console.log('PASS actual Workerd/Cloudflare SQLite: D1-shaped bound DB, complete asynchronous business+audit+receipt transaction,5xx and thrown failure rollback, concurrent unique-write serialization. Synthetic data only.');
}finally{if(mf)await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
