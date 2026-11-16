import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DIRECT_ORIGIN} from '../cloudflare-worker/src/redirect.js';
const github='https://github.com/pavlos-argyris/fleet-control';
export async function verifyRedirect(origin,fetcher=fetch){
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname.endsWith('.workers.dev'))throw Error('Expected the former HTTPS workers.dev origin.');
  const checks=[];
  for(const [method,route]of [['GET','/'],['HEAD','/assets/old.js?token=discard-this-fixture'],['GET','/api/status?redirect=https://wrong.invalid'],['POST','/api/auth/user-login'],['PUT','/api/deploy/releases/fixture/client.apk'],['DELETE','/api/sync'],['OPTIONS','/api/native/cash']]){
    const response=await fetcher(new URL(route,url),{method,redirect:'manual',signal:AbortSignal.timeout(30000)});
    const read=method==='GET'||method==='HEAD';
    if(read?(response.status!==302||response.headers.get('location')!==DIRECT_ORIGIN+'/'):(response.status!==410||response.headers.has('location')))throw Error('Redirect-only verification failed: '+method+' '+new URL(route,url).pathname);
    if(response.headers.has('set-cookie')||response.headers.get('cache-control')!=='no-store'||response.headers.get('referrer-policy')!=='no-referrer')throw Error('Unexpected redirect session/cache policy');
    await response.body?.cancel();checks.push({method,path:new URL(route,url).pathname,status:response.status});
  }
  return checks;
}
async function publicBytes(url,max,fetcher){
  const response=await fetcher(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Public release download failed: HTTP '+response.status);
  const chunks=[];let length=0;for await(const value of response.body){length+=value.length;if(length>max)throw Error('Public release file exceeds its bound');chunks.push(value);}return Buffer.concat(chunks);
}
export async function verifyDirectPublication({manifest,workerOrigin,downloads=true,dist='dist',fetcher=fetch}){
  if(!manifest||manifest.publication?.mode!=='direct-github'||manifest.publication?.directOrigin!==DIRECT_ORIGIN||!/^v\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(manifest.releaseId)||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)||!manifest.releaseId.endsWith('-'+manifest.sourceCommit.slice(0,12)))throw Error('Expected a pinned Direct publication manifest');
  const version=manifest.releaseId.match(/^v(\d+\.\d+\.\d+)-/)[1],base=github+'/releases/download/fleet-v'+version+'/';
  const remote=await publicBytes(base+'release-manifest.json',4*1024*1024,fetcher);
  if(JSON.stringify(JSON.parse(remote))!==JSON.stringify(manifest))throw Error('Published GitHub manifest differs from the verified source');
  const checks=await verifyRedirect(workerOrigin,fetcher),verified=[];
  if(downloads){
    const sums=await publicBytes(base+'SHA256SUMS.txt',1024*1024,fetcher);
    if(!sums.equals(fs.readFileSync(path.join(dist,'SHA256SUMS.txt'))))throw Error('Published checksum inventory differs');
    const files=[manifest.client,manifest.server,{file:'Fleet_Control_Source_v'+version+'.zip'}];
    for(const item of files){
      if(!/^Fleet_Control_(?:Client|Server|Source)_v\d+\.\d+\.\d+\.(?:apk|zip)$/.test(item.file))throw Error('Unexpected release filename');
      const local=fs.readFileSync(path.join(dist,item.file)),expected=crypto.createHash('sha256').update(local).digest('hex');
      if((item.sha256&&item.sha256!==expected)||(item.sizeBytes&&item.sizeBytes!==local.length)||!sums.toString().split('\n').includes(expected+'  '+item.file))throw Error('Local artifact/checksum differs');
      const response=await fetcher(base+item.file,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('Public artifact HTTP '+response.status);let size=0;const hash=crypto.createHash('sha256');
      for await(const chunk of response.body){size+=chunk.length;if(size>local.length)throw Error('Oversized public artifact');hash.update(chunk);}
      if(size!==local.length||hash.digest('hex')!==expected)throw Error('Public artifact bytes differ');verified.push({file:item.file,sizeBytes:size,sha256:expected});
    }
  }
  return{complete:true,mode:'direct-github',sourceCommit:manifest.sourceCommit,releaseId:manifest.releaseId,directOrigin:DIRECT_ORIGIN,redirectChecks:checks,downloadsVerified:downloads,files:verified,cloudBusinessActivation:false,androidInstallationVerified:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const manifest=JSON.parse(fs.readFileSync('dist/release-manifest.json','utf8'));
  if(process.env.FLEET_VERIFY_DEPLOYED_SOURCE&&manifest.sourceCommit!==process.env.FLEET_VERIFY_DEPLOYED_SOURCE)throw Error('Unexpected verified source');
  const result=await verifyDirectPublication({manifest,workerOrigin:process.env.FLEET_WORKER_URL,downloads:!process.argv.includes('--manifest-only')});
  fs.writeFileSync('dist/direct-publication-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
