import {authenticateExternal} from '../cloudflare-worker/src/workforce.js';
export const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export async function principalSecurity(env,actor){
  const user=await env.DB.prepare('SELECT role,permissions,password_hash,password_salt,force_logout_after,updated_at FROM app_users WHERE id=?').bind(actor.user_id).first();
  return digest(JSON.stringify([user,actor.permissions]));
}
/** Each consumption uses the current account, including password/role revocation. */
export async function bindFileSecurity(request,env){
  let fingerprint='';
  if(request.localInternal)fingerprint=await digest('native-internal');
  else try{fingerprint=await principalSecurity(env,await authenticateExternal(request,env));}catch{}
  globalThis.FleetHost('file.security',{fingerprint});
}
