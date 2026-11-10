import {transferable,rowDigest,sqlName} from './cloud-transfer.js';
import {directHash} from './direct-relay.js';
import {NativeError} from '../../server-runtime/common.js';

const rows=(sql,q,...args)=>Array.from(sql.exec(q,...args));
const encoded=new TextEncoder(),PAGE_BYTES=512*1024;
export const backupRows=(sql,table,after=null)=>{
 // Estimate first, so a group of large cells cannot materialize64 huge rows.
 // Then read column groups below the SQLite-DO100-result-column limit.
 // JSON quoting can expand control characters sixfold. Measure encoded text;
 // BLOB values use hexadecimal. Keep large individual cells bounded too.
 let terms=table.columns.map(c=>{const q=sqlName(c);return `CASE typeof(${q}) WHEN 'blob' THEN length(${q})*2 WHEN 'null' THEN 4 ELSE length(CAST(json_quote(CAST(${q} AS TEXT)) AS BLOB)) END`;});
 // Balance additions: a left-deep99-column sum exceeds DO expression depth100.
 while(terms.length>1)terms=Array.from({length:Math.ceil(terms.length/2)},(_,i)=>terms[i*2+1]?`(${terms[i*2]}+${terms[i*2+1]})`:terms[i*2]);
 const sizes=terms[0];
 const ids=rows(sql,`SELECT CAST(_rowid_ AS TEXT) source_row,${sizes} bytes FROM ${sqlName(table.name)} ${after===null?'':'WHERE _rowid_>CAST(? AS INTEGER)'} ORDER BY _rowid_ LIMIT 64`,...(after===null?[]:[after]));
 let bytes=0;const selected=[];
 for(const id of ids){const estimate=Number(id.bytes)+table.columns.length*48+100;if(selected.length&&bytes+estimate>PAGE_BYTES)break;if(estimate>12*1024*1024)throw new NativeError(413,'Μία εγγραφή είναι πολύ μεγάλη για ασφαλές cloud backup.');selected.push({rowid:id.source_row,values:[]});bytes+=estimate;}
 if(!selected.length)return [];
 for(let offset=0;offset<table.columns.length;offset+=40){
  const columns=table.columns.slice(offset,offset+40),fields=columns.flatMap((c,i)=>{const q=sqlName(c);return [`typeof(${q}) t${i}`,`CASE typeof(${q}) WHEN 'null' THEN NULL WHEN 'blob' THEN hex(${q}) WHEN 'real' THEN printf('%!.17g',${q}) ELSE CAST(${q} AS TEXT) END v${i}`];});
  const part=rows(sql,`SELECT CAST(_rowid_ AS TEXT) source_row,${fields.join(',')} FROM ${sqlName(table.name)} WHERE _rowid_>=CAST(? AS INTEGER) AND _rowid_<=CAST(? AS INTEGER) ORDER BY _rowid_`,selected[0].rowid,selected.at(-1).rowid);
  if(part.length!==selected.length||part.some((r,i)=>r.source_row!==selected[i].rowid))throw Error('Backup read changed inside serialized operation');
  for(let i=0;i<part.length;i++)selected[i].values.push(...columns.map((_,c)=>[part[i]['t'+c],part[i]['v'+c]]));
 }
 return selected;
};
export async function typedBackupPage(sql,table,after=null){
 const result=backupRows(sql,table,after);for(const row of result)row.hash=await rowDigest(table.name,row.rowid,row.values);return {rows:result};
}
export function backupSchema(sql){
 return rows(sql,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").filter(t=>transferable(t.name)||['fleet_mirror_state','fleet_mirror_changes'].includes(t.name)).map(t=>{
  const info=rows(sql,`PRAGMA table_xinfo(${sqlName(t.name)})`);
  if(!info.length||info.some(c=>c.hidden)||info.length>99)throw Error('Unsupported backup columns');
  return {...t,columns:info.map(c=>c.name)};
 });
}
export const backupSequences=sql=>rows(sql,"SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").length?rows(sql,'SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence ORDER BY name'):[];
export const objectPage=(sql,after='')=>({objects:rows(sql,'SELECT key,size,sha256,metadata_json,object_key FROM _cloud_objects WHERE deleted=0 AND key>? ORDER BY key LIMIT 32',after)});
export const jsonHash=value=>directHash(JSON.stringify(value));
export async function putBackupJson(bucket,prefix,value){
 const body=JSON.stringify(value),sha256=await directHash(body),key=prefix+'/'+sha256;
 // Reuse immutable content from earlier points. A missing page is recreated;
 // no existing private document or canonical record is overwritten/deleted.
 if(!await bucket.head(key)){const saved=await bucket.put(key,body,{httpMetadata:{contentType:'application/json'},sha256});if(!saved)throw Error('Backup page was not stored');}
 return {key,sha256};
}
export async function getBackupJson(bucket,ref){
 const object=ref&&await bucket.get(ref.key);if(!object)throw new NativeError(409,'Λείπει σελίδα από το ιδιωτικό cloud backup.');
 const body=await object.text();if(await directHash(body)!==ref.sha256)throw new NativeError(409,'Δεν συμφωνεί το αποτύπωμα σελίδας cloud backup.');return JSON.parse(body);
}
export function compareObjectKeys(a,b){
 // SQLite BINARY order is UTF-8 byte order, including astral Unicode names.
 const x=encoded.encode(a),y=encoded.encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;
}
