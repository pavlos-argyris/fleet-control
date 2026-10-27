// Only our own diagnostic requests are observed. Raw events and headers are never saved.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
const key=process.env.FLEET_SERVER_KEY,token=process.env.CLOUDFLARE_API_TOKEN,worker=process.env.FLEET_WORKER_NAME||'fleet-control';
if(!key||!token||worker!=='fleet-control')throw new Error('Diagnostic configuration unavailable');
const base=new URL(process.env.FLEET_WORKER_URL||'https://fleet-control.pavlosargyris.workers.dev');if(base.origin!=='https://fleet-control.pavlosargyris.workers.dev')throw new Error('Unexpected diagnostic origin');
const probe=crypto.randomUUID(),report={readOnly:true,checkedAt:new Date().toISOString(),events:[],responses:[]};fs.mkdirSync('verification/mirror-probe',{recursive:true});fs.mkdirSync('.build',{recursive:true});fs.writeFileSync('.build/mirror-tail.json',JSON.stringify({name:worker,compatibility_date:'2026-09-05'}));
const save=()=>fs.writeFileSync('verification/mirror-probe/tail-report.json',JSON.stringify(report,null,2)+'\n');
const sanitize=s=>String(s).replaceAll(key,'[REDACTED]').replaceAll(token,'[REDACTED]').replace(/wss?:\/\/\S+/g,'[TAIL URL REDACTED]').slice(0,1200);
const child=spawn(process.execPath,[path.resolve('cloudflare-worker/node_modules/wrangler/bin/wrangler.js'),'tail',worker,'--config',path.resolve('.build/mirror-tail.json'),'--format','json','--header','X-Fleet-Probe:'+probe],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let connected=false,buffer='',depth=0,inString=false,escaped=false,started=false,exitCode=null;
child.on('exit',code=>exitCode=code);child.on('error',()=>{exitCode=-1;});child.stderr.on('data',()=>{});
function event(value){const request=value?.event?.request;if(!request)return;const url=new URL(request.url);if(url.pathname!=='/api/server/system-export/delta'||url.searchParams.get('diagnostic')!==probe)return;
 const row={path:url.pathname,outcome:value.outcome,status:value.event.response?.status,cpuTimeMs:value.cpuTime,exceptions:(value.exceptions||[]).map(e=>sanitize(e.message)),logs:(value.logs||[]).filter(l=>l.level==='error').map(l=>({level:l.level,message:(l.message||[]).map(sanitize)}))};
 report.events.push(row);save();console.log(JSON.stringify(row));
}
child.stdout.on('data',chunk=>{const text=chunk.toString();if(/Connected to|waiting for logs/i.test(text))connected=true;
 for(const char of text){if(!started){if(char!=='{')continue;started=true;depth=0;buffer='';inString=false;escaped=false;}buffer+=char;if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;}else if(char==='"')inString=true;else if(char==='{')depth++;else if(char==='}')depth--;
  if(depth===0&&!inString){try{event(JSON.parse(buffer));}catch{}started=false;buffer='';}if(buffer.length>2000000){started=false;buffer='';}}
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const deadline=Date.now()+30000;while(!connected&&exitCode===null&&Date.now()<deadline)await wait(250);report.tailConnected=connected;save();
 async function get(relative){const response=await fetch(new URL(relative,base),{headers:{'X-Fleet-Server-Key':key,'X-Fleet-Probe':probe,'User-Agent':'Fleet-Control-Server/2.2.13'},redirect:'error',signal:AbortSignal.timeout(20000)});const text=await response.text();report.responses.push({path:relative.split('?')[0],status:response.status,ray:response.headers.get('cf-ray')});save();return JSON.parse(text);}
 const manifest=await get('/api/server/system-export/page'),head=manifest.mirror;if(head&&/^[a-f0-9]{32}$/.test(head.epoch)){
  const relative='/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+(head.floor||0)+'&diagnostic='+probe;await get(relative);
  const until=Date.now()+15000;while(!report.events.length&&exitCode===null&&Date.now()<until)await wait(250);
  if(!report.events.length&&exitCode===null){await get(relative);await wait(5000);}
 }
}finally{
 child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);if(exitCode===null)child.kill('SIGKILL');report.tailExitCode=exitCode;report.complete=true;save();console.log(JSON.stringify({complete:true,tailConnected:connected,events:report.events.length,responses:report.responses,tailExitCode:exitCode}));
}
