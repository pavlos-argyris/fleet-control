import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';
const root=process.cwd(),temp=path.join(root,'.build','static-routing-test');fs.mkdirSync(temp,{recursive:true});const config=JSON.parse(fs.readFileSync('cloudflare-worker/wrangler.example.jsonc','utf8'));
config.name='fleet-static-routing-fixture';config.main=path.join(root,'cloudflare-worker/src/worker.js');config.assets.directory=path.join(root,'cloudflare-worker/public');delete config.ai;delete config.triggers;config.observability={enabled:false};config.d1_databases[0].database_id='00000000-0000-0000-0000-000000000001';config.vars={SERVER_KEY:'static-fixture-key',PIN_PEPPER:'static-fixture-pepper'};
fs.writeFileSync(path.join(temp,'wrangler.jsonc'),JSON.stringify(config));
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const child=spawn(path.join(root,'cloudflare-worker/node_modules/.bin/wrangler'),['dev','--local','--config',path.join(temp,'wrangler.jsonc'),'--ip','127.0.0.1','--port',String(port),'--persist-to',path.join(temp,'state')],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
try{
 let ready=false;const base='http://127.0.0.1:'+port,version=JSON.parse(fs.readFileSync('release-config.json','utf8')).web.version;
 for(let i=0;i<45;i++){try{const r=await fetch(base+'/assets/v'+version+'/app.js',{signal:AbortSignal.timeout(1000)});if(r.status===200){ready=true;break;}}catch{}if(child.exitCode!=null)break;await new Promise(r=>setTimeout(r,500));}
 assert.ok(ready,'Local static routing did not start: '+log.slice(-3500));
 let r=await fetch(base+'/assets/v'+version+'/app.js');assert.equal(r.status,200);assert.ok(!(r.headers.get('Server-Timing')||'').includes('worker;dur='),'Static JS must bypass the Worker');assert.match(r.headers.get('Cache-Control'),/immutable/);assert.equal(await r.text(),fs.readFileSync('cloudflare-worker/public/app.js','utf8'));
 for(const previous of ['5.51.0','5.49.0']){const name='/assets/v'+previous+'/app.js';r=await fetch(base+name);assert.equal(r.status,200);assert.equal(await r.text(),fs.readFileSync('cloudflare-worker/public'+name,'utf8'));assert.ok(!(r.headers.get('Server-Timing')||'').includes('worker;dur='),'Historical static URL still bypasses Worker');}
 r=await fetch(base+'/assets/v'+version+'/missing-private.json');assert.equal(r.status,404,'Missing asset never reveals the protected HTML');
 r=await fetch(base+'/index.html',{redirect:'manual'});assert.equal(r.status,302,'Protected Fleet HTML still checks login');
 r=await fetch(base+'/api/status');assert.equal(r.status,200);assert.ok(r.headers.get('Server-Timing'));assert.equal((await r.json()).databaseOk,true);
 console.log('OK actual Wrangler asset routing: immutable JS bypasses Worker, missing file 404, protected Fleet HTML retains login, API retains Worker authorization path.');
}finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode==null)child.kill('SIGKILL');fs.rmSync(temp,{recursive:true,force:true});}
