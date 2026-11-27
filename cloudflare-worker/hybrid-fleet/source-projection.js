import { archiveReader, baselineReader, BASELINE_CHUNK_BYTES, readIndexedBaselineRow, recordIdentity } from './baseline-projection.js';
import { fleetError, sha256, validFleetRecordId } from './ledger.js';

const hex=/^[a-f0-9]{64}$/;
const kinds=new Set(['snapshot','machine','machine-registry','history','machine-archive','archived-history',
  'history-trash','invoice-job','invoice-draft','document']);
const invalid=()=>fleetError(409,'source_delta_invalid_row');
const checkpoint=`cursor=? AND state='indexing' AND next_byte=? AND next_row=?`;
const position=state=>[state.cursor,state.next_byte,state.next_row];

function verifyHeader(state,row) {
  if (row?.kind!=='source-checkpoint'||row.afterCursor!==state.previous||row.sourceCursor!==state.cursor||
      Object.keys(row).length!==3) throw invalid();
}

async function prepareRow(db,state,line,ordinal,start) {
  const {key,beforeSha256:before,sha256:digest,record}=line.record??{};
  if (!Array.isArray(key)||key.length!==3||!kinds.has(key[0])||
      key.slice(1).some(id=>typeof id!=='string'||id.length>520||id.includes('\0'))||
      (before!==null&&(typeof before!=='string'||!hex.test(before)))||
      (digest!==null&&(typeof digest!=='string'||!hex.test(digest)))||before===digest||
      Object.keys(line.record).length!==4) throw invalid();
  if (digest===null) {
    if (record!==null||key[0]==='snapshot') throw invalid();
  } else {
    if (typeof record!=='string'||await sha256(record)!==digest) throw invalid();
    let row,identity;
    try {
      row=JSON.parse(record);
      identity=recordIdentity(row,key[0]==='snapshot');
    } catch { throw invalid(); }
    if (identity.kind!==key[0]||identity.machineId!==key[1]||identity.recordId!==key[2]) throw invalid();
    if (identity.kind==='document') {
      const file=await sha256(identity.details.sha256+':'+identity.details.size);
      const verified=await db.prepare(`SELECT 1 AS found FROM fleet_source_delta_parts
        WHERE cursor=? AND stream='files' AND digest=? LIMIT 1`).bind(state.cursor,file).first('found');
      if (!verified) throw fleetError(409,'source_delta_document_not_verified');
    }
  }
  return {kind:key[0],machine:key[1],record:key[2],before,digest,ordinal,start,end:line.next};
}

function sourceReader(db,cursor,size) {
  return archiveReader(size,ordinal=>db.prepare(`SELECT ordinal,data FROM fleet_source_delta_parts
    WHERE cursor=? AND stream='records' AND ordinal>=? ORDER BY ordinal LIMIT 12`).bind(cursor,ordinal).all());
}

async function preparePage(db,state) {
  const read=sourceReader(db,state.cursor,state.data_bytes);
  let start=state.next_byte;
  if (!start) {
    const first=await read(0);
    verifyHeader(state,first.record);
    start=first.next;
  }
  const rows=[],keys=new Set();
  while (start<state.data_bytes&&rows.length<12&&start-state.next_byte<2*BASELINE_CHUNK_BYTES) {
    const row=await prepareRow(db,state,await read(start),state.next_row+rows.length,start);
    const key=JSON.stringify([row.kind,row.machine,row.record]);
    if (keys.has(key)) throw fleetError(409,'source_delta_duplicate_record');
    keys.add(key);
    rows.push(row);
    start=row.end;
  }
  return {rows,nextByte:start};
}

