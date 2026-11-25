// Canonical snapshots are normalized at the write boundary. Keep hot reads
// and invoice progress independent of the size of unrelated bike histories.
export async function visibleSnapshotRow(env) {
  return await env.DB.prepare(`SELECT version, source, updated_at,
    CASE WHEN EXISTS (SELECT 1 FROM vehicle_archives WHERE active=1) THEN
      (SELECT COALESCE(json_group_array(json(b.value)), '[]') FROM json_each(s.data, '$.bikes') b
       WHERE NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id')))
    ELSE json_extract(data, '$.bikes') END AS bikes_json
    FROM fleet_snapshot s WHERE id=1`).first();
}

export async function snapshotSummary(env) {
  const row = await env.DB.prepare(`SELECT version, source, updated_at,
    (SELECT COUNT(*) FROM json_each(s.data,'$.bikes') b WHERE NOT EXISTS
      (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))) AS bikes
    FROM fleet_snapshot s WHERE id=1`).first();
  return { version: Number(row?.version || 0), source: row?.source || 'canonical', updatedAt: row?.updated_at || '', bikes: Number(row?.bikes || 0) };
}

const fleetCardFields = [
  'id', 'name', 'currentKm', 'lastServiceKm', 'nextServiceKm', 'intervalKm',
  'lastCheckedAt', 'createdAt', 'updatedAt', 'hasMajorService', 'lastMajorServiceKm',
  'lastMajorServiceMilestoneKm', 'pendingMajorServiceKm', 'nextMajorServiceKm', 'majorServiceTargetKm'
];

export function fleetCard(bike) {
  return Object.fromEntries(fleetCardFields.map(key => [key, bike[key]]));
}

export async function fleetCardRow(env, sinceVersion) {
  const fields = fleetCardFields.map(key => `'${key}', json_extract(b.value,'$.${key}')`).join(', ');
  return env.DB.prepare(`SELECT s.version, s.source, s.updated_at,
    CASE WHEN CAST(s.version AS TEXT)=? THEN NULL ELSE
      (SELECT COALESCE(json_group_array(bike_id), '[]') FROM vehicle_archives WHERE active=1) END AS archived_json,
    CASE WHEN CAST(s.version AS TEXT)=? THEN NULL ELSE
      (SELECT COALESCE(json_group_array(json_object(${fields})), '[]')
     FROM json_each(s.data,'$.bikes') b WHERE NOT EXISTS
     (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))) END AS bikes_json
    FROM fleet_snapshot s WHERE s.id=1 AND (CAST(s.version AS TEXT)=? OR json_type(s.data,'$.bikes')='array')`)
    .bind(sinceVersion, sinceVersion, sinceVersion).first();
}

export async function fleetQrCandidates(env) {
  const { results } = await env.DB.prepare(`SELECT json_extract(b.value,'$.id') AS bike_id, json_object(
    'id', json_extract(h.value,'$.id'), 'type', json_extract(h.value,'$.type'), 'updatedAt', json_extract(h.value,'$.updatedAt'),
    'invoiceData', json_object('qrJobId',json_extract(h.value,'$.invoiceData.qrJobId'),'qrUrl',json_extract(h.value,'$.invoiceData.qrUrl'),
      'qrProcessingStatus',json_extract(h.value,'$.invoiceData.qrProcessingStatus'),
      'qrProcessingUpdatedAt',json_extract(h.value,'$.invoiceData.qrProcessingUpdatedAt'),
      'qrProcessingStartedAt',json_extract(h.value,'$.invoiceData.qrProcessingStartedAt')),
    'attachments', json((SELECT COALESCE(json_group_array(json_object(
      'key',json_extract(a.value,'$.key'),'renderJobId',json_extract(a.value,'$.renderJobId'),
      'qrUrl',json_extract(a.value,'$.qrUrl'),'qrValue',json_extract(a.value,'$.qrValue'),
      'ocr',json_object('qrJobId',json_extract(a.value,'$.ocr.qrJobId'),'qrUrl',json_extract(a.value,'$.ocr.qrUrl')),
      'qrData',json_object('qrJobId',json_extract(a.value,'$.qrData.qrJobId'),'qrUrl',json_extract(a.value,'$.qrData.qrUrl'))
    )), '[]') FROM json_each(h.value,'$.attachments') a))) AS entry_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h
    WHERE s.id=1 AND (json_extract(h.value,'$.invoiceData.qrUrl') <> '' OR json_extract(h.value,'$.invoiceData.qrJobId') <> '')
    AND NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))`).all();
  return results;
}

