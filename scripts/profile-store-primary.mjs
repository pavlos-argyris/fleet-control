/** Synthetic actual Workerd D1 profiling. No provider or production requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {routeStoreBilling,STORE_BILLING_SCHEMA} from '../cloudflare-worker/src/store-billing.js';
import {MIRROR_SCHEMA} from '../cloudflare-worker/src/mirror-delta.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-10-01',d1Databases:{DB:'profile'}}));
const report=[];let written=0;
try{
 const actual=await runtime.getD1Database('DB');
 const wrap=stmt=>({raw:stmt,bind(...v){return wrap(stmt.bind(...v));},first(...v){return stmt.first(...v);},async all(){const r=await stmt.all();written+=r.meta?.rows_written||0;return r;},async run(){const r=await stmt.run();assert.equal(typeof r.meta.rows_written,'number');written+=r.meta.rows_written;return r;}});
 const env={DB:{prepare:s=>wrap(actual.prepare(s)),async batch(stmts){const r=await actual.batch(stmts.map(s=>s.raw));for(const x of r)written+=x.meta?.rows_written||0;return r;}}};
 class ApiError extends Error{constructor(status,message){super(message);this.status=status;}}
 const D={ApiError,serverAuthorized:async()=>true,bodyJson:r=>r.json(),wfJson:(data,status=200)=>new Response(JSON.stringify(data),{status})};
 async function post(action,b){const req=new Request('https://fixture/api/server/store-billing/'+action,{method:'POST',body:JSON.stringify(b)}),r=await routeStoreBilling(req,env,new URL(req.url).pathname,D),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
 // Minimal unrelated tables, canonical production mirror triggers on the measured table.
 await actual.exec("CREATE TABLE fleet_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); CREATE TABLE fleet_mirror_state(id INTEGER PRIMARY KEY,epoch TEXT,floor INTEGER DEFAULT 0); INSERT INTO fleet_mirror_state(id,epoch) VALUES(1,'fixture'); CREATE TABLE fleet_operations(id TEXT PRIMARY KEY,source TEXT,type TEXT,payload TEXT,status TEXT,created_at TEXT); CREATE TABLE system_alerts(id TEXT PRIMARY KEY,type TEXT,severity TEXT,title TEXT,message TEXT,object_type TEXT,object_id TEXT,dedupe_key TEXT,resolved INTEGER,created_at TEXT);");
 await actual.exec(STORE_BILLING_SCHEMA.replaceAll('\n',' '));
 await actual.exec("CREATE TABLE fleet_mirror_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT,row_id INTEGER,UNIQUE(table_name,row_id));");
 for(const trigger of MIRROR_SCHEMA.split('\n').filter(s=>s.includes('CREATE TRIGGER')&&s.includes(' ON store_billing_records ')))await actual.exec(trigger);
 for(const days of [1,7,31]){
  console.error('Measuring '+days+' days');const scope='profile:'+days,setup=await post('control',{scope,generation:'g1',generationAt:1,cityId:'1',from:'2026-09-01',to:'2026-09-01'}),ctx={scope,generation:'g1',epoch:setup.epoch,operationId:setup.job.id,lease:setup.job.lease};
  await post('catalogue',{...ctx,complete:true,catalogueHash:'a'.repeat(64),stores:Array.from({length:8},(_,i)=>({id:scope+':shop:'+i,sourceShopId:String(i),name:'Synthetic '+i,blocked:false,sourceTerms:[{effectiveDay:'',supported:true,unitPriceCents:200,dailyMinimumCents:0,chargeOnZero:false}]}))});
  const revision=(await actual.prepare("SELECT revision FROM store_billing_records WHERE id=?").bind('connection:'+scope).first()).revision;
  let legacy=0,primary=0,repeated=0;
  for(let d=0;d<days;d++){
   const day=new Date(Date.UTC(2026,8,1+d)).toISOString().slice(0,10),sourceAt=day+'T20:00:00Z';
   const makeRow=i=>({storeId:scope+':shop:'+i,businessDay:day,storeRevision:1,retentionUsed:false,termsId:'fixture',orderCount:12+(i<4?1:0),orderChargeCents:200*(12+(i<4?1:0)),minimumTopUpCents:0,totalChargeCents:200*(12+(i<4?1:0)),engineVersion:1,cutoffHour:5,timeZone:'Europe/Athens',retainedOrders:0,reviewCount:0});
   let before=written;
   for(let offset=0;offset<100;offset+=32){const records=Array.from({length:Math.min(32,100-offset)},(_,i)=>{const n=offset+i,id=scope+':order:'+d+':'+n,storeId=scope+':shop:'+n%8;return {id,kind:'order',storeId,day,data:{id,storeId,businessDay:day,sourceOrderId:String(n),sourceShopId:String(n%8),at:day+'T10:00:00Z',active:true}};});await post('archive',{...ctx,records});}
   const oldRun=scope+':old:'+d;await post('stage',{...ctx,runId:oldRun,day,rows:Array.from({length:8},(_,i)=>makeRow(i))});await post('publish',{...ctx,runId:oldRun,day,count:8,removalCount:0,sourceAt});legacy+=written-before;
   const runId=scope+':new:'+d,base={...ctx,protocol:2,inputRevision:revision,runId,day,count:8,changedCount:8,sourceAt};
   before=written;await post('aggregate-stage',{...base,rows:Array.from({length:8},(_,i)=>makeRow(i))});await post('aggregate-publish',base);primary+=written-before;
   before=written;await post('aggregate-publish',{...base,runId:runId+':repeat',changedCount:0});repeated+=written-before;
  }
  report.push({days,stores:8,orders:days*100,legacyRowsWritten:legacy,aggregateRowsWritten:primary,unchangedRowsWritten:repeated,reductionPercent:Number((100*(1-primary/legacy)).toFixed(2))});
 }
 const workerSource=fs.readFileSync('cloudflare-worker/src/worker.js','utf8'),touchBody=workerSource.match(/async function touchServer\(env\) \{([\s\S]*?)\n\}/)[1];
 const touch=new (Object.getPrototypeOf(async function(){}).constructor)('env',touchBody);
 let before=written;for(let i=0;i<30;i++)await env.DB.prepare("INSERT INTO fleet_settings(key,value,updated_at) VALUES('server_last_seen',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind('2026-01-01T00:00:00Z','fixture').run();const oldPulse=written-before;
 await actual.prepare("DELETE FROM fleet_settings WHERE key='server_last_seen'").run();before=written;for(let i=0;i<30;i++)await touch(env);const newPulse=written-before;
 assert.ok(newPulse<oldPulse);console.log(JSON.stringify({heartbeat:{callsWithinMinute:30,legacyRowsWritten:oldPulse,coalescedRowsWritten:newPulse},environment:'Synthetic Miniflare/Workerd D1 meta.rows_written, production SQL/indexes and mirror triggers; excludes setup/control/heartbeat and production telemetry',results:report},null,2));
}finally{await runtime.dispose();}
