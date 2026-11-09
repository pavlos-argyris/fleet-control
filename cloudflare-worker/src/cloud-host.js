import {cloudPdf,cloudXlsx} from './cloud-financial-export.js';
import {NativeError} from '../../server-runtime/common.js';
/** Persistent documents use immutable keys in the existing private bucket.
 * Old R2 objects are never overwritten or removed by a cloud handover. */
export function cloudDocumentBucket(bucket,db,id){return{
 async get(key){const mapped=await db.prepare('SELECT object_key,metadata_json,deleted FROM _cloud_objects WHERE key=?').bind(key).first();if(mapped?.deleted)return null;const object=await bucket.get(mapped?.object_key||key);if(!object||!mapped)return object;const meta=JSON.parse(mapped.metadata_json);return{key:object.key,size:object.size,version:object.version,etag:object.etag,httpEtag:object.httpEtag,uploaded:object.uploaded,checksums:object.checksums,range:object.range,body:object.body,arrayBuffer:()=>object.arrayBuffer(),text:()=>object.text(),json:()=>object.json(),httpMetadata:meta.httpMetadata||{},customMetadata:meta.customMetadata||{},writeHttpMetadata(headers){for(const[k,v]of Object.entries(meta.httpMetadata||{}))headers.set(k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v);}};},
 async put(key,value,options={}){const target='cloud-primary/'+id+'/new/'+crypto.randomUUID()+'/'+key;const saved=await bucket.put(target,value,options);if(!saved)throw Error('Document write was not confirmed');await db.prepare('INSERT INTO _cloud_objects(key,size,sha256,object_key,metadata_json) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,object_key=excluded.object_key,metadata_json=excluded.metadata_json,deleted=0').bind(key,saved.size||0,'',target,JSON.stringify({httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}})).run();return saved;},
 async head(key){const r=await db.prepare('SELECT object_key,metadata_json,deleted FROM _cloud_objects WHERE key=?').bind(key).first();return r?.deleted?null:bucket.head(r?.object_key||key);},
 async delete(key){
  // Native handlers use logical deletion/archive before object collection.
  // Keep source bytes, including the original D1/R2 copy, for recovery.
  await db.prepare('UPDATE _cloud_objects SET deleted=1 WHERE key=?').bind(key).run();
 }
};}
export async function cloudHost(command,value,{configuration,env}){
 if(command==='health.snapshot'){const health={...configuration.health,at:new Date().toISOString()};if(!Number.isFinite(Date.parse(health.serverLastSeenAt))||Date.now()-Date.parse(health.serverLastSeenAt)>600000)delete health.freeBytes;return health;}
 if(command==='reports.export'){
  if(value.format==='xlsx')return cloudXlsx(value.spec);
  if(value.format==='pdf'){const response=await env.ASSETS.fetch(new Request('https://assets.internal/fonts/LiberationSans-Regular.ttf'));if(!response.ok)throw Error('The bundled report font is unavailable');return cloudPdf(value.spec,await response.arrayBuffer());}
  throw new NativeError(400,'Επίλεξε Excel ή PDF.');
 }
 if(command.startsWith('file')||command.startsWith('files.'))throw new NativeError(410,'Η προσωρινή μεταφορά αρχείου έληξε μετά την αλλαγή κύριας βάσης. Επίλεξε ξανά το αρχείο.');
 throw Error('Cloud business host service is unavailable');
}
