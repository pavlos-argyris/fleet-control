// Read-only maintenance probe. Never log credentials, row values or invoice contents.
import fs from 'node:fs';import crypto from 'node:crypto';
const base=new URL(process.env.FLEET_WORKER_URL||'https://fleet-control.pavlosargyris.workers.dev');
if(base.origin!=='https://fleet-control.pavlosargyris.workers.dev'||base.pathname!=='/')throw new Error('Unexpected diagnostic origin');
const key=process.env.FLEET_SERVER_KEY;if(!key||key.length<24)throw new Error('Existing Server credential required');
const report={checkedAt:new Date().toISOString(),readOnly:true,requests:[],downloads:[]};fs.mkdirSync('verification/mirror-probe',{recursive:true});
const save=()=>fs.writeFileSync('verification/mirror-probe/report.json',JSON.stringify(report,null,2)+'\n');
async function read(path){
 const start=Date.now();let response,text='',value={},record;
 try{response=await fetch(new URL(path,base),{headers:{'X-Fleet-Server-Key':key,'User-Agent':'Fleet-Control-Server/2.2.13','Accept':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});text=await response.text();try{value=JSON.parse(text);}catch{}
  record={path:path.split('?')[0],table:new URL(path,base).searchParams.get('table')||undefined,status:response.status,ray:response.headers.get('cf-ray'),bytes:Buffer.byteLength(text),ms:Date.now()-start,rows:Array.isArray(value.rows)?value.rows.length:undefined,changes:Array.isArray(value.changes)?value.changes.length:undefined,hasMore:value.hasMore,resetRequired:value.resetRequired};
  if(!response.ok)record.error=String(value.error||('Non-JSON response '+response.status)).replaceAll(key,'[REDACTED]').slice(0,300);
 }catch(e){record={path:path.split('?')[0],status:0,error:e.name,ms:Date.now()-start};}
 report.requests.push(record);save();console.log(JSON.stringify(record));return {value,ok:response?.ok===true};
}
if(process.env.FLEET_PROBE_D1_ONLY!=='true'){
for(const kind of ['client','server']){
 const {value,ok}=await read('/api/'+kind+'-update');if(!ok||!value.available)continue;
 const info={kind,version:value.version,versionCode:value.versionCode,sourceCommit:value.sourceCommit,sha256:value.sha256,sizeBytes:value.sizeBytes};report[kind]=info;save();console.log(JSON.stringify(info));
 const url=new URL(value.downloadUrl);if(url.origin!==base.origin||url.pathname!=='/download/'+kind+'.apk')throw new Error('Unexpected download origin');
 const response=await fetch(url,{headers:{'X-Fleet-Server-Key':key,'User-Agent':'Fleet-Control-Server/2.2.13'},redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok){report.downloads.push({kind,status:response.status});save();continue;}
 const hash=crypto.createHash('sha256');let size=0;for await(const bytes of response.body){hash.update(bytes);size+=bytes.length;if(size>50*1024*1024)throw new Error('Download limit');}const digest=hash.digest('hex'),verified=digest===value.sha256&&size===value.sizeBytes;
 report.downloads.push({kind,status:response.status,size,sha256:digest,verified});save();console.log(JSON.stringify(report.downloads.at(-1)));if(!verified)throw new Error('Downloaded APK does not match metadata');
}
const manifest=await read('/api/server/system-export/page');if(manifest.ok&&Array.isArray(manifest.value.tables)){
 const head=manifest.value.mirror;report.mirrorHead=head?{cursor:head.cursor,floor:head.floor}:null;save();
 if(head&&/^[a-f0-9]{32}$/.test(head.epoch))for(const cursor of [...new Set([head.cursor,head.floor||0])])await read('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor);
 for(const table of manifest.value.tables.slice(0,40))if(/^[a-z_]+$/.test(table))await read('/api/server/system-export/page?table='+encodeURIComponent(table)+'&cursor=0&limit=50');
}
}
report.complete=true;save();console.log(JSON.stringify({complete:true,failedRequests:report.requests.filter(r=>r.status<200||r.status>=300),deliverySource:report.client?.sourceCommit,serverSource:report.server?.sourceCommit}));

// Optional database diagnosis uses SELECT/PRAGMA only. Results containing row
// values remain in memory; only counts, table names and SQL errors are retained.
const apiToken=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID,database=process.env.FLEET_D1_DATABASE_ID;
if(apiToken&&/^[a-f0-9]{32}$/i.test(account||'')&&/^[a-f0-9-]{36}$/i.test(database||'')){
 report.d1=[];
 const sanitize=s=>String(s).replaceAll(key,'[REDACTED]').replaceAll(apiToken,'[REDACTED]').slice(0,600);
 async function sql(label,query,params=[]){
  if(!/^(SELECT\b|PRAGMA table_info\([a-z_]+\)$)/i.test(query)||query.includes(';'))throw new Error('Non-read-only statement rejected');
  const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+database+'/query',{method:'POST',headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},body:JSON.stringify({sql:query,params:params.map(String)}),redirect:'error',signal:AbortSignal.timeout(30000)});
  const body=await response.json(),result=body.result?.[0];
  const record={label,status:response.status,success:body.success===true&&result?.success!==false,rows:result?.results?.length,rowsWritten:result?.meta?.rows_written,changed:result?.meta?.changed_db};
  if(!record.success)record.error=sanitize(JSON.stringify(body.errors||result?.error||'SQL request failed'));
  report.d1.push(record);save();console.log(JSON.stringify(record));if(!record.success)throw new Error(record.error);if(record.changed||Number(record.rowsWritten||0)>0)throw new Error('Unexpected writes in read-only diagnosis');return result?.results||[];
 }
 try{
  const [head]=await sql('mirror-head',"SELECT epoch,floor,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='fleet_mirror_changes'),0) AS cursor FROM fleet_mirror_state WHERE id=1");
  const page=await sql('journal-first-page','SELECT seq,table_name,row_id FROM fleet_mirror_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT 20',[head.floor,head.cursor]);
  for(const table of new Set(page.map(r=>r.table_name))){
   if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected table identifier');
   const columns=await sql('columns:'+table,'PRAGMA table_info('+table+')');
   const selected=page.filter(r=>r.table_name===table),fields=columns.flatMap(c=>["'"+c.name.replaceAll("'","''")+"'",'t."'+c.name.replaceAll('"','""')+'"']).join(','),source=selected.map(()=>`SELECT ? AS row_id,? AS seq`).join(' UNION ALL ');
   try{
    const [row]=await sql('delta-json:'+table,`SELECT COALESCE(json_group_array(json_object('table','${table}','rowId',c.row_id,'seq',c.seq,'row',CASE WHEN t.rowid IS NULL THEN NULL ELSE json_object(${fields}) END)),'[]') AS data FROM (${source}) c LEFT JOIN ${table} t ON t.rowid=c.row_id`,selected.flatMap(r=>[r.row_id,r.seq]));
    const summary={table,columns:columns.length,selected:selected.length,jsonBytes:Buffer.byteLength(row?.data||'[]'),returned:JSON.parse(row?.data||'[]').length};report.d1.push(summary);save();console.log(JSON.stringify(summary));
   }catch(e){console.log(JSON.stringify({table,sqlFailure:sanitize(e.message)}));}
  }
 }catch(e){report.d1Error=sanitize(e.message);save();console.log(JSON.stringify({d1Error:report.d1Error}));}
}
