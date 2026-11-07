// Read-only, one-minute, single-Worker diagnosis. Never print raw events/headers.
import {pathToFileURL} from 'node:url';
const FROM=Date.parse('2026-11-07T19:52:30Z'),TO=Date.parse('2026-11-07T19:53:15Z');
const PATH='/api/deploy/releases/v5.61.0-527287a4a0b8/client.apk';
export function uploadErrorSummary(row){
 const value=row?.data||row,w=value?.$workers||{},m=value?.$metadata||{};
 if(m.service!=='fleet-control'&&w.scriptName!=='fleet-control')return null;
 const urls=[m.trigger,w.event?.request?.url,w.event?.http?.request?.url];
 const matched=urls.some(url=>typeof url==='string'&&url.includes(PATH));
 const messages=[m.error,m.message,value?.error?.message,...(w.exceptions||[]).map(e=>e.message)].filter(x=>typeof x==='string');
 const message=messages.join(' '),text=message+' '+(w.outcome||'');
 const category=/memory|heap|oom/i.test(text)?'memory':/cpu|exceededCpu/i.test(text)?'cpu':/D1|SQLITE|database/i.test(text)?'database':/R2|bucket|storage/i.test(text)?'storage':/body.*used|disturb/i.test(text)?'consumed-body':'other';
 const safe=matched?message.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/[A-Za-z0-9_-]{24,}/g,'[opaque]').slice(0,500):undefined;
 return{matchedRelease:matched,outcome:w.outcome||null,cpuTimeMs:typeof w.cpuTimeMs==='number'?w.cpuTimeMs:null,category,...(safe?{message:safe}:{})};
}
export async function probeReleaseUpload({account,token,fetchImpl=fetch}){
 if(!/^[a-f0-9]{32}$/.test(account||'')||typeof token!=='string'||token.length<20)throw Error('Existing Cloudflare configuration required');
 const query={queryId:'fleet-561-upload-read-only',dry:true,view:'events',limit:100,timeframe:{from:FROM,to:TO},parameters:{filterCombination:'and',filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'fleet-control'}]}};
 const response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/observability/telemetry/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(query),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)return{readOnly:true,status:response.status,events:[],reason:'Observability query unavailable; no credentials or permissions changed.'};
 const body=await response.json(),result=body.result||{},events=Array.isArray(result.events)?result.events:Array.isArray(result.events?.events)?result.events.events:[];
 return{readOnly:true,status:response.status,events:events.map(uploadErrorSummary).filter(Boolean),responseKeys:Object.keys(result)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await probeReleaseUpload({account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN}),null,2));}catch(error){console.error('Read-only upload diagnosis failed:',error.name);process.exitCode=1;}}
