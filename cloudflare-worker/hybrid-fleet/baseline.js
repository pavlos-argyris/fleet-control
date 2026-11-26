import { fleetError, readBody, sha256 } from './ledger.js';
import { stableReviewJson } from '../src/invoice-review-store.js';

const EMPTY_CHAIN='0'.repeat(64);
export const BASELINE_CHUNK_BYTES=48*1024;
const MAX_RECORD_BYTES=512*1024*1024;
const MAX_FILE_BYTES=15*1024*1024;
const MAX_FILES=30000;
const HEX=/^[a-f0-9]{64}$/;
const schema='fleet-baseline-v1';
const prefix='/api/fleet-sync/v1/baseline';
const routes=new Map([[prefix,'GET'],[prefix+'/begin','POST'],[prefix+'/records','POST'],[prefix+'/files','POST'],
  [prefix+'/seal','POST'],[prefix+'/page','GET']]);

const grant=`EXISTS (SELECT 1 FROM fleet_sync_credentials WHERE id=? AND secret_sha256=? AND scope='sync-read-write'
  AND revoked_at IS NULL AND expires_at>?) AND EXISTS (SELECT 1 FROM fleet_rehearsal_state WHERE id=1 AND epoch=?)`;
const grantArgs=(credential,epoch)=>[credential.id,credential.hash,Date.now(),epoch];
const validNumber=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const validDigest=value=>typeof value==='string'&&HEX.test(value);

export function baselineEnabled(env) {
  return env.FLEET_BASELINE_TRANSFER==='1'&&Boolean(env.FLEET_DOCUMENTS);
}

export async function baselineReadyForQueue(env) {
  if (env.FLEET_BASELINE_TRANSFER!=='1') return true;
  if (!baselineEnabled(env)) return false;
  const validated=await env.FLEET_DB.prepare(`SELECT 1 AS ready FROM fleet_baseline b JOIN fleet_rehearsal_state e
    ON e.id=1 AND e.epoch=b.epoch WHERE b.id=1 AND b.verified_at IS NOT NULL`).first();
  return Boolean(validated);
}

function readManifest(input) {
  const keys=['format','sourceSha256','dataBytes','dataChain','files','fileBytes','fileChain'];
  if (Object.keys(input||{}).length!==keys.length || keys.some(key=>!Object.hasOwn(input,key)) || input.format!==schema ||
      !validDigest(input.sourceSha256)||!validDigest(input.dataChain)||!validDigest(input.fileChain)||
      !validNumber(input.dataBytes,MAX_RECORD_BYTES)||input.dataBytes===0||
      !validNumber(input.files,MAX_FILES)||!validNumber(input.fileBytes,MAX_FILES*MAX_FILE_BYTES)||
      (input.files===0 ? input.fileBytes!==0||input.fileChain!==EMPTY_CHAIN : input.fileBytes<input.files)) {
    throw fleetError(400,'invalid_baseline_manifest');
  }
  return input;
}

function progress(db,stream) {
  return db.prepare(`SELECT ordinal,end_offset,chain FROM fleet_baseline_parts WHERE stream=? ORDER BY ordinal DESC LIMIT 1`).bind(stream);
}

async function status(db,epoch) {
  const [header,records,files]=await db.batch([
    db.prepare('SELECT manifest,verified_at FROM fleet_baseline WHERE id=1 AND epoch=?').bind(epoch),
    progress(db,'records'),progress(db,'files')
  ]);
  const headerRow=header.results[0];
  if (!headerRow) return {epoch,phase:'empty',records:emptyProgress(),files:emptyProgress()};
  return {epoch,phase:headerRow.verified_at?'staged':'copying',manifest:JSON.parse(headerRow.manifest),
    records:offset(records),files:offset(files)};
}
const emptyProgress=()=>({next:0,bytes:0,chain:EMPTY_CHAIN});
const offset=result=>{
  const row=result.results[0];
  return row?{next:row.ordinal+1,bytes:row.end_offset,chain:row.chain}:emptyProgress();
};

async function open(db,credential,epoch,input) {
  const manifest=stableReviewJson(readManifest(input));
  await db.prepare(`INSERT INTO fleet_baseline(id,epoch,manifest) SELECT 1,?,? WHERE ${grant}
    ON CONFLICT(id) DO NOTHING`).bind(epoch,manifest,...grantArgs(credential,epoch)).run();
  const current=await status(db,epoch);
  if (!current.manifest || stableReviewJson(current.manifest)!==manifest) throw fleetError(409,'baseline_manifest_conflict');
  return current;
}

