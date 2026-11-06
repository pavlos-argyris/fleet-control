import {authenticateExternal} from '../cloudflare-worker/src/workforce.js';
import {digest,principalSecurity} from './security.js';
const json=(error,status,code)=>Response.json({error,code},{status});
export const RECEIPT_SCHEMA="CREATE TABLE IF NOT EXISTS native_operation_receipts(actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,security_hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor_id,operation_id));";

/** The enclosing native SQLite transaction commits business changes + receipt. */
export async function beginOperation(request,env,form){
  const path=new URL(request.url).pathname;
  if(['GET','HEAD','OPTIONS'].includes(request.method)||/^\/api\/(auth|events|native\/files)\//.test(path))return {};
  let actor;try{actor=await authenticateExternal(request,env);}catch(e){return{response:json(e.message||'Χρειάζεται σύνδεση.',Number(e.status)||401)}};
  const id=request.headers.get('X-Fleet-Operation')||'';
  if(!/^[a-f0-9-]{36}$/.test(id))return{response:json('Η αποθήκευση χρειάζεται μοναδική ταυτότητα ενέργειας. Ενημέρωσε την εφαρμογή.',428,'operation_id_required')};
  const normalized={};
  for(const [key,value]of Object.entries(form||{}))normalized[key]=value&&typeof value==='object'&&value.ref?{name:value.name,type:value.type,size:value.size,sha256:value.sha256}:value;
  const requestHash=await digest(JSON.stringify([request.method,request.url,await request.clone().text(),normalized]));
  const securityHash=await principalSecurity(env,actor);
  const prior=await env.DB.prepare('SELECT request_hash,security_hash,response FROM native_operation_receipts WHERE actor_id=? AND operation_id=?').bind(actor.user_id,id).first();
  if(prior){
    if(prior.request_hash!==requestHash)return{response:json('Η ίδια ενέργεια έχει διαφορετικό περιεχόμενο. Το προσχέδιο διατηρήθηκε.',409,'operation_conflict')};
    if(prior.security_hash!==securityHash)return{response:json('Τα δικαιώματα ή ο λογαριασμός άλλαξαν. Έλεγξε την ήδη καταχωρισμένη ενέργεια.',409,'operation_authorization_changed')};
    const saved=JSON.parse(prior.response);return{response:new Response(saved.body,{status:saved.status,headers:{...saved.headers,'X-Fleet-Replayed':'1'}})};
  }
  return{actorId:actor.user_id,id,requestHash,securityHash};
}
export async function finishOperation(operation,response,env){
  if(!operation.id||!response.ok)return;
  const headers=Object.fromEntries(response.headers);delete headers['set-cookie'];
  const result={status:response.status,headers,body:await response.clone().text()};
  await env.DB.prepare('INSERT INTO native_operation_receipts(actor_id,operation_id,request_hash,security_hash,response,created_at) VALUES(?,?,?,?,?,?)').bind(operation.actorId,operation.id,operation.requestHash,operation.securityHash,JSON.stringify(result),new Date().toISOString()).run();
}
