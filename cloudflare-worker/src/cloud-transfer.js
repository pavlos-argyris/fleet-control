import {directHash} from './direct-relay.js';
import {FEATURE_SCHEMA} from '../../server-runtime/features.js';
import {RECEIPT_SCHEMA} from '../../server-runtime/receipts.js';
import {MIRROR_SCHEMA} from './mirror-delta.js';
export const CLOUD_TRANSFER_VERSION=1;
const NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const HASH=/^[a-f0-9]{64}$/;
const denied=new Set(['bikes','settings','system_state','applied_operations','fleet_releases','fleet_primary_fence','fleet_primary_cancellations','d1_migrations','fleet_mirror_changes','fleet_mirror_state','native_primary_state','native_objects','native_file_transfers','native_object_gc','native_backup_pins','native_event_outbox','native_migration_rows','native_migration_inventory']);
export const transferable=name=>NAME.test(name)&&!denied.has(name)&&!/^(_cf_|__cf|sqlite_|server_|_cloud_|cloud_source_)/i.test(name);
export const sqlName=name=>{if(!NAME.test(name))throw Error('Invalid transfer identifier');return '"'+name+'"';};
export function typedExpression(cell){
  if(!Array.isArray(cell)||cell.length!==2)throw Error('Invalid typed cell');const [type,value]=cell;
  if(type==='null'&&value===null)return{sql:'NULL',args:[]};
  if(typeof value!=='string')throw Error('Untyped transfer cell');
  if(type==='integer'&&/^-?(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)>=-9223372036854775808n&&BigInt(value)<=9223372036854775807n)return{sql:'CAST(? AS INTEGER)',args:[value]};
  if(type==='real'&&value.length<=40&&/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)&&Number.isFinite(Number(value)))return{sql:'CAST(? AS REAL)',args:[Number(value)]};
  if(type==='text')return{sql:'CAST(? AS TEXT)',args:[value]};
  if(type==='blob'&&/^(?:[A-F0-9]{2})*$/.test(value))return{sql:'?',args:[Uint8Array.from(value.match(/../g)||[],s=>parseInt(s,16)).buffer]};
  throw Error('Invalid SQLite storage type');
}
async function rowDigest(table,rowid,values){
 const enc=new TextEncoder(),parts=[enc.encode(table+'\0'+rowid+'\0')];for(const c of values){typedExpression(c);const b=enc.encode(c[1]??'');parts.push(enc.encode(c[0]+'\0'+b.length+'\0'),b);}const b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){b.set(p,at);at+=p.length;}return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
}
export {rowDigest};
export const cloudObjectKey=(id,key,sha)=>'cloud-primary/'+id+'/objects/'+key+'/'+sha;
export const objectDigest=o=>directHash(o.key+'\0'+o.size+'\0'+o.sha256+'\0'+o.metadataJson);
const queryRows=(sql,text,...args)=>Array.from(sql.exec(text,...args));
export function schemaInventoryTable(table){
  if(!table||!transferable(table.name)||!Number.isSafeInteger(table.rows)||table.rows<0||!HASH.test(table.contentHash||'')||!Array.isArray(table.columns)||!table.columns.length||table.columns.length>99||new Set(table.columns).size!==table.columns.length||table.columns.some(c=>!NAME.test(c)))throw Error('Invalid transfer inventory');
  const prefix=new RegExp('^CREATE TABLE(?: IF NOT EXISTS)? ["`\\[]?'+table.name+'["`\\]]?\\s*\\(','i');
  const schema=String(table.sql||'').trim().replace(/;$/,'');
  if(!prefix.test(schema)||schema.length>90000||/[;]|--|\/\*/.test(schema)||/\b(VIRTUAL|ATTACH|DETACH|TRIGGER)\b/i.test(schema)||!/[)]\s*$/.test(schema))throw Error('Unsupported transfer table schema');
  return schema;
}
export function storedRow(sql,table,rowid,{relation=table.name,rowColumn='rowid'}={}){
  // SQLite DOs limit result columns as well as table columns. Read each part
  // under the same serialized transaction, preserving the full99-column source.
  const values=[];for(let offset=0;offset<table.columns.length;offset+=40){
    const columns=table.columns.slice(offset,offset+40).flatMap((c,i)=>{const q=sqlName(c);return [`typeof(${q}) t${i}`,`CASE typeof(${q}) WHEN 'null' THEN NULL WHEN 'blob' THEN hex(${q}) WHEN 'real' THEN printf('%!.17g',${q}) ELSE CAST(${q} AS TEXT) END v${i}`];});
    const r=queryRows(sql,`SELECT ${columns.join(',')} FROM ${sqlName(relation)} WHERE ${sqlName(rowColumn)}=CAST(? AS INTEGER)`,rowid)[0];
    if(!r)return null;values.push(...table.columns.slice(offset,offset+40).map((_,i)=>[r['t'+i],r['v'+i]]));
  }return values;
}
export class CloudTransfer {
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 async control(action,body){return this.ctx.storage.transaction(async()=>{
  const storage=this.ctx.storage,sql=storage.sql;let transfer=await storage.get('cloud-business.transfer');
  if(action==='init'){
   if(typeof body.inventoryJson!=='string'||body.inventoryJson.length>500000)throw Error('Missing transfer inventory');
   const manifest=JSON.parse(body.inventoryJson);body.tables=manifest.tables;body.objects=manifest.objects;if(manifest.ownerId!==body.ownerId||manifest.authPepperSha256!==await directHash(body.authPepper||''))throw Error('Transfer identity manifest changed');
   if(!body||body.schema!==1||!Array.isArray(body.tables)||body.tables.length<20||body.tables.length>200||new Set(body.tables.map(t=>t.name)).size!==body.tables.length||!body.backup?.restoreVerified||!HASH.test(body.backup.databaseSha256||'')||typeof body.ownerId!=='string'||!body.ownerId||body.ownerId.length>160||typeof body.authPepper!=='string'||body.authPepper.length>512||typeof body.eventSigningKey!=='string'||body.eventSigningKey.length<32)throw Error('Incomplete transfer proof');
   const inventoryHash=await directHash(body.inventoryJson);if(body.inventoryHash!==inventoryHash)throw Error('Transfer inventory hash changed');
   if(transfer){if(transfer.inventoryHash!==inventoryHash||transfer.generation!==body.generation||transfer.transferId!==body.transferId)throw Error('Different transfer snapshot');return this.status(transfer);}
   if(await storage.get('cloud-business.configuration'))throw Error('Cloud business is already prepared');
   const allowed=new Set(body.tables.map(t=>t.name));for(const required of ['app_users','fleet_snapshot','payroll_snapshots','native_cash_events','native_cash_rules','native_operation_receipts','store_billing_local'])if(!allowed.has(required))throw Error('Incomplete canonical source');
   for(const t of body.tables){sql.exec(schemaInventoryTable(t));const actual=queryRows(sql,`PRAGMA table_info(${sqlName(t.name)})`).map(c=>c.name);if(JSON.stringify(actual)!==JSON.stringify(t.columns))throw Error('Transfer columns changed');}
   if(!body.objects||!Number.isSafeInteger(body.objects.count)||body.objects.count<0||body.objects.count>50000||!HASH.test(body.objects.contentHash||''))throw Error('Invalid object inventory');
   sql.exec("CREATE TABLE _cloud_objects(key TEXT PRIMARY KEY,size INTEGER NOT NULL,sha256 TEXT NOT NULL,object_key TEXT NOT NULL,metadata_json TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);");
   sql.exec('CREATE TABLE _cloud_transfer_progress(name TEXT PRIMARY KEY,count INTEGER NOT NULL,chain TEXT NOT NULL,last_row TEXT);');
   for(const t of body.tables)sql.exec('INSERT INTO _cloud_transfer_progress VALUES(?,0,?,NULL)',t.name,'0'.repeat(64));
   transfer={...body,inventoryHash,prepared:false,objectCount:0,objectChain:'0'.repeat(64),lastObject:null};delete transfer.inventoryJson;await storage.put('cloud-business.transfer',transfer);return this.status(transfer);
  }
  if(!transfer&&action==='status')return{active:false,started:false};
  if(!transfer||body.generation!==transfer.generation||body.transferId!==transfer.transferId||body.inventoryHash!==transfer.inventoryHash)throw Error('Transfer generation changed');
  if(action==='status')return this.status(transfer);
  if(action==='row'||action==='rows'){
   if(transfer.prepared)throw Error('Transfer is already prepared');const table=transfer.tables.find(t=>t.name===body.table),incoming=action==='row'?[body]:body.rows;
   if(!table||!Array.isArray(incoming)||!incoming.length||incoming.length>64)throw Error('Invalid transfer batch');
   const p=queryRows(sql,'SELECT * FROM _cloud_transfer_progress WHERE name=?',table.name)[0];let lastInput=null;
   for(const row of incoming){const rowid=String(row.rowid);
    if(!/^(-?[1-9][0-9]*|0)$/.test(rowid)||BigInt(rowid)<-9223372036854775808n||BigInt(rowid)>9223372036854775807n||lastInput!==null&&BigInt(rowid)<=BigInt(lastInput)||!Array.isArray(row.values)||row.values.length!==table.columns.length)throw Error('Invalid transfer row');lastInput=rowid;
    const digest=await rowDigest(table.name,rowid,row.values);if(digest!==row.hash)throw Error('Transfer row hash mismatch');
    if(p.last_row!==null&&BigInt(rowid)<=BigInt(p.last_row)){const previous=storedRow(sql,table,rowid);if(!previous||await rowDigest(table.name,rowid,previous)!==digest)throw Error('Changed repeated transfer row');continue;}
    if(p.count>=table.rows)throw Error('Transfer count changed');const cells=row.values.map(typedExpression),args=cells.flatMap(c=>c.args);
    sql.exec(`INSERT INTO ${sqlName(table.name)}(rowid,${table.columns.map(sqlName).join(',')}) VALUES(${rowid},${cells.map(c=>c.sql).join(',')})`,...args);
    const stored=storedRow(sql,table,rowid);if(await rowDigest(table.name,rowid,stored)!==digest)throw Error('SQLite round-trip changed a typed row');
    p.chain=await directHash(p.chain+':'+digest);p.last_row=rowid;p.count++;
   }
   sql.exec('UPDATE _cloud_transfer_progress SET count=?,chain=?,last_row=? WHERE name=?',p.count,p.chain,p.last_row,table.name);return{saved:true,count:p.count,chain:p.chain,last_row:p.last_row};
  }
  if(action==='object'){
   const o=body.object;
   if(!o||typeof o.key!=='string'||o.key.length<1||o.key.length>500||!Number.isSafeInteger(o.size)||o.size<1||o.size>50*1024*1024||!HASH.test(o.sha256||'')||typeof o.metadataJson!=='string'||o.metadataJson.length>16000)throw Error('Invalid source object');
   const metadata=JSON.parse(o.metadataJson);if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Invalid source object metadata');
   const prior=queryRows(sql,'SELECT * FROM _cloud_objects WHERE key=?',o.key)[0];if(prior){if(prior.size!==o.size||prior.sha256!==o.sha256||prior.metadata_json!==o.metadataJson)throw Error('Changed repeated source object');return{saved:true,replayed:true};}
   if(transfer.prepared)throw Error('Transfer is already prepared');
   if(transfer.objectCount>=transfer.objects.count||transfer.lastObject!==null&&o.key<=transfer.lastObject)throw Error('Source object order changed');
   const key=cloudObjectKey(transfer.transferId,o.key,o.sha256),head=await this.env.SERVICE_DOCS.head(key);
   const bytes=head?.checksums?.sha256,actual=bytes?Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join(''):'';
   if(!head||head.size!==o.size||actual!==o.sha256)throw Error('Source object bytes were not verified');
   sql.exec('INSERT INTO _cloud_objects(key,size,sha256,object_key,metadata_json) VALUES(?,?,?,?,?)',o.key,o.size,o.sha256,key,o.metadataJson);transfer.objectCount++;transfer.lastObject=o.key;transfer.objectChain=await directHash(transfer.objectChain+':'+await objectDigest(o));await storage.put('cloud-business.transfer',transfer);return{saved:true};
  }
  if(action==='prepare'){
   if(transfer.objectCount!==transfer.objects.count||transfer.objectChain!==transfer.objects.contentHash)throw Error('Incomplete private objects');
   for(const t of transfer.tables){const p=queryRows(sql,'SELECT * FROM _cloud_transfer_progress WHERE name=?',t.name)[0];if(p.count!==t.rows||p.chain!==t.contentHash||queryRows(sql,`SELECT COUNT(*) n FROM ${sqlName(t.name)}`)[0].n!==t.rows)throw Error('Incomplete transfer table');}
   if(queryRows(sql,'PRAGMA quick_check').some(r=>r.quick_check!=='ok')||queryRows(sql,'PRAGMA foreign_key_check').length)throw Error('Cloud SQLite integrity failed');
   const owner=queryRows(sql,"SELECT id FROM app_users WHERE id=? AND role='owner' AND active=1 AND login_enabled=1 AND deleted_at IS NULL",transfer.ownerId)[0];if(!owner)throw Error('Transferred owner is inactive');
   // Install only code-owned indexes/triggers; source SQL triggers are never accepted.
   sql.exec(RECEIPT_SCHEMA+'\n'+FEATURE_SCHEMA);sql.exec(MIRROR_SCHEMA);sql.exec("CREATE INDEX IF NOT EXISTS cloud_store_source ON store_billing_local(scope,kind,day,store_id);CREATE INDEX IF NOT EXISTS cloud_store_order_identity ON store_billing_local(scope,kind,json_extract(data,'$.sourceOrderId'));");
   // Force the signed core schema upgrade on first request, not a stale source cache flag.
   sql.exec("UPDATE fleet_settings SET value='' WHERE key='runtime_schema_version'");
   transfer.prepared=true;await storage.put('cloud-business.transfer',transfer);return{prepared:true,inventoryHash:transfer.inventoryHash};
  }
  if(action==='enable'){
   if(!transfer.prepared)throw Error('Cloud transfer is not prepared');
   // Routing remains native until the separate coordinator commit. Retrying this
   // idempotent write cannot expose the candidate prematurely.
   await storage.put('cloud-business.configuration',{active:true,targetId:transfer.transferId,generation:transfer.generation,realm:transfer.realm,authPepper:transfer.authPepper,eventSigningKey:transfer.eventSigningKey,context:transfer.context,inventoryHash:transfer.inventoryHash});return{enabled:true,inventoryHash:transfer.inventoryHash};
  }
  throw Error('Unsupported cloud transfer action');
 });}
 async status(t){return{schema:1,inventoryHash:t.inventoryHash,prepared:t.prepared,objects:t.objectCount,tables:queryRows(this.ctx.storage.sql,'SELECT * FROM _cloud_transfer_progress ORDER BY name')};}
}
