import {transferable,rowDigest,sqlName,storedRow} from './cloud-transfer.js';
import {NativeError} from '../../server-runtime/common.js';
const rows=(sql,q,...args)=>Array.from(sql.exec(q,...args));
const copyId=(id,name)=>'_cloud_backup_'+id.replaceAll('-','')+'_'+name;
const copyName=(id,name)=>sqlName(copyId(id,name));
/** A consistent private SQLite point, not a series of live paged reads. The
 * small temporary clone is discarded only after the next point is committed.
 * Original tables/objects are never deleted by this mechanism. */
export async function routeCloudBackup(request,env,configuration,storage){
 const u=new URL(request.url);if(!u.pathname.startsWith('/api/server/cloud-backup/'))return null;
 if(!request.localInternal)throw new NativeError(403,'Χρειάζεται ο εξουσιοδοτημένος Server.');
 const action=u.pathname.slice('/api/server/cloud-backup/'.length),sql=storage.sql;
 if(action==='start'&&request.method==='POST'){
  const old=await storage.get('cloud-business.backup'),id=crypto.randomUUID(),tables=[];
  const schema=rows(sql,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").filter(t=>transferable(t.name)||['fleet_mirror_state','fleet_mirror_changes'].includes(t.name));
  for(const t of schema){const info=rows(sql,`PRAGMA table_xinfo(${sqlName(t.name)})`);if(info.some(c=>c.hidden||c.name==='_backup_source_row')||info.length>99)throw Error('Unsupported backup columns');sql.exec(`CREATE TABLE ${copyName(id,t.name)} AS SELECT _rowid_ AS _backup_source_row,* FROM ${sqlName(t.name)}`);tables.push({name:t.name,sql:t.sql,columns:info.map(c=>c.name),rows:rows(sql,`SELECT COUNT(*) n FROM ${copyName(id,t.name)}`)[0].n});}
  sql.exec(`CREATE TABLE ${copyName(id,'_objects')} AS SELECT * FROM _cloud_objects WHERE deleted=0`);
  const point={schema:1,id,realm:configuration.realm,generation:configuration.generation,capturedAt:new Date().toISOString(),tables,objectCount:rows(sql,`SELECT COUNT(*) n FROM ${copyName(id,'_objects')}`)[0].n,sequences:rows(sql,'SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence')};
  await storage.put('cloud-business.backup',point);
  if(old){for(const t of old.tables)sql.exec(`DROP TABLE IF EXISTS ${copyName(old.id,t.name)}`);sql.exec(`DROP TABLE IF EXISTS ${copyName(old.id,'_objects')}`);}
  return Response.json(point);
 }
 const point=await storage.get('cloud-business.backup');if(!point||point.id!==u.searchParams.get('point'))throw new NativeError(409,'Το σημείο αντιγράφου άλλαξε. Ξεκίνα νέο backup.');
 if(action==='rows'&&request.method==='GET'){
  const table=point.tables.find(t=>t.name===u.searchParams.get('table'));if(!table)throw new NativeError(400,'Μη έγκυρος πίνακας backup.');const after=u.searchParams.get('after');if(after!==null&&!/^-?\d{1,19}$/.test(after))throw new NativeError(400,'Μη έγκυρη θέση backup.');
  const result=[];let last=after,size=0;
  for(let n=0;n<64;n++){
   const r=rows(sql,`SELECT CAST(_backup_source_row AS TEXT) source_row FROM ${copyName(point.id,table.name)} ${last===null?'':'WHERE _backup_source_row>CAST(? AS INTEGER)'} ORDER BY _backup_source_row LIMIT 1`,...(last===null?[]:[last]))[0];if(!r)break;
   const values=storedRow(sql,table,r.source_row,{relation:copyId(point.id,table.name),rowColumn:'_backup_source_row'}),row={rowid:r.source_row,values,hash:await rowDigest(table.name,r.source_row,values)},bytes=new TextEncoder().encode(JSON.stringify(row)).length;if(result.length&&size+bytes>512*1024)break;size+=bytes;result.push(row);last=r.source_row;
  }
  return Response.json({rows:result});
 }
 if(action==='objects'&&request.method==='GET'){
  const after=u.searchParams.get('after')||'',objects=rows(sql,`SELECT key,size,sha256,metadata_json FROM ${copyName(point.id,'_objects')} WHERE key>? ORDER BY key LIMIT 32`,after);return Response.json({objects});
 }
 if(action==='file'&&request.method==='GET'){
  const record=rows(sql,`SELECT object_key FROM ${copyName(point.id,'_objects')} WHERE key=?`,u.searchParams.get('key'))[0],object=record&&await env.SERVICE_DOCS_RAW.get(record.object_key);if(!object)throw new NativeError(404,'Δεν βρέθηκε το ιδιωτικό αρχείο του backup.');return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});
 }
 throw new NativeError(405,'Μη έγκυρη ενέργεια backup.');
}