async function savePage(db,state,page) {
  const proposed=JSON.stringify(page.rows),end=state.next_row+page.rows.length;
  const sameAddress=(source,proposed)=>`${source}.kind=json_extract(${proposed}.value,'$.kind') AND
    ${source}.machine_id=json_extract(${proposed}.value,'$.machine') AND ${source}.record_id=json_extract(${proposed}.value,'$.record')`;
  await db.batch([
    db.prepare(`INSERT INTO fleet_source_projection_rows(cursor,ordinal,kind,machine_id,record_id,sha256,start_byte,end_byte)
      SELECT ?,json_extract(j.value,'$.ordinal'),json_extract(j.value,'$.kind'),json_extract(j.value,'$.machine'),
        json_extract(j.value,'$.record'),json_extract(j.value,'$.digest'),json_extract(j.value,'$.start'),json_extract(j.value,'$.end')
      FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM fleet_source_projection WHERE ${checkpoint})
      AND NOT EXISTS(SELECT 1 FROM json_each(?) p WHERE EXISTS (SELECT 1 FROM fleet_source_projection_rows a
        WHERE a.cursor=? AND ${sameAddress('a','p')}) OR (SELECT hash FROM (
          SELECT a.sha256 AS hash,a.cursor FROM fleet_source_projection_rows a WHERE a.cursor<=? AND ${sameAddress('a','p')}
          UNION ALL SELECT b.digest AS hash,-1 AS cursor FROM fleet_baseline_rows b WHERE ${sameAddress('b','p')}
        ) ORDER BY cursor DESC LIMIT 1) IS NOT json_extract(p.value,'$.before'))`)
      .bind(state.cursor,proposed,...position(state),proposed,state.cursor,state.previous),
    db.prepare(`UPDATE fleet_source_projection SET next_byte=?,next_row=? WHERE ${checkpoint}
      AND (SELECT count(*) FROM fleet_source_projection_rows WHERE cursor=? AND ordinal>=? AND ordinal<?)=?`)
      .bind(page.nextByte,end,...position(state),state.cursor,state.next_row,end,page.rows.length),
    db.prepare(`UPDATE fleet_source_projection SET state='blocked',reason='source_delta_record_conflict' WHERE ${checkpoint}`)
      .bind(...position(state))
  ]);
}

export async function advanceSourceProjection(db) {
  await db.prepare(`INSERT INTO fleet_source_projection(cursor,state)
    SELECT d.cursor,'indexing' FROM fleet_source_deltas d JOIN fleet_baseline_projection b ON b.id=1 AND b.epoch=d.epoch AND b.state='verified'
    JOIN fleet_rehearsal_state e ON e.id=1 AND e.epoch=d.epoch
    WHERE d.verified_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fleet_source_projection p WHERE p.cursor=d.cursor)
    AND (NOT EXISTS(SELECT 1 FROM fleet_source_deltas q WHERE q.cursor=d.previous)
      OR EXISTS(SELECT 1 FROM fleet_source_projection p WHERE p.cursor=d.previous AND p.state='indexed'))
    ORDER BY d.cursor LIMIT 1 ON CONFLICT DO NOTHING`).run();
  const state=await db.prepare(`SELECT p.*,d.previous,json_extract(d.manifest,'$.dataBytes') AS data_bytes
    FROM fleet_source_projection p JOIN fleet_source_deltas d ON d.cursor=p.cursor
    JOIN fleet_rehearsal_state e ON e.id=1 AND e.epoch=d.epoch WHERE p.state='indexing' ORDER BY p.cursor LIMIT 1`).first();
  if (!state) return false;
  try {
    if (state.next_byte===state.data_bytes) {
      await db.prepare(`UPDATE fleet_source_projection SET state='indexed' WHERE ${checkpoint}`).bind(...position(state)).run();
    } else {
      const page=await preparePage(db,state);
      if (page.nextByte<=state.next_byte) throw invalid();
      await savePage(db,state,page);
    }
  } catch (error) {
    if (error.status!==409) throw error;
    await db.prepare(`UPDATE fleet_source_projection SET state='blocked',reason=? WHERE ${checkpoint}`).bind(error.code,...position(state)).run();
  }
  return true;
}

