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
report.complete=true;save();console.log(JSON.stringify({complete:true,failedRequests:report.requests.filter(r=>r.status<200||r.status>=300),deliverySource:report.client?.sourceCommit,serverSource:report.server?.sourceCommit}));
