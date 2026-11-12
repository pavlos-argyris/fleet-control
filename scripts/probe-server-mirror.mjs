// Read-only maintenance probe. Never log credentials, row values or invoice contents.
import fs from 'node:fs';import crypto from 'node:crypto';
import {verifyProbeAuthority,expectedPrimaryFence,verifyProbeWebAsset} from './probe-primary-policy.mjs';
const base=new URL(process.env.FLEET_WORKER_URL||'https://fleet-control.pavlosargyris.workers.dev');
if(base.origin!=='https://fleet-control.pavlosargyris.workers.dev'||base.pathname!=='/')throw new Error('Unexpected diagnostic origin');
const key=process.env.FLEET_SERVER_KEY;if(!key||key.length<24)throw new Error('Existing Server credential required');
const report={checkedAt:new Date().toISOString(),readOnly:true,requests:[],downloads:[]};fs.mkdirSync('verification/mirror-probe',{recursive:true});
const save=()=>fs.writeFileSync('verification/mirror-probe/report.json',JSON.stringify(report,null,2)+'\n');
async function read(path){
 const start=Date.now();let response,text='',value={},record;
 try{response=await fetch(new URL(path,base),{headers:{'X-Fleet-Server-Key':key,'User-Agent':'Fleet-Control-Server/2.2.13','Accept':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});text=await response.text();try{value=JSON.parse(text);}catch{}
  record={path:path.split('?')[0],table:new URL(path,base).searchParams.get('table')||undefined,status:response.status,ray:response.headers.get('cf-ray'),bytes:Buffer.byteLength(text),ms:Date.now()-start,rows:Array.isArray(value.rows)?value.rows.length:undefined,changes:Array.isArray(value.changes)?value.changes.length:undefined,hasMore:value.hasMore,resetRequired:value.resetRequired};
  if(response.ok&&record.path.endsWith('/delta')&&!Array.isArray(value.changes)&&!value.resetRequired)record.invalidResponse=true;
  if(response.ok&&record.table&&!Array.isArray(value.rows))record.invalidResponse=true;
  if(!response.ok)record.error=String(value.error||('Non-JSON response '+response.status)).replaceAll(key,'[REDACTED]').slice(0,300);
 }catch(e){record={path:path.split('?')[0],status:0,error:e.name,ms:Date.now()-start};}
 report.requests.push(record);save();console.log(JSON.stringify(record));return {value,ok:response?.ok===true,response,record};
}
const identity=await read('/api/primary/descriptor');
if(!identity.ok)throw Error('Primary authority descriptor unavailable');
report.primary=await verifyProbeAuthority(identity.value,base.origin);save();
for(const kind of ['client','server']){
 const {value,ok}=await read('/api/'+kind+'-update');if(!ok||!value.available)continue;
 const info={kind,version:value.version,versionCode:value.versionCode,sourceCommit:value.sourceCommit,sha256:value.sha256,sizeBytes:value.sizeBytes};report[kind]=info;save();console.log(JSON.stringify(info));
 const url=new URL(value.downloadUrl);if(url.origin!==base.origin||url.pathname!=='/download/'+kind+'.apk')throw new Error('Unexpected download origin');
 const response=await fetch(url,{headers:{'X-Fleet-Server-Key':key,'User-Agent':'Fleet-Control-Server/2.2.13'},redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok){report.downloads.push({kind,status:response.status});save();continue;}
 const hash=crypto.createHash('sha256');let size=0;for await(const bytes of response.body){hash.update(bytes);size+=bytes.length;if(size>192*1024*1024)throw new Error('Download limit');}const digest=hash.digest('hex'),verified=digest===value.sha256&&size===value.sizeBytes;
 report.downloads.push({kind,status:response.status,size,sha256:digest,verified});save();console.log(JSON.stringify(report.downloads.at(-1)));if(!verified)throw new Error('Downloaded APK does not match metadata');
}
let primaryHealthy=false;
if(report.primary.mode!=='cloud'){
 const fenced=await read('/api/server/system-export/page');
 fenced.record.expectedPrimaryFence=expectedPrimaryFence(fenced.response,fenced.value,identity.value);
 if(!fenced.record.expectedPrimaryFence)throw Error('Native primary writer fence not verified');
 primaryHealthy=report.primary.mode==='active'&&report.primary.connected;save();
}else if(report.primary.backend==='cloud-sqlite'){
 const cloud=await read('/api/status');
 primaryHealthy=cloud.ok&&cloud.value.databaseOk===true&&cloud.response.headers.get('X-Fleet-Cloud-Primary')==='1';save();
}else{
const manifest=await read('/api/server/system-export/page');report.mirrorTables=Array.isArray(manifest.value.tables)?manifest.value.tables.length:0;save();if(manifest.ok&&Array.isArray(manifest.value.tables)){
 const head=manifest.value.mirror;report.mirrorHead=head?{cursor:head.cursor,floor:head.floor}:null;save();
 if(head&&/^[a-f0-9]{32}$/.test(head.epoch))for(const cursor of [...new Set([head.cursor,head.floor||0])])await read('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor);
 for(const table of manifest.value.tables.slice(0,40))if(/^[a-z_]+$/.test(table))await read('/api/server/system-export/page?table='+encodeURIComponent(table)+'&cursor=0&limit=50');
}
primaryHealthy=report.mirrorTables>0;
}
report.primaryHealthy=primaryHealthy;save();
report.complete=false;save();

if(process.env.FLEET_VERIFY_DEPLOYED_SOURCE){
 const expected=process.env.FLEET_VERIFY_DEPLOYED_SOURCE,manifest=JSON.parse(fs.readFileSync('dist/release-manifest.json','utf8'));
 if(!/^[a-f0-9]{40}$/.test(expected)||manifest.sourceCommit!==expected)throw new Error('Unexpected deployment verification source');
 for(const kind of ['client','server']){
  const actual=report[kind],wanted=manifest[kind],download=report.downloads.find(r=>r.kind===kind);
  if(!actual||actual.sourceCommit!==expected||actual.version!==wanted.version||actual.versionCode!==wanted.versionCode||actual.sha256!==wanted.sha256||actual.sizeBytes!==wanted.sizeBytes||!download?.verified)throw new Error('Live '+kind+' does not match the signed build');
 }
 const version=manifest.web.version;report.web=[];
 for(const file of ['portal.html','assets/v'+version+'/app.js','assets/v'+version+'/fleet-operations.js']){
  report.web.push(await verifyProbeWebAsset(base,file,manifest.web.files.find(item=>item.path===file)));save();
 }
}
const failedRequests=report.requests.filter(r=>!r.expectedPrimaryFence&&(r.status<200||r.status>=300||r.invalidResponse));
if(process.env.FLEET_REQUIRE_HEALTHY_MIRROR==='true'&&(!primaryHealthy||failedRequests.length))throw new Error('Live authoritative data route probe did not pass');
save();

report.complete=true;save();console.log(JSON.stringify({complete:true,primary:report.primary,primaryHealthy,failedRequests,deliverySource:report.client?.sourceCommit,serverSource:report.server?.sourceCommit,downloadsVerified:report.downloads.length===2&&report.downloads.every(r=>r.verified),webVerified:report.web?.every(r=>r.verified)}));
