import {authenticateExternal} from '../cloudflare-worker/src/workforce.js';
export const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
// Compatibility with the pinned Android JSONObject/HashMap serialization used
// by existing receipt security hashes. Values and permissions still come from
// the current account; revoked credentials never become replayable.
export function nativeObjectOrder(value){
  if(Array.isArray(value))return value.map(nativeObjectOrder);if(!value||typeof value!=='object')return value;
  let capacity=16;while(Object.keys(value||{}).length>capacity*.75)capacity*=2;
  const bucket=key=>{let h=0;for(let i=0;i<key.length;i++)h=(Math.imul(h,31)+key.charCodeAt(i))|0;return(h^(h>>>16))&(capacity-1);};
  return value&&Object.fromEntries(Object.entries(value).sort(([a],[b])=>bucket(a)-bucket(b)).map(([key,v])=>[key,nativeObjectOrder(v)]));
}
export async function principalSecurity(env,actor){
  const user=await env.DB.prepare('SELECT role,permissions,password_hash,password_salt,force_logout_after,updated_at FROM app_users WHERE id=?').bind(actor.user_id).first();
  return digest(JSON.stringify([env.CLOUD_PRIMARY?nativeObjectOrder(user):user,actor.permissions]));
}
/** Each consumption uses the current account, including password/role revocation. */
export async function bindFileSecurity(request,env){
  let fingerprint='',actorId='';
  if(request.localInternal)fingerprint=await digest('native-internal');
  else try{const actor=await authenticateExternal(request,env);fingerprint=await principalSecurity(env,actor);actorId=actor.user_id;}catch{}
  globalThis.FleetHost('file.security',{fingerprint});
  return {fingerprint,actorId};
}
