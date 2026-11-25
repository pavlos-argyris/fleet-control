import { fleetError, readBody, sha256 } from './ledger.js';

const SESSION_SECONDS=8*60*60;
const DEVICE_SECONDS=90*24*60*60;
const DEVICE='__Host-fleetDevice';
const SESSION='__Host-fleetSession';
const START='/api/fleet-web/v1';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const PIN=/^\d{4}$/;
const HEX=/^[a-f0-9]{64}$/;
const routes=new Map([
  [START+'/enroll','POST'],[START+'/login','POST'],[START+'/session','GET'],
  [START+'/logout','POST'],[START+'/revoke-device','POST'],[START+'/change-pin','POST'],
  [START+'/sync-device','GET']
]);
const SYNC_DEVICE=START+'/sync-device';
const DEVICE_ID=/^[A-Za-z0-9_-]{22,64}$/;
const SYNC_SECONDS=180*24*60*60;
const encoder=new TextEncoder();
const same=(a,b)=>{
  if (typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false;
  let mismatch=0;
  for (let i=0;i<a.length;i++) mismatch |= a.charCodeAt(i)^b.charCodeAt(i);
  return mismatch===0;
};

function token() {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function cookie(name,value,maxAge) {
  return name+'='+value+'; Max-Age='+maxAge+'; Path=/; Secure; HttpOnly; SameSite=Strict';
}

function getCookie(request, name) {
  const values=(request.headers.get('Cookie')||'').split(';').map(value=>value.trim())
    .filter(value=>value.startsWith(name+'=')).map(value=>value.slice(name.length+1));
  return values.length===1&&TOKEN.test(values[0])?values[0]:'';
}

async function mac(env, purpose, value) {
  if (typeof env.FLEET_PIN_PEPPER!=='string'||env.FLEET_PIN_PEPPER.length<43) throw fleetError(503,'pin_unconfigured');
  const input=await crypto.subtle.importKey('raw',encoder.encode(env.FLEET_PIN_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=await crypto.subtle.sign('HMAC',input,encoder.encode(purpose+'\0'+value));
  return Array.from(new Uint8Array(bytes),number=>number.toString(16).padStart(2,'0')).join('');
}

async function enroll(request, env, respond) {
  const {recoveryCredential,pin,recover=false}=await readBody(request)||{};
  const expected=env.FLEET_RECOVERY_CREDENTIAL_SHA256;
  if (!HEX.test(expected||'') || typeof recoveryCredential!=='string' || !TOKEN.test(recoveryCredential) ||
      !same(await sha256(recoveryCredential),expected)) throw fleetError(401,'recovery_credential_required');
  if (typeof pin!=='string'||!PIN.test(pin)||typeof recover!=='boolean') throw fleetError(400,'invalid_pin');
  const db=env.FLEET_DB;
  const old=await db.prepare('SELECT pin_hash,generation FROM fleet_pin_owner WHERE id=1').first();
  const secret=token(), hash=await sha256(secret), generation=old&&!recover?old.generation:crypto.randomUUID();
  const now=Date.now(), pinHash=await mac(env,'pin',generation+':'+pin);
  if (old && !recover && !same(old.pin_hash,pinHash)) throw fleetError(401,'invalid_pin');
  const statements=[];
  if (recover) {
    // Only an explicit owner recovery rotates the generation and revokes all devices.
    statements.push(
      db.prepare("INSERT INTO fleet_pin_owner(id,pin_hash,generation) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pin_hash=excluded.pin_hash,generation=excluded.generation").bind(pinHash,generation),
      db.prepare('DELETE FROM fleet_web_sessions'),
      db.prepare('DELETE FROM fleet_trusted_devices'),
      db.prepare('DELETE FROM fleet_pin_windows')
    );
  } else if (!old) {
    statements.push(db.prepare('INSERT INTO fleet_pin_owner(id,pin_hash,generation) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING').bind(pinHash,generation));
  }
  statements.push(db.prepare(`INSERT INTO fleet_trusted_devices(device_hash,owner_generation,expires_at)
    SELECT ?,generation,? FROM fleet_pin_owner WHERE id=1 AND generation=? AND pin_hash=?`)
    .bind(hash,now+DEVICE_SECONDS*1000,generation,pinHash));
  const results=await db.batch(statements);
  if (!results.at(-1).meta.changes) throw fleetError(409,'owner_generation_changed');
  const response=respond({enrolled:true});
  response.headers.append('Set-Cookie',cookie(DEVICE,secret,DEVICE_SECONDS));
  response.headers.append('Set-Cookie',cookie(SESSION,'',0));
  return response;
}

async function claimAttempt(db, period, device, ip) {
  const result=await db.prepare(`WITH windows(bucket,cap) AS (VALUES (?,5),(?,10),('global',30))
    INSERT INTO fleet_pin_windows(bucket,period,attempts)
    SELECT window.bucket,?,1 FROM windows AS window
    WHERE NOT EXISTS (SELECT 1 FROM fleet_pin_windows AS p JOIN windows AS w ON p.bucket=w.bucket
      WHERE p.period=? AND p.attempts>=w.cap)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN period=excluded.period THEN attempts+1 ELSE 1 END,
      period=excluded.period`).bind('device:'+device,'ip:'+ip,period,period).run();
  return result.meta.changes===3;
}

async function login(request, env, respond) {
  const device=getCookie(request,DEVICE);
  if (!device) throw fleetError(401,'trusted_device_required');
  const db=env.FLEET_DB, now=Date.now(), deviceHash=await sha256(device);
  const owner=await db.prepare(`SELECT p.pin_hash,p.generation FROM fleet_pin_owner p
    JOIN fleet_trusted_devices d ON d.owner_generation=p.generation
    WHERE d.device_hash=? AND d.revoked_at IS NULL AND d.expires_at>?`).bind(deviceHash,now).first();
  if (!owner) throw fleetError(401,'trusted_device_required');
  const {pin}=await readBody(request)||{};
  const period=Math.floor(now/(15*60*1000));
  const ip=await mac(env,'ip',request.headers.get('CF-Connecting-IP')||'unknown');
  if (!await claimAttempt(db,period,deviceHash,ip)) throw fleetError(429,'pin_temporarily_blocked');
  if (typeof pin!=='string'||!PIN.test(pin) || !same(owner.pin_hash,await mac(env,'pin',owner.generation+':'+pin))) {
    throw fleetError(401,'invalid_pin');
  }
  const secret=token(), sessionHash=await sha256(secret);
  const results=await db.batch([
    db.prepare('DELETE FROM fleet_web_sessions WHERE device_hash=? AND expires_at<=?').bind(deviceHash,now),
    db.prepare(`INSERT INTO fleet_web_sessions(session_hash,device_hash,expires_at)
      SELECT ?,d.device_hash,? FROM fleet_trusted_devices d JOIN fleet_pin_owner p ON p.generation=d.owner_generation
      WHERE d.device_hash=? AND d.expires_at>? AND d.revoked_at IS NULL AND p.generation=?`)
      .bind(sessionHash,now+SESSION_SECONDS*1000,deviceHash,now,owner.generation)
  ]);
  if (!results[1].meta.changes) throw fleetError(401,'trusted_device_required');
  const response=respond({authenticated:true,csrf:await mac(env,'csrf',secret)});
  response.headers.append('Set-Cookie',cookie(SESSION,secret,SESSION_SECONDS));
  return response;
}

async function session(request, env) {
  const device=getCookie(request,DEVICE), secret=getCookie(request,SESSION);
  if (!device || !secret) throw fleetError(401,'session_required');
  const db=env.FLEET_DB, now=Date.now(), [deviceHash,sessionHash]=await Promise.all([sha256(device),sha256(secret)]);
  const found=await db.prepare(`SELECT s.expires_at FROM fleet_web_sessions s
    JOIN fleet_trusted_devices d ON d.device_hash=s.device_hash
    JOIN fleet_pin_owner p ON p.generation=d.owner_generation
    WHERE s.session_hash=? AND d.device_hash=? AND s.expires_at>? AND d.expires_at>? AND d.revoked_at IS NULL`)
    .bind(sessionHash,deviceHash,now,now).first();
  if (!found) throw fleetError(401,'session_required');
  return {deviceHash,sessionHash,expiresAt:found.expires_at,csrf:await mac(env,'csrf',secret)};
}

async function changePin(request,env,auth,respond) {
  const {currentPin,pin,confirmation}=await readBody(request)||{};
  if (![currentPin,pin,confirmation].every(value=>typeof value==='string'&&PIN.test(value)) || pin!==confirmation) {
    throw fleetError(400,'invalid_pin_confirmation');
  }
  const db=env.FLEET_DB,now=Date.now();
  const ip=await mac(env,'ip',request.headers.get('CF-Connecting-IP')||'unknown');
  if (!await claimAttempt(db,Math.floor(now/(15*60*1000)),auth.deviceHash,ip)) throw fleetError(429,'pin_temporarily_blocked');
  const owner=await db.prepare('SELECT pin_hash,generation FROM fleet_pin_owner WHERE id=1').first();
  if (!owner || !same(owner.pin_hash,await mac(env,'pin',owner.generation+':'+currentPin))) throw fleetError(401,'invalid_pin');
  const next=await mac(env,'pin',owner.generation+':'+pin);
  const changeId=crypto.randomUUID();
  const [saved]=await db.batch([
    db.prepare(`UPDATE fleet_pin_owner SET pin_hash=?,pin_change_id=? WHERE id=1 AND generation=? AND pin_hash=?
      AND EXISTS (SELECT 1 FROM fleet_web_sessions WHERE session_hash=? AND expires_at>?)`)
      .bind(next,changeId,owner.generation,owner.pin_hash,auth.sessionHash,now),
    db.prepare('DELETE FROM fleet_web_sessions WHERE EXISTS (SELECT 1 FROM fleet_pin_owner WHERE id=1 AND pin_change_id=?)').bind(changeId)
  ]);
  if (!saved.meta.changes) throw fleetError(409,'owner_generation_changed');
  const result=respond({changed:true});
  result.headers.append('Set-Cookie',cookie(SESSION,'',0));
  return result;
}

async function manageSyncDevice(request,env,auth,respond) {
  const {action,id,secretSha256,replaceId}=await readBody(request)||{};
  if (!['approve','revoke'].includes(action)||!DEVICE_ID.test(id||'')||typeof id!=='string') throw fleetError(400,'invalid_sync_device');
  const db=env.FLEET_DB,now=Date.now();
  if (action==='revoke') {
    await db.prepare(`UPDATE fleet_sync_credentials SET revoked_at=? WHERE id=? AND approved_at IS NOT NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM fleet_web_sessions WHERE session_hash=? AND expires_at>?)`).bind(now,id,auth.sessionHash,now).run();
    return respond({revoked:true});
  }
  if (typeof secretSha256!=='string'||!HEX.test(secretSha256)||
      (replaceId!==undefined && (typeof replaceId!=='string'||!DEVICE_ID.test(replaceId)||replaceId===id))) {
    throw fleetError(400,'invalid_sync_device');
  }
  const [inserted,result]=await db.batch([
    db.prepare(`INSERT INTO fleet_sync_credentials(id,secret_sha256,scope,expires_at,approved_at,replaces_id)
      SELECT ?,?,'sync-read-write',?,?,? WHERE EXISTS (SELECT 1 FROM fleet_web_sessions WHERE session_hash=? AND expires_at>?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM fleet_sync_credentials WHERE id=? AND approved_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM fleet_sync_credentials WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at>?
        AND id<>COALESCE(?,'')) ON CONFLICT(id) DO NOTHING`)
      .bind(id,secretSha256,now+SYNC_SECONDS*1000,now,replaceId??null,auth.sessionHash,now,replaceId??null,replaceId??null,now,replaceId??null),
    db.prepare(`SELECT id,secret_sha256,expires_at,revoked_at FROM fleet_sync_credentials WHERE id=? AND approved_at IS NOT NULL`)
      .bind(id),
    db.prepare(`UPDATE fleet_sync_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM fleet_sync_credentials WHERE id=? AND secret_sha256=? AND replaces_id=? AND approved_at=?)`)
      .bind(now,replaceId??null,id,secretSha256,replaceId??null,now)
  ]);
  const saved=result.results[0];
  if (!saved || saved.revoked_at!==null || saved.expires_at<=now || !same(saved.secret_sha256,secretSha256)) {
    throw fleetError(409,'sync_device_approval_conflict');
  }
  return respond({approved:true,id,expiresAt:saved.expires_at},inserted.meta.changes?201:200);
}

export async function routePin(request, env, respond) {
  const url=new URL(request.url);
  const method=routes.get(url.pathname);
  if (!method) return null;
  if (request.method!==method && !(url.pathname===SYNC_DEVICE&&request.method==='POST')) throw fleetError(405,'method_not_allowed');
  if (request.method==='POST' && request.headers.get('Origin')!==url.origin) throw fleetError(403,'origin_required');
  if (url.pathname===START+'/enroll') return enroll(request,env,respond);
  if (url.pathname===START+'/login') return login(request,env,respond);
  const auth=await session(request,env);
  if (request.method==='GET') {
    if (url.pathname!==SYNC_DEVICE) return respond({authenticated:true,expiresAt:auth.expiresAt,csrf:auth.csrf,scope:'fleet-owner'});
    const devices=await env.FLEET_DB.prepare(`SELECT id,expires_at AS expiresAt FROM fleet_sync_credentials
      WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at>?`).bind(Date.now()).all();
    return respond({devices:devices.results});
  }
  if (!same(request.headers.get('X-Fleet-CSRF'),auth.csrf)) throw fleetError(403,'csrf_required');
  if (url.pathname===START+'/change-pin') return changePin(request,env,auth,respond);
  if (url.pathname===SYNC_DEVICE) return manageSyncDevice(request,env,auth,respond);
  const db=env.FLEET_DB;
  const revoke=url.pathname.endsWith('/revoke-device');
  if (revoke) {
    await db.batch([
      db.prepare('UPDATE fleet_trusted_devices SET revoked_at=? WHERE device_hash=? AND revoked_at IS NULL').bind(Date.now(),auth.deviceHash),
      db.prepare('DELETE FROM fleet_web_sessions WHERE device_hash=?').bind(auth.deviceHash)
    ]);
  } else {
    await db.prepare('DELETE FROM fleet_web_sessions WHERE session_hash=?').bind(auth.sessionHash).run();
  }
  const response=respond({authenticated:false});
  response.headers.append('Set-Cookie',cookie(SESSION,'',0));
  if (revoke) response.headers.append('Set-Cookie',cookie(DEVICE,'',0));
  return response;
}
