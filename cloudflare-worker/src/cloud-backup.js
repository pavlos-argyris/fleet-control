import {sqlName,storedRow,rowDigest} from './cloud-transfer.js';
import {NativeError} from '../../server-runtime/common.js';
import {getBackupJson,compareObjectKeys} from './cloud-backup-pages.js';
import {trackedBackup,advanceTrackedBackup} from './cloud-backup-tracking.js';

const CURRENT='cloud-business.backup',PENDING='cloud-business.backup.pending';
const rows=(sql,q,...args)=>Array.from(sql.exec(q,...args));
const copyId=(id,name)=>'_cloud_backup_'+id.replaceAll('-','')+'_'+name;
const copyName=(id,name)=>sqlName(copyId(id,name));
const status=job=>({pending:true,job:job.id,tablesDone:job.tables.filter(t=>t.complete).length,tablesTotal:job.tables.length,rowsCaptured:job.tables.reduce((n,t)=>n+t.rows,0),objectsCaptured:job.objects.count});
async function currentPoint(storage,bucket,id){
 const pointer=await storage.get(CURRENT);if(!pointer||id&&pointer.id!==id)throw new NativeError(409,'Το σημείο αντιγράφου άλλαξε. Ξεκίνα νέο backup.');
 if(pointer.schema!==2)return{point:pointer,legacy:true};
 const result=await getBackupJson(bucket,pointer.ref);if(result.point.id!==pointer.id)throw Error('Backup manifest identity changed');return result;
}
async function begin(storage,bucket,configuration){
 const pointer=await storage.get(PENDING);
 if(pointer){const job=await getBackupJson(bucket,pointer.ref);if(job.realm===configuration.realm&&job.generation===configuration.generation)return job;throw new NativeError(409,'Άλλαξε η πηγή του εκκρεμούς backup.');}
 return trackedBackup(storage,bucket,configuration);
}
function afterRow(u){const after=u.searchParams.get('after');if(after!==null&&(!/^-?\d{1,19}$/.test(after)||BigInt(after)<-9223372036854775808n||BigInt(after)>9223372036854775807n))throw new NativeError(400,'Μη έγκυρη θέση backup.');return after;}
async function legacyRead(action,u,storage,env,point){
 // Existing verified SQL points remain readable. No new clone is created and
 // no old clone/canonical table or original R2 file is removed by this update.
 const sql=storage.sql;
 if(action==='rows'){
  const table=point.tables.find(t=>t.name===u.searchParams.get('table'));if(!table)throw new NativeError(400,'Μη έγκυρος πίνακας backup.');const after=afterRow(u),result=[];let last=after,size=0;
  for(let n=0;n<64;n++){const r=rows(sql,`SELECT CAST(_backup_source_row AS TEXT) source_row FROM ${copyName(point.id,table.name)} ${last===null?'':'WHERE _backup_source_row>CAST(? AS INTEGER)'} ORDER BY _backup_source_row LIMIT 1`,...(last===null?[]:[last]))[0];if(!r)break;const values=storedRow(sql,table,r.source_row,{relation:copyId(point.id,table.name),rowColumn:'_backup_source_row'}),row={rowid:r.source_row,values,hash:await rowDigest(table.name,r.source_row,values)},bytes=new TextEncoder().encode(JSON.stringify(row)).length;if(result.length&&size+bytes>512*1024)break;result.push(row);last=r.source_row;size+=bytes;}return Response.json({rows:result});
 }
 if(action==='objects')return Response.json({objects:rows(sql,`SELECT key,size,sha256,metadata_json FROM ${copyName(point.id,'_objects')} WHERE key>? ORDER BY key LIMIT 32`,u.searchParams.get('after')||'')});
 const record=rows(sql,`SELECT object_key FROM ${copyName(point.id,'_objects')} WHERE key=?`,u.searchParams.get('key'))[0];return fileResponse(env,record);
}
async function fileResponse(env,record){const object=record&&await env.SERVICE_DOCS_RAW.get(record.object_key);if(!object)throw new NativeError(404,'Δεν βρέθηκε το ιδιωτικό αρχείο του backup.');return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});}

