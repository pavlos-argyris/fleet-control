import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {build}=await import(pathToFileURL(require.resolve('esbuild')).href),{Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-backup-pages-'));let mf;
try{
 const entry=path.join(temp,'entry.mjs');fs.writeFileSync(entry,`
import {routeCloudBackup} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-backup.js'))};
import {ensureCloudStoreIndexes} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-store-indexes.js'))};
import {HEALTH_SCHEMA,healthSnapshot} from ${JSON.stringify(path.resolve('server-runtime/health.js'))};
import {cloudBusinessDatabase} from ${JSON.stringify(path.resolve('cloudflare-worker/src/cloud-business-db.js'))};
export class Probe{
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 async fetch(request){return this.ctx.blockConcurrencyWhile(async()=>{
  const real=this.ctx.storage;let writes=0,puts=0,deletes=0;const sql={exec:(q,...a)=>{const cursor=real.sql.exec(q,...a),values=Array.from(cursor);writes+=cursor.rowsWritten;return{columnNames:cursor.columnNames,[Symbol.iterator]:()=>values[Symbol.iterator](),raw:()=>values.map(r=>cursor.columnNames.map(c=>r[c]))[Symbol.iterator]()};}};
  const storage={sql,get:real.get.bind(real),put:async(...a)=>{puts++;return real.put(...a);},delete:async(...a)=>{deletes++;return real.delete(...a);},transactionSync:real.transactionSync.bind(real)};
  const u=new URL(request.url);let response;
  try{response=await real.transaction(async()=>{
   if(u.pathname==='/setup'){
    sql.exec('CREATE TABLE store_billing_local(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,store_id TEXT NOT NULL,day TEXT NOT NULL,data TEXT NOT NULL,dirty INTEGER NOT NULL)');
    sql.exec("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<1200) INSERT INTO store_billing_local SELECT 'o:'||n,'order','scope','shop','2026-11-10',json_object('sourceOrderId',CAST(n AS TEXT)),0 FROM c");
    sql.exec('CREATE TABLE _cloud_objects(key TEXT PRIMARY KEY,size INTEGER,sha256 TEXT,object_key TEXT,metadata_json TEXT,deleted INTEGER)');
    sql.exec('CREATE TABLE sequence_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT)');sql.exec("INSERT INTO sequence_fixture VALUES(9000,'removed high watermark')");sql.exec('DELETE FROM sequence_fixture');
    sql.exec('CREATE TABLE wide_fixture('+Array.from({length:99},(_,i)=>'c'+i+' TEXT').join(',')+')');
    sql.exec('INSERT INTO wide_fixture VALUES('+Array(99).fill('?').join(',')+')',...Array.from({length:99},(_,i)=>'στήλη '+i));
    sql.exec('CREATE TABLE typed_fixture(id TEXT PRIMARY KEY,n INTEGER,r REAL,b BLOB,v TEXT)');
    sql.exec("INSERT INTO typed_fixture VALUES('typed',9223372036854775807,1.0,x'',NULL)");
    sql.exec('CREATE TABLE control_fixture(v TEXT)');sql.exec('INSERT INTO control_fixture(rowid,v) VALUES(CAST(? AS INTEGER),?)','-9223372036854775808',String.fromCharCode(0,34,92).repeat(200000));sql.exec("INSERT INTO control_fixture(rowid,v) VALUES(0,'zero rowid')");
    await this.env.PRIVATE.put('original/placeholder','placeholder');
    sql.exec("WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM c WHERE n<299) INSERT INTO _cloud_objects SELECT printf('a%03d',n),11,'','original/placeholder','{}',0 FROM c");
    for(const key of ['doc','\ue000','🛵']){const target='original/'+key;await this.env.PRIVATE.put(target,'original '+key);sql.exec('INSERT INTO _cloud_objects VALUES(?,?,?,?,?,0)',key,new TextEncoder().encode('original '+key).length,'',target,'{}');}
    sql.exec("CREATE INDEX cloud_store_order_identity ON store_billing_local(scope,kind,json_extract(data,'$.sourceOrderId'))");ensureCloudStoreIndexes(sql);
    for(const statement of HEALTH_SCHEMA.split(';').filter(q=>q.trim()))sql.exec(statement);
    return Response.json({ready:true});
   }
   if(u.pathname==='/fail-backup-write'){this.failStore=true;return Response.json({ok:true});}
   if(u.pathname==='/query')return Response.json({rows:Array.from(sql.exec((await request.json()).sql))});
   if(u.pathname==='/health'){
    const b=await request.json(),at=b.at||'2026-11-10T12:00:00Z';
    return Response.json(await healthSnapshot({DB:cloudBusinessDatabase(storage),BUSINESS_PORT:async()=>({at,serverLastSeenAt:at,ordexaLastSuccessAt:at,storesLastSuccessAt:b.healthy?at:'2026-11-01T12:00:00Z',outboxPending:0})}));
   }
   if(u.pathname==='/pointers')return Response.json({current:await real.get('cloud-business.backup'),pending:await real.get('cloud-business.backup.pending')});
   if(u.pathname==='/legacy'){
    const point={schema:1,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',tables:[{name:'typed_fixture',columns:['id','n','r','b','v'],rows:1}]};
    sql.exec('CREATE TABLE _cloud_backup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_typed_fixture AS SELECT rowid _backup_source_row,* FROM typed_fixture');await storage.put('cloud-business.backup',point);return Response.json(point);
   }
   const bucket=this.env.PRIVATE,owner=this,privateBucket={head:bucket.head.bind(bucket),get:bucket.get.bind(bucket),put:async(...a)=>{if(owner.failStore){owner.failStore=false;throw Error('synthetic R2 failure');}return bucket.put(...a);}};request.localInternal=request.headers.get('X-Test-Internal')==='1';return await routeCloudBackup(request,{SERVICE_DOCS_RAW:privateBucket},{realm:'https://fixture',generation:'synthetic'},storage);
  });}catch(e){response=Response.json({error:e.message},{status:e.status||500});}
  const h=new Headers(response.headers);h.set('X-Test-SQL-Writes',String(writes));h.set('X-Test-KV-Puts',String(puts));h.set('X-Test-KV-Deletes',String(deletes));return new Response(response.body,{status:response.status,headers:h});
 });}
}
export default{fetch(r,e){return e.PROBE.get(e.PROBE.idFromName('test')).fetch(r);}};
`);
 await build({entryPoints:[entry],outfile:path.join(temp,'worker.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(temp,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',r2Buckets:['PRIVATE'],durableObjects:{PROBE:{className:'Probe',useSQLite:true}}}));
 let totalSql=0,totalKv=0;const call=async(url,body,internal=true)=>{const r=await mf.dispatchFetch('https://fixture'+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Test-Internal':internal?'1':'0'},body:body===undefined?undefined:JSON.stringify(body)});const writes=Number(r.headers.get('X-Test-SQL-Writes'));totalSql+=writes;totalKv+=Number(r.headers.get('X-Test-KV-Puts'))+Number(r.headers.get('X-Test-KV-Deletes'));return{status:r.status,data:await r.json(),writes};};
 const ok=r=>{assert(r.status>=200&&r.status<300,JSON.stringify(r));return r.data;};
 ok(await call('/setup',{}));const query=async sql=>ok(await call('/query',{sql})).rows;
 const plans=await query("EXPLAIN QUERY PLAN SELECT data FROM store_billing_local WHERE scope='scope' AND kind='cash_snapshot_order' AND json_extract(data,'$.sourceOrderId') IN ('1','2')");assert(plans.some(r=>r.detail.includes('cloud_cash_order_identity_v2')));
 assert.equal((await query("SELECT name FROM sqlite_master WHERE name='cloud_store_order_identity'")).length,0);
 const insertOrder=await call('/query',{sql:"INSERT INTO store_billing_local VALUES('new','order','scope','shop','2026-11-10','{}',0)"});assert.equal(insertOrder.writes,3,'raw orders pay PK and source index only');
 const first=ok(await call('/health',{})),incident=first.incidents[0];let observed=first.observedAt;
 for(let n=1;n<=30;n++){const r=await call('/health',{at:new Date(Date.parse(observed)+n*30000).toISOString()});assert.equal(r.writes,0,'unchanged health views are read-only');assert.equal(r.data.incidents[0].last_at,incident.last_at);assert.notEqual(r.data.observedAt,observed);}
 await query("UPDATE native_health_incidents SET severity='critical'");assert.equal((await call('/health',{})).writes,1,'severity transition is persisted exactly once');assert.equal((await call('/health',{})).writes,0);
 ok(await call('/health',{healthy:true}));assert(ok(await call('/health',{healthy:true})).incidents[0].resolved);assert.equal(ok(await call('/health',{})).incidents.length,2,'a recurrence remains a new incident generation');
 const legacy=ok(await call('/legacy',{}));assert.equal(ok(await call('/api/server/cloud-backup/rows?point='+legacy.id+'&table=typed_fixture')).rows[0].values[1][1],'9223372036854775807');
 assert.equal((await call('/api/server/cloud-backup/start',{protocol:2},false)).status,403);
 ok(await call('/fail-backup-write',{}));assert.equal((await call('/api/server/cloud-backup/start',{protocol:2})).status,500);assert.equal(ok(await call('/api/server/cloud-backup/rows?point='+legacy.id+'&table=typed_fixture')).rows.length,1,'failed R2 capture preserves previous point');
 let state=ok(await call('/api/server/cloud-backup/start',{protocol:2})),job=state.job;const before=totalSql;let continuations=0;
 const next=async()=>{const r=await call('/api/server/cloud-backup/continue',{job,protocol:2});assert.equal(r.writes,0,'R2 backup does not write canonical or clone SQL rows');continuations++;return ok(r);};
 state=await next();assert(state.pending);assert.equal(ok(await call('/api/server/cloud-backup/start',{protocol:2})).job,job,'restart resumes the same durable job');
 // Change an already captured early page, append data, and change the private
 // file mapping between capture requests. Validation must reject a mixed point.
 await query("UPDATE store_billing_local SET data='{\"changed\":true}' WHERE id='o:1'");await query("DELETE FROM store_billing_local WHERE id='o:2'");
 const bucket=await mf.getR2Bucket('PRIVATE');await bucket.put('replacement/doc','new bytes');await query("UPDATE _cloud_objects SET object_key='replacement/doc',size=9 WHERE key='doc'");
 let afterMutations=totalSql,changedObject=false;
 while(state.pending&&continuations<30){
  if(!changedObject&&state.objectsCaptured>0){await query("UPDATE _cloud_objects SET object_key='replacement/doc',size=9 WHERE key='a000'");afterMutations=totalSql;changedObject=true;}
  state=await next();
 }
 assert(changedObject,'private map changed after its first pages were captured');assert(!state.pending,'consistent point completes after recapturing dirty data');assert(totalSql>=before);assert.equal(totalSql,afterMutations,'only explicit test mutations produced SQL writes during capture');
 const controls=ok(await call('/api/server/cloud-backup/rows?point='+state.id+'&table=control_fixture')).rows;assert.equal(controls[0].rowid,'-9223372036854775808');assert.equal(controls[0].values[0][1],String.fromCharCode(0,34,92).repeat(200000));assert.equal(ok(await call('/api/server/cloud-backup/rows?point='+state.id+'&table=control_fixture&after=-9223372036854775808')).rows[0].rowid,'0');
 assert.equal(state.storage,'r2-v2');assert.equal(state.sequences.find(s=>s.name==='sequence_fixture').seq,'9000');assert.equal(ok(await call('/api/server/cloud-backup/continue',{job})).id,state.id,'lost completion ACK is idempotent');
 assert.equal((await query("SELECT name FROM sqlite_master WHERE name LIKE '_cloud_backup_%'")).length,1,'only retained legacy clone exists');
 const dataUrl='/api/server/cloud-backup/rows?point='+state.id+'&table=store_billing_local';let after=null,count=0,found=false;
 for(;;){const page=ok(await call(dataUrl+(after===null?'':'&after='+after))).rows;if(!page.length)break;for(const row of page){if(row.values[0][1]==='o:1'){assert.equal(row.values[5][1],'{"changed":true}');found=true;}assert.notEqual(row.values[0][1],'o:2');count++;after=row.rowid;}}
 assert(found);assert.equal(count,1200);
 const typed=ok(await call('/api/server/cloud-backup/rows?point='+state.id+'&table=typed_fixture')).rows[0];assert.deepEqual(typed.values.slice(1),[['integer','9223372036854775807'],['real','1.0'],['blob',''],['null',null]]);
 assert.equal(ok(await call('/api/server/cloud-backup/rows?point='+state.id+'&table=wide_fixture')).rows[0].values.length,99);
 const objectList=[];let afterObject='';for(;;){const page=ok(await call('/api/server/cloud-backup/objects?point='+state.id+'&after='+encodeURIComponent(afterObject))).objects;if(!page.length)break;objectList.push(...page);afterObject=page.at(-1).key;}assert.equal(objectList.length,303);assert.deepEqual(objectList.slice(-3).map(o=>o.key),['doc','\ue000','🛵']);assert(!objectList.some(o=>'object_key' in o));
 await query("UPDATE typed_fixture SET v='after point'");assert.equal(ok(await call('/api/server/cloud-backup/rows?point='+state.id+'&table=typed_fixture')).rows[0].values.at(-1)[0],'null','subsequent writes cannot change immutable backup pages');
 await query("UPDATE _cloud_objects SET object_key='original/doc' WHERE key='doc'");const file=await mf.dispatchFetch('https://fixture/api/server/cloud-backup/file?point='+state.id+'&key=doc',{headers:{'X-Test-Internal':'1'}});assert.equal(await file.text(),'new bytes','files use the same captured immutable mapping');assert.equal(await (await bucket.get('original/doc')).text(),'original doc');
 const pointer=ok(await call('/pointers')),manifest=await (await bucket.get(pointer.current.ref.key)).json(),ref=manifest.tables.find(t=>t.name==='typed_fixture').pages[0];await bucket.put(ref.key,'corrupt');assert.equal((await call('/api/server/cloud-backup/rows?point='+state.id+'&table=typed_fixture')).status,409,'corrupted R2 content fails closed');
 assert.equal((await call(dataUrl+'&after=9223372036854775808')).status,400);
 console.log('PASS real SQLite-DO/R2 backup: zero SQL writes, resumable bounded capture, concurrent update/delete/file-map recapture, full final consistency validation, immutable typed/int64/REAL/empty-BLOB/NULL/99-column pages, sequence high watermark, lost ACK, original bytes retained, legacy point reads, corruption/auth rejection; cash lookup uses partial index and30 unchanged health reads write zero rows.');
}finally{if(mf)await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
