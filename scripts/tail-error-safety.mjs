import crypto from 'node:crypto';
// Never publish arbitrary exception text: SQL errors can contain business values.
export function diagnosticError(value,secrets=[]){
 const raw=typeof value==='string'?value:String(value?.message||value?.name||'Unknown error');
 let clean=raw;for(const secret of secrets)if(secret)clean=clean.replaceAll(secret,'[REDACTED]');
 const quota=clean.match(/exceeded the daily Durable Objects free tier limit of\s*([\d,]+)\s*(rows_written|rows_read|requests|duration)/i);
 if(quota)return{kind:'durable_objects_daily_quota',metric:quota[2].toLowerCase(),limit:Number(quota[1].replaceAll(',',''))};
 const codes=[...new Set(clean.match(/\b(?:SQLITE_[A-Z_]+|D1_ERROR|D1_EXEC_ERROR)\b/g)||[])];
 if(codes.length)return{kind:'database_error',codes};
 if(/CPU time limit|exceeded.*CPU/i.test(clean))return{kind:'cpu_limit'};
 if(/Memory limit|out of memory|exceeded.*memory/i.test(clean))return{kind:'memory_limit'};
 if(/Authentication error|not authorized|permission denied/i.test(clean))return{kind:'permission_error'};
 const type=typeof value==='object'&&['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(value?.name)?value.name:'Error';
 return{kind:'unclassified_error',type,messageSha256:crypto.createHash('sha256').update(clean).digest('hex')};
}
