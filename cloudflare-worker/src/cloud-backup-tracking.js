import {sqlName} from './cloud-transfer.js';
import {backupSchema,backupSequences,typedBackupPage,objectPage,putBackupJson} from './cloud-backup-pages.js';
import {directHash} from './direct-relay.js';
import {NativeError} from '../../server-runtime/common.js';

// Dirty *rowid blocks*, not a second copy of business rows. A hot metadata row
// cannot force a reread of every historical order sharing its table. SQLite
// triggers cover all writers, including triggers run by shared business code.
const CURRENT='cloud-business.backup',PENDING='cloud-business.backup.pending';
const query=(sql,text,...args)=>Array.from(sql.exec(text,...args));
const meta=t=>({name:t.name,sql:t.sql,columns:t.columns});
const fresh=t=>({...meta(t),rows:0,pages:[],chunks:[],after:null,complete:false,current:null});
const lower=chunk=>(BigInt(chunk)<<8n)-1n;
const upper=chunk=>((BigInt(chunk)<<8n)+255n).toString();
function removeWatches(sql){for(const row of query(sql,"SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_cloud_backup_watch_*'"))sql.exec(`DROP TRIGGER ${sqlName(row.name)}`);}
function install(sql,tables,id){
 removeWatches(sql);
 const expires=Math.floor(Date.now()/1000)+900;
 sql.exec('CREATE TABLE IF NOT EXISTS _cloud_backup_tracking(id INTEGER PRIMARY KEY CHECK(id=1),job TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS _cloud_backup_dirty(table_name TEXT NOT NULL,chunk TEXT NOT NULL,PRIMARY KEY(table_name,chunk)) WITHOUT ROWID;');
 sql.exec('DELETE FROM _cloud_backup_dirty');
 sql.exec('INSERT INTO _cloud_backup_tracking VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET job=excluded.job,expires=excluded.expires',id,expires);
 for(const [index,table] of [...tables,{name:'_cloud_objects'}].entries()){
  const name=sqlName(table.name),literal="'"+table.name+"'";
  for(const event of ['INSERT','UPDATE','DELETE']){
   const mark=alias=>`INSERT OR IGNORE INTO _cloud_backup_dirty(table_name,chunk) VALUES(${literal},${table.name==='_cloud_objects'?"'objects'":`CAST((${alias}._rowid_ >> 8) AS TEXT)`});`;
   const body=event==='UPDATE'?mark('OLD')+mark('NEW'):mark(event==='DELETE'?'OLD':'NEW');
   sql.exec(`CREATE TRIGGER ${sqlName('_cloud_backup_watch_'+index+'_'+event.toLowerCase())} AFTER ${event} ON ${name} WHEN unixepoch()<${expires} BEGIN ${body} END;`);
  }
 }
}
async function save(storage,bucket,job){const ref=await putBackupJson(bucket,job.prefix+'/jobs',job);await storage.put(PENDING,{id:job.id,ref});}
export async function trackedBackup(storage,bucket,configuration,previous){
 const tables=backupSchema(storage.sql),id=previous?.id||crypto.randomUUID();
 const job={id,tracking:3,realm:configuration.realm,generation:configuration.generation,prefix:'cloud-backup-v2/'+await directHash(configuration.realm+'\0'+configuration.generation),tables:tables.map(fresh),objects:{pages:[],count:0,after:'',complete:false}};
 install(storage.sql,tables,id);await save(storage,bucket,job);return job;
}
function beginChunk(sql,table,chunk){
 const previous=table.chunks.find(c=>c.chunk===chunk);if(previous)table.rows-=previous.rows;
 table.chunks=table.chunks.filter(c=>c.chunk!==chunk);
 table.current={chunk,after:lower(chunk)<-9223372036854775808n?null:lower(chunk).toString(),pages:[],rows:0};
 sql.exec('DELETE FROM _cloud_backup_dirty WHERE table_name=? AND chunk=?',table.name,chunk);
}
function finishChunk(table){
 const c=table.current;table.rows+=c.rows;table.chunks.push({chunk:c.chunk,rows:c.rows,pages:c.pages});
 table.chunks.sort((a,b)=>BigInt(a.chunk)<BigInt(b.chunk)?-1:BigInt(a.chunk)>BigInt(b.chunk)?1:0);
 table.pages=table.chunks.flatMap(c=>c.pages);table.after=upper(c.chunk);table.current=null;
}
async function chunkPage(storage,bucket,job,table){
 const c=table.current,value=await typedBackupPage(storage.sql,table,c.after,upper(c.chunk));
 if(!value.rows.length){finishChunk(table);return false;}
 const ref=await putBackupJson(bucket,job.prefix+'/pages',value);
 c.pages.push({...ref,first:value.rows[0].rowid,last:value.rows.at(-1).rowid});c.rows+=value.rows.length;c.after=value.rows.at(-1).rowid;
 return true;
}
export async function advanceTrackedBackup(storage,bucket,configuration,job){
 if(job.tracking!==3)Object.assign(job,await trackedBackup(storage,bucket,configuration,job));
 const schema=backupSchema(storage.sql);
 if(JSON.stringify(schema)!==JSON.stringify(job.tables.map(meta)))Object.assign(job,await trackedBackup(storage,bucket,configuration,job));
 const marker=query(storage.sql,'SELECT job,expires,unixepoch() now FROM _cloud_backup_tracking WHERE id=1')[0];
 if(marker?.job!==job.id)throw new NativeError(409,'Άλλαξε η εργασία συνεπούς αντιγράφου. Το προηγούμενο σημείο διατηρείται.');
 // An abandoned preparation stops collecting dirty blocks after15 minutes.
 // If it resumes, start a fresh capture rather than trusting an untracked gap.
 if(marker.expires<=marker.now)Object.assign(job,await trackedBackup(storage,bucket,configuration,job));
 const started=Date.now();let pages=0,steps=0;
 const room=()=>pages<8&&steps++<64&&Date.now()-started<5000;
 // Initial capture visits each rowid block once. Boundary and rowid arithmetic
 // uses decimal int64 strings/BigInt; no JS-number rounding of historical IDs.
 for(const table of job.tables){
  while(!table.complete&&room()){
   if(!table.current){const first=query(storage.sql,`SELECT CAST((_rowid_ >> 8) AS TEXT) chunk FROM ${sqlName(table.name)} ${table.after===null?'':'WHERE _rowid_>CAST(? AS INTEGER)'} ORDER BY _rowid_ LIMIT 1`,...(table.after===null?[]:[table.after]))[0];
    if(!first){table.complete=true;break;}beginChunk(storage.sql,table,first.chunk);
   }
   if(await chunkPage(storage,bucket,job,table))pages++;
  }
  if(!table.complete)break;
 }
 if(job.tables.every(t=>t.complete)){
  // Repair at most256 source rows for a dirty block, including insert/delete,
  // changed rowids and inserts in gaps or beyond the initial high watermark.
  while(room()){
   let table=job.tables.find(t=>t.current);
   if(!table){const dirty=query(storage.sql,"SELECT table_name,chunk FROM _cloud_backup_dirty WHERE table_name<>'_cloud_objects' ORDER BY table_name,CAST(chunk AS INTEGER) LIMIT 1")[0];if(!dirty)break;
    table=job.tables.find(t=>t.name===dirty.table_name);if(!table)throw Error('Backup tracking schema changed');beginChunk(storage.sql,table,dirty.chunk);
   }
   if(await chunkPage(storage,bucket,job,table))pages++;
  }
 }
 const dirty=()=>query(storage.sql,"SELECT 1 found FROM _cloud_backup_dirty WHERE table_name<>'_cloud_objects' LIMIT 1").length;
 const tablesReady=job.tables.every(t=>t.complete&&!t.current)&&!dirty();
 if(tablesReady){
  // Private object maps are small and key-paged. They are recaptured only when
  // actually changed, rather than rescanned on every final validation attempt.
  if(query(storage.sql,"SELECT 1 found FROM _cloud_backup_dirty WHERE table_name='_cloud_objects' LIMIT 1").length){job.objects={pages:[],count:0,after:'',complete:false};storage.sql.exec("DELETE FROM _cloud_backup_dirty WHERE table_name='_cloud_objects'");}
  while(!job.objects.complete&&room()){
   const value=objectPage(storage.sql,job.objects.after);if(!value.objects.length){job.objects.complete=true;break;}
   const ref=await putBackupJson(bucket,job.prefix+'/pages',value);job.objects.pages.push({...ref,first:value.objects[0].key,last:value.objects.at(-1).key});job.objects.count+=value.objects.length;job.objects.after=value.objects.at(-1).key;pages++;
  }
 }
 // Caller holds the CloudBusiness event fence through this commit. All SQL
 // mutations since a captured block were tracked transactionally. No full-table
 // hash scan is needed, and no mixed point can be published after a lost ACK.
 if(tablesReady&&job.objects.complete&&!query(storage.sql,'SELECT 1 found FROM _cloud_backup_dirty LIMIT 1').length){
  const point={schema:1,storage:'r2-v2',id:job.id,realm:job.realm,generation:job.generation,capturedAt:new Date().toISOString(),tables:job.tables.map(t=>({...meta(t),rows:t.rows})),objectCount:job.objects.count,sequences:backupSequences(storage.sql)};
  const ref=await putBackupJson(bucket,job.prefix+'/points',{point,tables:job.tables.map(({chunks,current,...t})=>t),objects:job.objects});
  await storage.put(CURRENT,{schema:2,id:point.id,ref});removeWatches(storage.sql);storage.sql.exec("UPDATE _cloud_backup_tracking SET job='' WHERE id=1 AND job=?",job.id);await storage.delete(PENDING);return point;
 }
 await save(storage,bucket,job);return null;
}
