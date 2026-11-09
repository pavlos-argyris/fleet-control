import crypto from 'node:crypto';
// Never publish arbitrary exception text: SQL errors can contain business values.
export function diagnosticError(value,secrets=[]){
 const raw=typeof value==='string'?value:String(value?.message||value?.name||'Unknown error');
 let clean=raw;for(const secret of secrets)if(secret)clean=clean.replaceAll(secret,'[REDACTED]');
 const quota=clean.match(/exceeded the daily Durable Objects free tier limit of\s*([\d,]+)\s*(rows_written|rows_read|requests|duration)/i);
 if(quota)return{kind:'durable_objects_daily_quota',metric:quota[2].toLowerCase(),limit:Number(quota[1].replaceAll(',',''))};
 const legacyQuota=clean.match(/Exceeded allowed (rows written|rows read|duration) in Durable Objects free tier/i);
 if(legacyQuota)return{kind:'durable_objects_daily_quota',metric:legacyQuota[1].toLowerCase().replace('rows written','rows_written').replace('rows read','rows_read')};
 const codes=[...new Set(clean.match(/\b(?:SQLITE_[A-Z_]+|D1_ERROR|D1_EXEC_ERROR)\b/g)||[])];
 if(codes.length)return{kind:'database_error',codes};
 if(/CPU time limit|exceeded.*CPU/i.test(clean))return{kind:'cpu_limit'};
 if(/Memory limit|out of memory|exceeded.*memory/i.test(clean))return{kind:'memory_limit'};
 if(/Authentication error|not authorized|permission denied/i.test(clean))return{kind:'permission_error'};
 const first=clean.split(/\r?\n/)[0];
 if(/^(?:(?:Error|TypeError|ReferenceError|RPCError):\s*)?(?:The Durable Object|Your Durable Object|Durable Object|Cannot perform I\/O|Cannot read properties|Too many|Worker|The script|No such actor|Actor|Failed to fetch|fetch failed|RPC|Service temporarily|Operation)/i.test(first)){
  const message=first.replace(/https?:\/\/\S+/g,'[URL]').replace(/(["'`])[^"'`]*\1/g,'[TEXT]').replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g,'[IDENTIFIER]').slice(0,500);
  return{kind:'platform_error',message};
 }
 const type=typeof value==='object'&&['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(value?.name)?value.name:'Error';
 const vocabulary=new Set('error typeerror referenceerror cannot read properties undefined null authority coordinator unavailable durable object objects storage database sql sqlite request requests handler global scope different context input output gate constructor blockconcurrencywhile operation operations disallowed allowed asynchronous io i o outside callback promise promises transaction transactions closed reset resetting evicted aborted destroyed unavailable failed failure fetch binding namespace event code limit quota exceeded rows_written rows_read worker workers runtime internal rpc receiver response json parse unexpected token invalid method function is not a the this its in from within of to for on behalf has been was due and'.split(' '));
 const diagnosticWords=(first.match(/[A-Za-z_]+/g)||[]).map(word=>vocabulary.has(word.toLowerCase())?word.toLowerCase():'?').join(' ').slice(0,500);
 return{kind:'unclassified_error',type,messageSha256:crypto.createHash('sha256').update(clean).digest('hex'),diagnosticWords};
}

export function tailProbeShape(value){
 const data=value?.event?value:value?.data&&typeof value.data==='object'?value.data:value;
 return{keys:['data','event','logs','exceptions','outcome','type','message','events','payload'].filter(k=>Object.hasOwn(value||{},k)),dataType:typeof value?.data,eventType:typeof data?.event,requestType:typeof data?.event?.request,urlType:typeof data?.event?.request?.url};
}

export function tailProbeEvent(value,probe,secrets=[]){
 const data=value?.event?value:value?.data&&typeof value.data==='object'?value.data:value;
 const entry=data?.event,request=entry?.request;if(!request||typeof request.url!=='string')return null;
 let url;try{url=new URL(request.url);}catch{return null;}
 let header;try{header=new Headers(request.headers||{}).get('X-Fleet-Probe');}catch{}
 if(url.pathname!=='/api/primary/descriptor'||url.searchParams.get('diagnostic')!==probe&&header!==probe)return null;
 return{path:url.pathname,outcome:data.outcome,status:entry.response?.status,cpuTimeMs:data.cpuTime,exceptions:(data.exceptions||[]).map(e=>diagnosticError(e,secrets)),logs:(data.logs||[]).filter(l=>l.level==='error').map(l=>({level:'error',errors:(Array.isArray(l.message)?l.message:[l.message]).map(e=>diagnosticError(e,secrets))}))};
}
