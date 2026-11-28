import { stableReviewJson } from '../src/invoice-review-store.js';
import { fleetError, readBody, sha256 } from './ledger.js';
import { baselineEnabled, completeTransfer, EMPTY_CHAIN, readTransferManifest, readTransferPart,
  transferGrant, transferGrantArgs, transferOffset } from './baseline.js';
import { verifiedSourceService } from './source-projection.js';
import { initialTransferLimits, transferMode } from './initial-transfer.js';

export const SOURCE_DELTA_ROUTE='/api/fleet-sync/v1/source-delta/';
const schema='fleet-source-delta-v1';
const validCursor=value=>Number.isSafeInteger(value)&&value>=0;

export function sourceDeltaEnabled(env) {
  return env.FLEET_SOURCE_DELTA_TRANSFER==='1'&&baselineEnabled(env);
}

async function status(db,epoch,cursor) {
  const part=stream=>db.prepare(`SELECT ordinal,end_offset,chain FROM fleet_source_delta_parts
    WHERE cursor=? AND stream=? ORDER BY ordinal DESC LIMIT 1`).bind(cursor,stream);
  const [header,records,files]=await db.batch([
    db.prepare('SELECT manifest,verified_at FROM fleet_source_deltas WHERE cursor=? AND epoch=?').bind(cursor,epoch),
    part('records'),part('files')
  ]);
  const row=header.results[0];
  if (!row) throw fleetError(409,'source_delta_not_started');
  return {epoch,phase:row.verified_at?'staged':'copying',manifest:JSON.parse(row.manifest),
    records:transferOffset(records),files:transferOffset(files)};
}

async function begin(env,credential,epoch,cursor,input) {
  const db=env.FLEET_DB,initial=transferMode(env)==='initial-transfer',limits=initialTransferLimits(env);
  readTransferManifest(input,schema,['afterCursor','sourceCursor']);
  const previous=input.afterCursor;
  if (!validCursor(previous)||previous>=cursor||cursor!==input.sourceCursor) throw fleetError(400,'invalid_source_cursor');
  const manifest=stableReviewJson(input);
  await db.prepare(`INSERT INTO fleet_source_deltas(cursor,epoch,previous,manifest)
    SELECT ?,?,?,? WHERE ${transferGrant} AND EXISTS (
      SELECT 1 FROM fleet_baseline b WHERE b.id=1 AND b.epoch=? AND b.verified_at IS NOT NULL
      AND json_extract(b.manifest,'$.sourceSha256')=? AND json_type(b.manifest,'$.sourceCursor')='integer'
      AND COALESCE((SELECT cursor FROM fleet_source_deltas WHERE epoch=? ORDER BY cursor DESC LIMIT 1),
        json_extract(b.manifest,'$.sourceCursor'))=?
      AND NOT EXISTS(SELECT 1 FROM fleet_source_deltas WHERE epoch=? AND verified_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM fleet_source_projection WHERE state='blocked')
      AND (?=0 OR (?<=? AND json_extract(b.manifest,'$.dataBytes')+?+COALESCE((SELECT sum(json_extract(manifest,'$.dataBytes'))
        FROM fleet_source_deltas WHERE epoch=?),0)<=?)))
    ON CONFLICT DO NOTHING`).bind(cursor,epoch,previous,manifest,...transferGrantArgs(credential,epoch),
      epoch,input.sourceSha256,epoch,previous,epoch,initial?1:0,input.fileBytes,limits.media,input.dataBytes,epoch,limits.records).run();
  if (initial) {
    const saved=await db.prepare('SELECT manifest FROM fleet_source_deltas WHERE cursor=? AND epoch=?').bind(cursor,epoch).first('manifest');
    if (!saved) {
      const capacity=await db.prepare(`SELECT json_extract(b.manifest,'$.dataBytes')+?+
        COALESCE((SELECT sum(json_extract(manifest,'$.dataBytes')) FROM fleet_source_deltas WHERE epoch=?),0) AS total
        FROM fleet_baseline b WHERE b.id=1 AND b.epoch=?`).bind(input.dataBytes,epoch,epoch).first('total');
      if (capacity>limits.records||input.fileBytes>limits.media) throw fleetError(409,'initial_transfer_capacity');
    }
  }
  const saved=await status(db,epoch,cursor);
  if (stableReviewJson(saved.manifest)!==manifest) throw fleetError(409,'source_delta_manifest_conflict');
  return saved;
}

