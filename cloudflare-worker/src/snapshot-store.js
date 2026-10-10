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

export async function readServiceEntry(env, bikeId, entryId) {
  const row = await env.DB.prepare(`SELECT s.version, b.key AS bike_index, h.key AS entry_index,
    json_extract(b.value,'$.id') AS bike_id, json_extract(b.value,'$.name') AS bike_name, json_extract(b.value,'$.currentKm') AS current_km, h.value AS entry_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h
    WHERE s.id=1 AND json_extract(b.value,'$.id')=? AND json_extract(h.value,'$.id')=?
    AND NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id')) LIMIT 1`)
    .bind(String(bikeId), String(entryId)).first();
  if (!row) return null;
  return { version: Number(row.version), bikeIndex: Number(row.bike_index), entryIndex: Number(row.entry_index),
    bike: { id: row.bike_id, name: row.bike_name, currentKm: Number(row.current_km || 0) }, entryJson: row.entry_json, entry: JSON.parse(row.entry_json) };
}

export async function writeServiceEntry(env, located, entry, source, now) {
  const entryPath = `$.bikes[${located.bikeIndex}].history[${located.entryIndex}]`;
  const bikeTimePath = `$.bikes[${located.bikeIndex}].updatedAt`;
  const result = await env.DB.prepare(`UPDATE fleet_snapshot SET data=json_set(data, ?, json(?), ?, ?),
    version=version+1, source=?, updated_at=? WHERE id=1 AND json_extract(data,?)=? AND json_extract(data,?)=?`)
    .bind(entryPath, JSON.stringify(entry), bikeTimePath, now, source, now,
      `$.bikes[${located.bikeIndex}].id`, String(located.bike.id), entryPath, located.entryJson).run();
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

export async function readSnapshotBike(env, id) {
  const row = await env.DB.prepare(`SELECT s.version, b.key AS bike_index, b.value AS bike_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b WHERE s.id=1 AND json_extract(b.value,'$.id')=? LIMIT 1`).bind(id).first();
  return row ? { version:Number(row.version), index:Number(row.bike_index), json:row.bike_json, bike:JSON.parse(row.bike_json) } : null;
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
      AND NOT EXISTS (SELECT 1 FROM json_each(data,'$.bikes') b WHERE json_extract(b.value,'$.id')=?)
      AND NOT EXISTS (SELECT 1 FROM vehicle_archives WHERE active=1 AND bike_id=?)`)
      .bind(JSON.stringify(bike),source,now,bike.id,bike.id).run();
  }
  if (!Number(result.meta?.changes || 0)) return 0;
  return Number((await env.DB.prepare('SELECT version FROM fleet_snapshot WHERE id=1').first()).version);
}