async function decodePart(value) {
  if (typeof value!=='string'||value.length>Math.ceil(BASELINE_CHUNK_BYTES/3)*4) throw fleetError(400,'invalid_baseline_chunk');
  let bytes;
  try { bytes=Uint8Array.from(atob(value),char=>char.charCodeAt(0)); }
  catch { throw fleetError(400,'invalid_baseline_chunk'); }
  if (!bytes.length||bytes.length>BASELINE_CHUNK_BYTES) throw fleetError(400,'invalid_baseline_chunk');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return {bytes,digest:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
}

async function append(env,credential,epoch,stream,input) {
  const ordinal=input?.ordinal;
  if (!validNumber(ordinal,Math.max(MAX_FILES,Math.ceil(MAX_RECORD_BYTES/BASELINE_CHUNK_BYTES)))) {
    throw fleetError(400,'invalid_baseline_ordinal');
  }
  const db=env.FLEET_DB,current=await status(db,epoch),manifest=current.manifest;
  if (!manifest) throw fleetError(409,'baseline_not_started');
  const prior=current[stream];
  if (ordinal>prior.next) throw fleetError(409,'baseline_out_of_order');
  if (stream==='records'?Object.keys(input).some(key=>!['ordinal','data','sha256'].includes(key)):
      Object.keys(input).some(key=>!['ordinal','size','sha256'].includes(key))) throw fleetError(400,'invalid_baseline_field');

  let data=null,size,digest;
  if (stream==='records') {
    const decoded=await decodePart(input.data);
    data=decoded.bytes;
    size=data.length;
    digest=decoded.digest;
    const expected=Math.min(BASELINE_CHUNK_BYTES,manifest.dataBytes-ordinal*BASELINE_CHUNK_BYTES);
    if (size!==expected||digest!==input.sha256) throw fleetError(422,'baseline_chunk_mismatch');
  } else {
    if (ordinal>=manifest.files||!validDigest(input.sha256)||!validNumber(input.size,MAX_FILE_BYTES)||input.size===0) {
      throw fleetError(400,'invalid_baseline_file');
    }
    size=input.size;
    const object=await env.FLEET_DOCUMENTS.head('sha256/'+input.sha256);
    if (!object||object.size!==size||object.checksums?.toJSON()?.sha256!==input.sha256) {
      throw fleetError(409,'baseline_file_unverified');
    }
    digest=await sha256(input.sha256+':'+size);
  }

  const end=prior.bytes+size;
  const total=stream==='records'?manifest.dataBytes:manifest.fileBytes;
  const chain=await sha256(prior.chain+':'+digest);
  // Insertion and replay both read a durable row. A second worker cannot
  // advance the prefix between the guard and insertion in the same batch.
  const [,receipt]=await db.batch([
    db.prepare(`INSERT INTO fleet_baseline_parts(stream,ordinal,digest,end_offset,chain,data)
      SELECT ?,?,?,?,?,? WHERE ${grant} AND ?<=? AND EXISTS(SELECT 1 FROM fleet_baseline WHERE id=1 AND epoch=? AND verified_at IS NULL)
      AND COALESCE((SELECT max(ordinal) FROM fleet_baseline_parts WHERE stream=?),-1)=?
      AND COALESCE((SELECT chain FROM fleet_baseline_parts WHERE stream=? AND ordinal=?),?)=?
      ON CONFLICT(stream,ordinal) DO NOTHING`).bind(stream,ordinal,digest,end,chain,data,...grantArgs(credential,epoch),
        end,total,epoch,stream,ordinal-1,stream,ordinal-1,EMPTY_CHAIN,prior.chain),
    db.prepare('SELECT ordinal,digest,end_offset,chain FROM fleet_baseline_parts WHERE stream=? AND ordinal=?').bind(stream,ordinal)
  ]);
  const saved=receipt.results[0];
  if (!saved||saved.digest!==digest) throw fleetError(409,'baseline_part_conflict');
  return {next:saved.ordinal+1,bytes:saved.end_offset,chain:saved.chain};
}

async function seal(db,credential,epoch) {
  const current=await status(db,epoch);
  const {manifest,records,files}=current;
  if (!manifest||records.bytes!==manifest.dataBytes||records.chain!==manifest.dataChain||
      files.next!==manifest.files||files.bytes!==manifest.fileBytes||files.chain!==manifest.fileChain) {
    throw fleetError(409,'baseline_reconciliation_failed');
  }
  await db.prepare(`UPDATE fleet_baseline SET verified_at=? WHERE id=1 AND epoch=? AND verified_at IS NULL AND ${grant}
    AND (SELECT max(ordinal) FROM fleet_baseline_parts WHERE stream='records')=?
    AND COALESCE((SELECT max(ordinal) FROM fleet_baseline_parts WHERE stream='files'),-1)=?`)
    .bind(Date.now(),epoch,...grantArgs(credential,epoch),records.next-1,files.next-1).run();
  const verified=await status(db,epoch);
  if (verified.phase!=='staged') throw fleetError(409,'baseline_reconciliation_failed');
  return verified;
}

async function readPage(db,epoch,raw) {
  const ordinal=Number(raw);
  if (raw===null||!/^\d{1,6}$/.test(raw)||!validNumber(ordinal,Math.ceil(MAX_RECORD_BYTES/BASELINE_CHUNK_BYTES))) {
    throw fleetError(400,'invalid_baseline_ordinal');
  }
  const page=await db.prepare(`SELECT digest,data FROM fleet_baseline_parts WHERE stream='records' AND ordinal=?
    AND EXISTS(SELECT 1 FROM fleet_baseline WHERE id=1 AND epoch=? AND verified_at IS NOT NULL)`).bind(ordinal,epoch).first();
  if (!page) throw fleetError(404,'baseline_page_absent');
  const data=btoa(String.fromCharCode(...new Uint8Array(page.data)));
  return {ordinal,data,sha256:page.digest};
}

export async function routeBaseline(request,env,credential,epoch,respond) {
  const url=new URL(request.url),method=routes.get(url.pathname);
  if (!method) return null;
  if (!baselineEnabled(env)) throw fleetError(404,'baseline_unavailable');
  if (request.method!==method) throw fleetError(405,'method_not_allowed');
  let value;
  if (method==='GET') value=url.pathname===prefix?await status(env.FLEET_DB,epoch):await readPage(env.FLEET_DB,epoch,url.searchParams.get('ordinal'));
  else {
    if (credential.scope!=='sync-read-write') throw fleetError(403,'sync_write_scope_required');
    if (url.pathname.endsWith('/seal')) value=await seal(env.FLEET_DB,credential,epoch);
    else {
      const input=await readBody(request);
      if (url.pathname.endsWith('/begin')) value=await open(env.FLEET_DB,credential,epoch,input);
      else value=await append(env,credential,epoch,url.pathname.endsWith('/files')?'files':'records',input);
    }
  }
  return respond(value);
}
