// Manual local measurement using synthetic data only; never contacts Cloudflare production.
// Fixed fixture SQL statements are executed separately so each cursor contributes its rowsWritten.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));const {build}=await import(pathToFileURL(require.resolve('esbuild')).href),{Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-write-cost-'));let mf;
try{
 const entry=path.join(temp,'entry.mjs');
 fs.writeFileSync(entry,`
import {routeCloudBackup} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-backup.js'))};
import {ensureCloudStoreIndexes} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-store-indexes.js'))};
import {cloudBusinessDatabase} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-business-db.js'))};
import {HEALTH_SCHEMA,healthSnapshot} from ${JSON.stringify(path.resolve('server-runtime/health.js'))};
export class CostProbe{
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 async fetch(){
  const real=this.ctx.storage;let written=0,read=0,kvPuts=0,kvDeletes=0;
  const sql={exec:(query,...args)=>{const statements=query.split(';').filter(s=>s.trim());if(statements.length>1&&!/^CREATE TRIGGER/i.test(query.trim())){if(args.length)throw Error('Fixture multi-statement parameters');let last;for(const statement of statements)last=sql.exec(statement);return last;}const c=real.sql.exec(query,...args),rows=Array.from(c),columns=c.columnNames;written+=c.rowsWritten;read+=c.rowsRead;return{columnNames:columns,rowsWritten:c.rowsWritten,rowsRead:c.rowsRead,[Symbol.iterator]:()=>rows[Symbol.iterator](),raw:()=>rows.map(r=>columns.map(k=>r[k]))[Symbol.iterator]()};}};
  const storage={sql,delete:async(...args)=>{kvDeletes++;return real.delete(...args);},get:real.get.bind(real),put:async(...args)=>{kvPuts++;return real.put(...args);},transaction:real.transaction.bind(real),transactionSync:real.transactionSync.bind(real)};
  const report={synthetic:true,records:20000,measurement:'actual Workerd SQL cursor.rowsWritten, KV puts reported separately'};
  const measure=async(label,fn)=>{const before=written,reads=read,p=kvPuts,d=kvDeletes;await fn();report[label]={sqlRowsWritten:written-before,sqlRowsRead:read-reads,kvPuts:kvPuts-p,kvDeletes:kvDeletes-d};};
  await measure('schema',async()=>{sql.exec("CREATE TABLE store_billing_local(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT '',day TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 0);");sql.exec('CREATE TABLE _cloud_objects(key TEXT PRIMARY KEY,size INTEGER,sha256 TEXT,object_key TEXT,metadata_json TEXT,deleted INTEGER);CREATE TABLE _cloud_sequence_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT);');});
  await measure('insertCanonical',async()=>sql.exec("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<20000) INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) SELECT 'order:'||n,'order','synthetic','shop','2026-11-10',json_object('sourceOrderId',CAST(n AS TEXT)),0 FROM c"));
  await measure('indexes',async()=>ensureCloudStoreIndexes(sql));
  const backup=async()=>{let b={protocol:2},action='start';for(let n=0;n<1000;n++){const r=new Request('https://fixture/api/server/cloud-backup/'+action,{method:'POST',body:JSON.stringify(b)});r.localInternal=true;const response=await routeCloudBackup(r,{SERVICE_DOCS_RAW:this.env.PRIVATE}, {realm:'https://fixture',generation:'synthetic'},storage);if(!response.ok)throw Error('Fixture backup failed '+response.status+': '+await response.text());const data=await response.json();if(!data.pending)return;action='continue';b={job:data.job,protocol:2};}throw Error('Backup did not complete');};
  await measure('firstFullBackup',backup);await measure('secondFullBackup',backup);
  await measure('healthSchema',async()=>sql.exec(HEALTH_SCHEMA));
  let clock=Date.parse('2026-11-10T12:00:00Z'),alerts=0;
  const env={DB:cloudBusinessDatabase(storage),BUSINESS_PORT:async()=>({at:new Date(clock).toISOString(),serverLastSeenAt:new Date(clock).toISOString(),ordexaLastSuccessAt:new Date(clock).toISOString(),storesLastSuccessAt:'2026-11-01T12:00:00Z',outboxPending:0,freeBytes:1024*1024*1024})};
  await measure('firstHealthRead',async()=>{const result=await healthSnapshot(env);alerts=result.alerts.length;});
  await measure('thirtyUnchangedHealthReads',async()=>{for(let n=0;n<30;n++){clock+=30000;await healthSnapshot(env);}});report.healthAlerts=alerts;report.totalSqlRowsWritten=written;return Response.json(report);
 }
}
export default{fetch(request,env){return env.COST.get(env.COST.idFromName('synthetic')).fetch(request);}};
`);
 await build({entryPoints:[entry],outfile:path.join(temp,'worker.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',r2Buckets:['PRIVATE'],durableObjects:{COST:{className:'CostProbe',useSQLite:true}}}));
 const r=await mf.dispatchFetch('https://fixture/');if(!r.ok)throw Error('Synthetic worker HTTP '+r.status+': '+await r.text());const value=await r.json();fs.writeFileSync('.build/cloud-write-cost-measurement.json',JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value,null,2));
}finally{if(mf)await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