// Read bounded canonical rows rather than one aggregate containing every
// invoice/history cell. A missing/partial native cursor is never an empty fleet.
export async function snapshotPage(env, cursor = '') {
  const summary = await snapshotSummary(env);
  const match = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null;
  if (cursor && !match) return { error: 'Μη έγκυρη θέση ανάγνωσης στόλου.', status: 400 };
  if (match && Number(match[1]) !== summary.version) return { error: 'Ο στόλος άλλαξε κατά την ανάγνωση. Δοκίμασε ξανά.', status: 409 };
  const offset = match ? Number(match[2]) : 0;
  if (!Number.isSafeInteger(offset) || offset > summary.bikes) return { error: 'Η θέση ανάγνωσης στόλου άλλαξε.', status: 409 };
  const result = await env.DB.prepare(`SELECT b.value AS bike_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b
    WHERE s.id=1 AND s.version=? AND NOT EXISTS
      (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))
    ORDER BY CAST(b.key AS INTEGER) LIMIT 4 OFFSET ?`).bind(summary.version, offset).all();
  const after = await snapshotSummary(env);
  if (after.version !== summary.version || after.bikes !== summary.bikes) return { error: 'Ο στόλος άλλαξε κατά την ανάγνωση. Δοκίμασε ξανά.', status: 409 };
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length !== Math.min(4, summary.bikes - offset)) throw new Error('Δεν διαβάστηκε ο πλήρης στόλος. Τα δεδομένα διατηρούνται.');
  const bikes = rows.map(row => {
    if (typeof row.bike_json !== 'string') throw new Error('Δεν διαβάστηκε η καταχώρηση μηχανής.');
    const bike = JSON.parse(row.bike_json);
    if (!bike || !bike.id || !bike.name) throw new Error('Ελλιπή στοιχεία μηχανής στον Server.');
    return bike;
  });
  const next = offset + bikes.length;
  return { paged: true, bikes, version: summary.version, source: summary.source, totalBikes: summary.bikes,
    offset, hasMore: next < summary.bikes, nextCursor: next < summary.bikes ? summary.version + ':' + next : '' };
}

// Invoice targets use the same 100-character IDs as the Fleet snapshot.
// Some restored snapshots contain numeric IDs. Compare their complete text
// representation without ever resolving a truncated ID or guessing a parent.
export function fleetRecordId(value) {
  const id = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return id.length <= 100 && id === id.trim() ? id : '';
}

export async function readServiceEntry(env, bikeId, entryId) {
  bikeId=fleetRecordId(bikeId);entryId=fleetRecordId(entryId);
  if (!bikeId || !entryId) return null;
  const {results}=await env.DB.prepare(`SELECT s.version, b.key AS bike_index, h.key AS entry_index,
    json_extract(b.value,'$.id') AS bike_id, json_extract(b.value,'$.name') AS bike_name, json_extract(b.value,'$.currentKm') AS current_km, h.value AS entry_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h
    WHERE s.id=1 AND json_type(b.value,'$.id') IN ('text','integer') AND CAST(json_extract(b.value,'$.id') AS TEXT)=?
    AND json_type(h.value,'$.id') IN ('text','integer') AND CAST(json_extract(h.value,'$.id') AS TEXT)=?
    AND NOT EXISTS (SELECT 1 FROM json_each(b.value,'$.historyDeletedIds') d WHERE CAST(d.value AS TEXT)=?)
    AND NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=?) LIMIT 2`)
    .bind(bikeId, entryId, entryId, bikeId).all();
  if (results.length!==1) return null;
  const [row]=results;
  return { version: Number(row.version), bikeIndex: Number(row.bike_index), entryIndex: Number(row.entry_index),
    bike: { id: bikeId, name: row.bike_name, currentKm: Number(row.current_km || 0) }, entryJson: row.entry_json, entry: JSON.parse(row.entry_json) };
}

export async function writeServiceEntry(env, located, entry, source, now, renderJobId = "") {
  const entryPath = `$.bikes[${located.bikeIndex}].history[${located.entryIndex}]`;
  const bikeTimePath = `$.bikes[${located.bikeIndex}].updatedAt`;
  const result = await env.DB.prepare(`UPDATE fleet_snapshot SET data=json_set(data, ?, json(?), ?, ?),
    version=version+1, source=?, updated_at=? WHERE id=1 AND CAST(json_extract(data,?) AS TEXT)=? AND json_extract(data,?)=? AND (?='' OR NOT EXISTS (SELECT 1 FROM fleet_operations WHERE id=? AND status='cancelled'))`)
    .bind(entryPath, JSON.stringify(entry), bikeTimePath, now, source, now,
      `$.bikes[${located.bikeIndex}].id`, String(located.bike.id), entryPath, located.entryJson,renderJobId,renderJobId).run();
  if (!Number(result.meta?.changes || 0)) return 0;
  const row = await env.DB.prepare("SELECT version FROM fleet_snapshot WHERE id=1").first();
  return Number(row.version);
}

