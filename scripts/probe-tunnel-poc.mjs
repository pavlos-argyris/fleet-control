import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

export function origin(value){
  const parsed=new URL(value);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash||parsed.pathname!=='/'||!parsed.hostname.includes('.')||/^[\d.]+$/.test(parsed.hostname)||parsed.hostname.endsWith('.workers.dev')||parsed.hostname.endsWith('.trycloudflare.com'))throw Error('Provide only a dedicated Named Tunnel HTTPS origin, without credentials/path/query.');
  return parsed.origin;
}
export function summarize(samples){
  const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b),pick=p=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]??null;
  const ids=new Set(samples.filter(s=>s.ok).map(s=>s.instanceId));
  return {requests:samples.length,successful:samples.filter(s=>s.ok).length,p50Ms:pick(.5),p95Ms:pick(.95),bytes:samples.reduce((n,s)=>n+s.bytes,0),instances:ids.size,consistent:samples.every(s=>s.ok)&&ids.size===1};
}
export async function probe(base,{rounds=3,concurrency=30,fetcher=fetch}={}){
  base=origin(base);if(!Number.isInteger(rounds)||rounds<1||rounds>10||!Number.isInteger(concurrency)||concurrency<30||concurrency>60)throw Error('Use 1–10 rounds and 30–60 concurrent diagnostic requests.');
  const samples=[];
  for(let round=0;round<rounds;round++)await Promise.all(Array.from({length:concurrency},async()=>{
    const at=performance.now();let bytes=0;
    try{
      const response=await fetcher(base+'/poc/v1/health',{cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
      if(Number(response.headers.get('content-length'))>4096)throw Error('Diagnostic response too large');
      const reader=response.body.getReader(),chunks=[];for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader.cancel();throw Error('Diagnostic response too large');}chunks.push(value);}
      const text=Buffer.concat(chunks).toString('utf8'),data=JSON.parse(text),now=Date.now();
      const ok=response.status===200&&response.headers.get('cache-control')==='no-store'&&data.source==='fleet-tunnel-poc'&&data.businessData===false&&/^[a-f0-9-]{36}$/.test(data.instanceId)&&Number.isSafeInteger(data.requests)&&data.requests>0&&Number.isSafeInteger(data.uptimeMs)&&data.uptimeMs>=0&&Number.isSafeInteger(data.observedAtMs)&&Math.abs(now-data.observedAtMs)<60000;
      samples.push({ok,ms:performance.now()-at,bytes,instanceId:ok?data.instanceId:null});
    }catch{samples.push({ok:false,ms:performance.now()-at,bytes,instanceId:null});}
  }));
  return {schemaVersion:1,source:'fleet-tunnel-poc-probe',observedAt:new Date().toISOString(),concurrency,rounds,syntheticOnly:true,physicalAcceptanceVerified:false,summary:summarize(samples)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const report=await probe(process.argv[2]);const output=process.argv[3]||'.build/tunnel-poc-probe.json';fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(!report.summary.consistent)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