/** Immutable private R2 pages, not full SQL clones. Only bounded job pointers
 * and temporary dirty-block markers are written to Durable Objects. Failed/incomplete captures never replace the
 * previous consistent point. Caller MUST hold the CloudBusiness event fence. */
export async function routeCloudBackup(request,env,configuration,storage){
 const u=new URL(request.url);if(!u.pathname.startsWith('/api/server/cloud-backup/'))return null;
 if(!request.localInternal)throw new NativeError(403,'Χρειάζεται ο εξουσιοδοτημένος Server.');
 const action=u.pathname.slice('/api/server/cloud-backup/'.length),bucket=env.SERVICE_DOCS_RAW;
 if(['start','continue'].includes(action)&&request.method==='POST'){
  if(!bucket)throw new NativeError(503,'Δεν είναι διαθέσιμο το ιδιωτικό cloud backup.');
  let body;try{body=await request.json();}catch{throw new NativeError(400,'Μη έγκυρο αίτημα backup.');}
  if(!body||typeof body!=='object'||Array.isArray(body)||action==='continue'&&!/^[a-f0-9-]{36}$/.test(body.job||''))throw new NativeError(400,'Μη έγκυρη εργασία backup.');
  let job;
  if(action==='continue'){
   const pointer=await storage.get(PENDING);
   if(!pointer||pointer.id!==body.job){const saved=await currentPoint(storage,bucket,body.job);return Response.json(saved.point);}
   job=await getBackupJson(bucket,pointer.ref);
  }else job=await begin(storage,bucket,configuration);
  if(job.realm!==configuration.realm||job.generation!==configuration.generation)throw new NativeError(409,'Άλλαξε η πηγή του backup Cloudflare.');
  if(action==='start'&&body.protocol===2)return Response.json(status(job),{status:202});
  // Old installed Servers can finish small points with their existing call.
  // A large point resumes on the next attempt; it never falls back to stale
  // phone data or recreates a quota-expensive SQL clone before an OTA update.
  const point=await advanceTrackedBackup(storage,bucket,configuration,job);if(point)return Response.json(point);
  if(body.protocol===2||action==='continue')return Response.json(status(job),{status:202});
  return Response.json({error:'Το backup προετοιμάζεται σταδιακά. Δοκίμασε ξανά ή εγκατάστησε τη νεότερη έκδοση Server για αυτόματη συνέχεια.',code:'cloud_backup_pending',...status(job)},{status:409});
 }
 if(!['rows','objects','file'].includes(action)||request.method!=='GET')throw new NativeError(405,'Μη έγκυρη ενέργεια backup.');
 if(!/^[a-f0-9-]{36}$/.test(u.searchParams.get('point')||''))throw new NativeError(400,'Μη έγκυρο σημείο backup.');
 const saved=await currentPoint(storage,bucket,u.searchParams.get('point'));if(saved.legacy)return legacyRead(action,u,storage,env,saved.point);
 if(action==='rows'){
  const table=saved.tables.find(t=>t.name===u.searchParams.get('table'));if(!table)throw new NativeError(400,'Μη έγκυρος πίνακας backup.');const after=afterRow(u),ref=table.pages.find(p=>after===null||BigInt(p.last)>BigInt(after));
  const page=ref?await getBackupJson(bucket,ref):{rows:[]};return Response.json({rows:page.rows.filter(r=>after===null||BigInt(r.rowid)>BigInt(after))});
 }
 const key=u.searchParams.get(action==='file'?'key':'after')||'',ref=saved.objects.pages.find(p=>action==='file'?compareObjectKeys(p.first,key)<=0&&compareObjectKeys(p.last,key)>=0:compareObjectKeys(p.last,key)>0),page=ref?await getBackupJson(bucket,ref):{objects:[]};
 if(action==='file')return fileResponse(env,page.objects.find(o=>o.key===key));
 return Response.json({objects:page.objects.filter(o=>compareObjectKeys(o.key,key)>0).map(({object_key,...o})=>o)});
}
