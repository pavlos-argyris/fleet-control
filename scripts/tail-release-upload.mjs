// Observe only this publication's routes. Never persist raw events, headers or credentials.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const worker=process.env.FLEET_WORKER_NAME||'fleet-control',token=process.env.CLOUDFLARE_API_TOKEN,releaseToken=process.env.FLEET_RELEASE_TOKEN;
if(worker!=='fleet-control'||!token||!releaseToken)throw new Error('Diagnostic configuration unavailable');
const report={readOnly:true,startedAt:new Date().toISOString(),events:[],stderrBytes:0,stdoutBytes:0};fs.mkdirSync('verification/mirror-probe',{recursive:true});fs.mkdirSync('.build',{recursive:true});
fs.writeFileSync('.build/release-tail.json',JSON.stringify({name:worker,compatibility_date:'2026-09-05'}));
const save=()=>fs.writeFileSync('verification/mirror-probe/release-tail.json',JSON.stringify(report,null,2)+'\n');
const clean=v=>String(v).replaceAll(token,'[REDACTED]').replaceAll(releaseToken,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/wss?:\/\/\S+/g,'[TAIL URL REDACTED]').slice(0,1000);
const child=spawn(process.execPath,[path.resolve('cloudflare-worker/node_modules/wrangler/bin/wrangler.js'),'tail',worker,'--config',path.resolve('.build/release-tail.json'),'--format','json'],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let buffer='',depth=0,inString=false,escaped=false,started=false,exitCode=null;
child.on('error',()=>exitCode=-1);child.on('exit',code=>exitCode=code);
child.stderr.on('data',chunk=>{report.stderrBytes+=chunk.length;if(/403|not authorized|Authentication error|permission/i.test(chunk.toString()))report.permissionError=true;});
function observe(value){
 const event=value?.event||value?.data?.event,request=event?.request;if(!request?.url)return;
 let url;try{url=new URL(request.url);}catch{return;}
 if(url.origin!=='https://fleet-control.pavlosargyris.workers.dev'||!(url.pathname.startsWith('/api/deploy/releases/v5.60.0-83cc81e78dcd/')||url.pathname==='/api/deploy/releases/activate'))return;
 const row={at:new Date().toISOString(),path:url.pathname,method:request.method,status:event.response?.status,outcome:value.outcome||value.data?.outcome,cpuTime:value.cpuTime||value.data?.cpuTime,exceptions:(value.exceptions||value.data?.exceptions||[]).map(e=>clean(e.message)),errors:(value.logs||value.data?.logs||[]).filter(l=>l.level==='error').map(l=>(l.message||[]).map(clean))};
 report.events.push(row);save();console.log(JSON.stringify(row));
}
child.stdout.on('data',chunk=>{report.stdoutBytes+=chunk.length;
 for(const char of chunk.toString()){
  if(!started){if(char!=='{')continue;started=true;depth=0;buffer='';inString=false;escaped=false;}
  buffer+=char;
  if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;}else if(char==='"')inString=true;else if(char==='{')depth++;else if(char==='}')depth--;
  if(depth===0&&!inString){try{observe(JSON.parse(buffer));}catch{}started=false;buffer='';}
  if(buffer.length>2000000){started=false;buffer='';}
 }
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{const until=Date.now()+190000;while(exitCode===null&&Date.now()<until)await wait(1000);}
finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);if(exitCode===null)child.kill('SIGKILL');report.exitCode=exitCode;report.complete=true;save();console.log(JSON.stringify({complete:true,events:report.events.length,permissionError:!!report.permissionError,stdoutBytes:report.stdoutBytes,stderrBytes:report.stderrBytes}));}