export async function sourceProjectionStatus(db,epoch) {
  const last=await db.prepare(`SELECT d.cursor,d.verified_at,p.state,p.reason,p.next_row,
    (SELECT max(q.cursor) FROM fleet_source_projection q JOIN fleet_source_deltas r ON r.cursor=q.cursor
      WHERE r.epoch=d.epoch AND q.state='indexed') AS indexed_cursor
    FROM fleet_source_deltas d LEFT JOIN fleet_source_projection p ON p.cursor=d.cursor
    WHERE d.epoch=? AND d.cursor=COALESCE(
      (SELECT q.cursor FROM fleet_source_projection q JOIN fleet_source_deltas r ON r.cursor=q.cursor
        WHERE q.state='blocked' AND r.epoch=d.epoch ORDER BY q.cursor LIMIT 1),
      (SELECT max(r.cursor) FROM fleet_source_deltas r WHERE r.epoch=d.epoch))`).bind(epoch).first();
  if (!last) return null;
  return {cursor:last.cursor,state:last.state||(last.verified_at?'staged':'copying'),
    indexedCursor:last.indexed_cursor,rows:last.next_row||0,reason:last.reason||''};
}

async function sourceRecord(db,epoch,cursor,kind,machine,record) {
  const row=await db.prepare(`SELECT q.cursor,q.sha256,q.start_byte,q.end_byte,json_extract(d.manifest,'$.dataBytes') AS size
    FROM fleet_source_projection_rows q JOIN fleet_source_projection p ON p.cursor=q.cursor AND p.state='indexed'
    JOIN fleet_source_deltas d ON d.cursor=q.cursor AND d.epoch=?
    WHERE q.kind=? AND q.machine_id=? AND q.record_id=? AND q.cursor<=?
    ORDER BY q.cursor DESC LIMIT 1`).bind(epoch,kind,machine,record,cursor).first();
  if (!row) {
    const baseline=await db.prepare(`SELECT r.start_byte,r.end_byte,r.digest,json_extract(b.manifest,'$.dataBytes') AS size
      FROM fleet_baseline_rows r JOIN fleet_baseline b ON b.id=1 AND b.epoch=? AND b.verified_at IS NOT NULL
      JOIN fleet_baseline_projection p ON p.id=b.id AND p.epoch=b.epoch AND p.state='verified'
      WHERE r.kind=? AND r.machine_id=? AND r.record_id=?`).bind(epoch,kind,machine,record).first();
    return baseline?{data:await readIndexedBaselineRow(baselineReader(db,baseline.size),baseline),sha256:baseline.digest}:null;
  }
  if (!row.sha256) return null;
  const line=await sourceReader(db,row.cursor,row.size)(row.start_byte);
  const value=line.record?.record;
  if (line.next!==row.end_byte||typeof value!=='string'||await sha256(value)!==row.sha256) throw invalid();
  return {data:JSON.parse(value).data,sha256:row.sha256};
}

export async function verifiedSourceService(db,epoch,cursor,machineId,serviceId) {
  if (!validFleetRecordId(machineId)||!validFleetRecordId(serviceId)) throw fleetError(400,'invalid_source_target');
  const available=await db.prepare(`SELECT 1 AS found FROM fleet_source_deltas d JOIN fleet_source_projection p
    ON p.cursor=d.cursor AND p.state='indexed' WHERE d.epoch=? AND d.cursor=?`).bind(epoch,cursor).first('found');
  if (!available) throw fleetError(409,'source_delta_projection_unverified');
  const [machine,archive,history]=await Promise.all([
    sourceRecord(db,epoch,cursor,'machine',machineId,''),sourceRecord(db,epoch,cursor,'machine-archive',machineId,''),
    sourceRecord(db,epoch,cursor,'history',machineId,serviceId)
  ]);
  if (!machine||archive?.data?.active||history?.data?.type!=='service'||
      (machine.data.historyDeletedIds??[]).some(value=>String(value)===serviceId)) throw fleetError(404,'source_service_absent');
  return {epoch,cursor,machineId,serviceId,recordSha256:history.sha256,service:history.data};
}