export async function fleetNames(env) {
  const rows = await env.DB.prepare(`SELECT json_extract(b.value,'$.id') AS id, json_extract(b.value,'$.name') AS name
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b WHERE s.id=1 AND NOT EXISTS
    (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id'))`).all();
  return rows.results || [];
}

export async function readServiceDocument(env, key) {
  const row = await env.DB.prepare(`SELECT json_extract(b.value,'$.id') AS bike_id, json_extract(h.value,'$.id') AS entry_id
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h, json_each(h.value,'$.attachments') a
    WHERE s.id=1 AND json_extract(a.value,'$.key')=? LIMIT 1`).bind(key).first();
  return row ? readServiceEntry(env, row.bike_id, row.entry_id) : null;
}

export async function fleetRegistrySnapshot(env) {
  const rows = await env.DB.prepare(`SELECT s.version, json_object(
    'id', json_extract(b.value,'$.id'), 'name', json_extract(b.value,'$.name'),
    'currentKm', json_extract(b.value,'$.currentKm'), 'nextServiceKm', json_extract(b.value,'$.nextServiceKm'),
    'lastServiceKm', json_extract(b.value,'$.lastServiceKm'), 'intervalKm', json_extract(b.value,'$.intervalKm'),
    'majorServiceTargetKm', json_extract(b.value,'$.majorServiceTargetKm'), 'lastMajorServiceKm', json_extract(b.value,'$.lastMajorServiceKm'),
    'lastCheckedAt', json_extract(b.value,'$.lastCheckedAt'), 'createdAt', json_extract(b.value,'$.createdAt')) AS bike_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b WHERE s.id=1 AND NOT EXISTS
    (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id')) ORDER BY json_extract(b.value,'$.id')`).all();
  return { version: Number(rows.results?.[0]?.version || 0), data: { bikes: (rows.results || []).map(row => JSON.parse(row.bike_json)) } };
}

export async function readSnapshotBike(env, id, { activeOnly = false } = {}) {
  id=fleetRecordId(id);
  if (!id) return null;
  const {results}=await env.DB.prepare(`SELECT s.version, b.key AS bike_index, b.value AS bike_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b WHERE s.id=1 AND json_type(b.value,'$.id') IN ('text','integer')
    AND CAST(json_extract(b.value,'$.id') AS TEXT)=?
    ${activeOnly ? "AND NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=CAST(json_extract(b.value,'$.id') AS TEXT))" : ''}
    LIMIT 2`).bind(id).all();
  if (results.length!==1) return null;
  const [row]=results;
  return { version:Number(row.version), index:Number(row.bike_index), json:row.bike_json, bike:{...JSON.parse(row.bike_json),id} };
}

export async function writeSnapshotBike(env, located, bike, source, now) {
  let result;
  if (located) {
    const path=`$.bikes[${located.index}]`;
    result=await env.DB.prepare(`UPDATE fleet_snapshot SET data=json_set(data,?,json(?)), version=version+1, source=?, updated_at=?
      WHERE id=1 AND json_extract(data,?)=? AND NOT EXISTS (SELECT 1 FROM vehicle_archives WHERE active=1 AND bike_id=?)`)
      .bind(path,JSON.stringify(bike),source,now,path,located.json,bike.id).run();
  } else {
    result=await env.DB.prepare(`UPDATE fleet_snapshot SET data=json_insert(data,'$.bikes[#]',json(?)), version=version+1, source=?, updated_at=?
      WHERE id=1 AND json_array_length(data,'$.bikes') < 40
      AND NOT EXISTS (SELECT 1 FROM json_each(data,'$.bikes') b WHERE CAST(json_extract(b.value,'$.id') AS TEXT)=?)
      AND NOT EXISTS (SELECT 1 FROM vehicle_archives WHERE active=1 AND bike_id=?)`)
      .bind(JSON.stringify(bike),source,now,bike.id,bike.id).run();
  }
  if (!Number(result.meta?.changes || 0)) return 0;
  return Number((await env.DB.prepare('SELECT version FROM fleet_snapshot WHERE id=1').first()).version);
}
