// Pure monitoring projection. Does not poll, log, query or write D1/Ordexa.
// An absent signal is UNKNOWN, never "healthy" or a fabricated zero.
const parse=(s)=>typeof s==='string'&&Number.isFinite(Date.parse(s))?Date.parse(s):null;
const bounded=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)throw new TypeError('Invalid '+label);return n;};
const measured=(at,now,maxAgeMs)=>{const t=parse(at);return t!==null&&t<=now&&now-t<=maxAgeMs;};
export function projectFleetHealth({at=new Date().toISOString(),serverLastSeenAt=null,ordexaLastSuccessAt=null,backupLastVerifiedRestoreAt=null,outboxPending=null,outboxOldestAt=null,d1=null}={}){
 const now=parse(at);if(now===null)throw new TypeError('Invalid observation timestamp');
 const results={observedAt:at};
 function freshness(name,stamp,maxAgeMs){
  const t=parse(stamp);
  results[name]={status:t===null||t>now?'unknown':now-t>maxAgeMs?'stale':'healthy',observedAt:t===null?null:stamp,ageSeconds:t===null||t>now?null:Math.floor((now-t)/1000)};
 }
 freshness('server',serverLastSeenAt,7*60000);
 freshness('ordexa',ordexaLastSuccessAt,15*60000);
 freshness('backupRestoreProof',backupLastVerifiedRestoreAt,48*3600000);
 results.outbox={status:'unknown',pending:null,oldestAgeSeconds:null};
 if(outboxPending!==null){
  bounded(outboxPending,'outbox count');
  if(outboxPending===0)results.outbox={status:'healthy',pending:0,oldestAgeSeconds:null};
  else{
   const t=parse(outboxOldestAt);const old=t===null||t>now?null:Math.floor((now-t)/1000);
   results.outbox={status:old===null?'unknown':old>3600?'stale':'pending',pending:outboxPending,oldestAgeSeconds:old};
  }
 }
 results.d1={status:'unknown',writes:null,limit:null,observedAt:null};
 if(d1!==null&&typeof d1==='object'&&measured(d1.observedAt,now,3600000)&&Number.isSafeInteger(d1.rowsWritten)&&d1.rowsWritten>=0&&Number.isSafeInteger(d1.rowsWriteLimit)&&d1.rowsWriteLimit>0){
  const ratio=d1.rowsWritten/d1.rowsWriteLimit;
  results.d1={status:ratio>=1?'quota-exceeded':ratio>=0.9?'near-limit':'measured',writes:d1.rowsWritten,limit:d1.rowsWriteLimit,observedAt:d1.observedAt};
 }
 const alerts=[];
 if(results.server.status==='stale')alerts.push({code:'server-stale',severity:'critical'});
 if(results.ordexa.status==='stale')alerts.push({code:'ordexa-stale',severity:'warning'});
 if(results.backupRestoreProof.status==='stale')alerts.push({code:'restore-proof-stale',severity:'warning'});
 if(results.outbox.status==='stale')alerts.push({code:'outbox-stale',severity:'warning'});
 if(['near-limit','quota-exceeded'].includes(results.d1.status))alerts.push({code:'d1-'+results.d1.status,severity:results.d1.status==='quota-exceeded'?'critical':'warning'});
 results.alerts=alerts;
 return results;
}
