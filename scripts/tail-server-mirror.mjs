// Only our own tagged descriptor GETs are observed. No business writes or D1 reads.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {diagnosticError} from './tail-error-safety.mjs';
const key=process.env.FLEET_SERVER_KEY,token=process.env.CLOUDFLARE_API_TOKEN,worker=process.env.FLEET_WORKER_NAME||'fleet-control';
if(!key||!token||worker!=='fleet-control')throw new Error('Diagnostic configuration unavailable');
const base=new URL(process.env.FLEET_WORKER_URL||'https://fleet-control.pavlosargyris.workers.dev');if(base.origin!=='https://fleet-control.pavlosargyris.workers.dev'||base.pathname!=='/')throw new Error('Unexpected diagnostic origin');
const probe=crypto.randomUUID(),report={readOnly:true,checkedAt:new Date().toISOString(),events:[],responses:[]};fs.mkdirSync('verification/mirror-probe',{recursive:true});fs.mkdirSync('.build',{recursive:true});fs.writeFileSync('.build/mirror-tail.json',JSON.stringify({name:worker,compatibility_date:'2026-09-05'}));
const save=()=>fs.writeFileSync('verification/mirror-probe/tail-report.json',JSON.stringify(report,null,2)+'\n');
const safe=value=>diagnosticError(value,[key,token]);
const child=spawn(process.execPath,[path.resolve('cloudflare-worker/node_modules/wrangler/bin/wrangler.js'),'tail',worker,'--config',path.resolve('.build/mirror-tail.json'),'--format','json','--header','X-Fleet-Probe:'+probe],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let connected=false,buffer='',depth=0,inString=false,escaped=false,started=false,exitCode=null;report.stdoutBytes=0;report.stderrBytes=0;
child.on('exit',code=>exitCode=code);child.on('error',()=>{exitCode=-1;});child.stderr.on('data',chunk=>{report.stderrBytes+=chunk.length;const text=chunk.toString();if(/Connected to|waiting for logs|Successfully created tail/i.test(text))connected=true;if(/403|not authorized|Authentication error|permission/i.test(text))report.tailPermissionError=true;});
function event(value){
 const data=value?.data||value,entry=data?.event,request=entry?.request;if(!request)return;const url=new URL(request.url);
 if(url.pathname!=='/api/primary/descriptor'||url.searchParams.get('diagnostic')!==probe)return;
 const row={path:url.pathname,outcome:data.outcome,status:entry.response?.status,cpuTimeMs:data.cpuTime,exceptions:(data.exceptions||[]).map(safe),logs:(data.logs||[]).filter(l=>l.level==='error').map(l=>({level:'error',errors:(Array.isArray(l.message)?l.message:[l.message]).map(safe)}))};
 report.events.push(row);save();console.log(JSON.stringify(row));
}
child.stdout.on('data',chunk=>{report.stdoutBytes+=chunk.length;const text=chunk.toString();if(/Connected to|waiting for logs|Successfully created tail/i.test(text))connected=true;
 for(const char of text){if(!started){if(char!=='{')continue;started=true;depth=0;buffer='';inString=false;escaped=false;}buffer+=char;if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;}else if(char==='"')inString=true;else if(char==='{')depth++;else if(char==='}')depth--;
  if(depth===0&&!inString){try{event(JSON.parse(buffer));}catch{}started=false;buffer='';}if(buffer.length>2000000){started=false;buffer='';}}
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const deadline=Date.now()+20000;while(!connected&&exitCode===null&&Date.now()<deadline)await wait(250);report.tailConnected=connected;save();
 async function get(){
  const response=await fetch(new URL('/api/primary/descriptor?diagnostic='+probe,base),{headers:{'X-Fleet-Server-Key':key,'X-Fleet-Probe':probe,'User-Agent':'Fleet-Control-ReadOnly-Diagnosis'},redirect:'error',signal:AbortSignal.timeout(15000)});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{}
  const row={path:'/api/primary/descriptor',status:response.status,ray:response.headers.get('cf-ray'),bytes:Buffer.byteLength(text)};
  if(response.ok&&['cloud','active','preparing','aborting','recovering','returning'].includes(value?.mode))row.primary={mode:value.mode,connected:value.connected===true,backend:value.backend||null};
  report.responses.push(row);save();console.log(JSON.stringify(row));
 }
 await get();const until=Date.now()+10000;while(!report.events.length&&exitCode===null&&Date.now()<until)await wait(250);
 if(!report.events.length&&exitCode===null){await get();await wait(5000);}
}finally{
 child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);if(exitCode===null)child.kill('SIGKILL');report.tailExitCode=exitCode;report.complete=true;report.causeCaptured=report.events.some(e=>e.exceptions.length||e.logs.length);save();console.log(JSON.stringify({complete:true,tailConnected:connected,causeCaptured:report.causeCaptured,events:report.events.length,responses:report.responses,tailExitCode:exitCode,permissionError:report.tailPermissionError}));
}
if(!report.events.length)process.exitCode=1;