async function append(env,credential,epoch,cursor,stream,input) {
  const db=env.FLEET_DB,current=await status(db,epoch,cursor),prior=current[stream],manifest=current.manifest;
  if (input?.ordinal>prior.next) throw fleetError(409,'source_delta_out_of_order');
  const {ordinal,data,size,digest}=await readTransferPart(env,stream,input,manifest);
  const end=prior.bytes+size,total=stream==='records'?manifest.dataBytes:manifest.fileBytes;
  const chain=await sha256(prior.chain+':'+digest);
  const [,receipt]=await db.batch([
    db.prepare(`INSERT INTO fleet_source_delta_parts(cursor,stream,ordinal,digest,end_offset,chain,data)
      SELECT ?,?,?,?,?,?,? WHERE ${transferGrant} AND ?<=?
      AND EXISTS(SELECT 1 FROM fleet_source_deltas WHERE cursor=? AND epoch=? AND verified_at IS NULL)
      AND COALESCE((SELECT max(ordinal) FROM fleet_source_delta_parts WHERE cursor=? AND stream=?),-1)=?
      AND COALESCE((SELECT chain FROM fleet_source_delta_parts WHERE cursor=? AND stream=? AND ordinal=?),?)=?
      ON CONFLICT(cursor,stream,ordinal) DO NOTHING`).bind(cursor,stream,ordinal,digest,end,chain,data,
        ...transferGrantArgs(credential,epoch),end,total,cursor,epoch,cursor,stream,ordinal-1,cursor,stream,ordinal-1,
        EMPTY_CHAIN,prior.chain),
    db.prepare(`SELECT ordinal,digest,end_offset,chain FROM fleet_source_delta_parts
      WHERE cursor=? AND stream=? AND ordinal=?`).bind(cursor,stream,ordinal)
  ]);
  if (receipt.results[0]?.digest!==digest) throw fleetError(409,'source_delta_part_conflict');
  return transferOffset(receipt);
}

async function seal(db,credential,epoch,cursor) {
  const current=await status(db,epoch,cursor);
  if (!completeTransfer(current)) throw fleetError(409,'source_delta_reconciliation_failed');
  await db.prepare(`UPDATE fleet_source_deltas SET verified_at=?
    WHERE cursor=? AND epoch=? AND verified_at IS NULL AND ${transferGrant}
    AND (SELECT max(ordinal) FROM fleet_source_delta_parts WHERE cursor=? AND stream='records')=?
    AND COALESCE((SELECT max(ordinal) FROM fleet_source_delta_parts WHERE cursor=? AND stream='files'),-1)=?`)
    .bind(Date.now(),cursor,epoch,...transferGrantArgs(credential,epoch),cursor,current.records.next-1,cursor,current.files.next-1).run();
  const result=await status(db,epoch,cursor);
  if (result.phase!=='staged') throw fleetError(409,'source_delta_reconciliation_failed');
  return result;
}

export async function routeSourceDelta(request,pathname,env,credential,epoch,respond) {
  if (!sourceDeltaEnabled(env)) throw fleetError(404,'source_delta_unavailable');
  const match=/^(\d{1,16})\/(begin|records|files|seal|service)$/.exec(pathname.slice(SOURCE_DELTA_ROUTE.length));
  const cursor=Number(match?.[1]);
  if (!match||!validCursor(cursor)||cursor===0||String(cursor)!==match[1]) throw fleetError(404,'source_delta_unavailable');
  const operation=match[2],db=env.FLEET_DB;
  if (operation==='service') {
    if (request.method!=='GET') throw fleetError(405,'method_not_allowed');
    const query=new URL(request.url).searchParams;
    return respond(await verifiedSourceService(db,epoch,cursor,query.get('machineId'),query.get('serviceId')));
  }
  if (request.method!=='POST') throw fleetError(405,'method_not_allowed');
  if (credential.scope!=='sync-read-write') throw fleetError(403,'sync_write_scope_required');
  if (operation==='seal') return respond(await seal(db,credential,epoch,cursor));
  const input=await readBody(request);
  if (operation==='begin') return respond(await begin(env,credential,epoch,cursor,input));
  return respond(await append(env,credential,epoch,cursor,operation,input));
}
