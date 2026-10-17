// Coalesced change journal. Canonical rows remain in the original tables.
export const MIRROR_TABLES=['app_users','registered_devices','vehicle_registry','vehicle_archives','shift_templates','schedule_assignments','schedule_week_drafts','schedule_publications','schedule_acknowledgements','schedule_vehicle_waivers','schedules','shifts','vehicle_segments','correction_requests','pay_rules','pay_rule_versions','special_rates','special_rate_assignments','payroll_segments','payroll_periods','payroll_adjustments','payroll_snapshots','system_alerts','alert_rules','audit_log','system_settings','deleted_records','invoice_import_drafts'];
export const MIRROR_SCHEMA=[
 "CREATE TABLE IF NOT EXISTS fleet_mirror_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,floor INTEGER NOT NULL DEFAULT 0);",
 "INSERT OR IGNORE INTO fleet_mirror_state(id,epoch) VALUES(1,lower(hex(randomblob(16))));",
 "CREATE TABLE IF NOT EXISTS fleet_mirror_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT NOT NULL,row_id INTEGER NOT NULL,UNIQUE(table_name,row_id));",
 ...MIRROR_TABLES.flatMap(table=>['INSERT','UPDATE','DELETE'].map(event=>{
  const mark=alias=>`INSERT INTO fleet_mirror_changes(table_name,row_id) VALUES('${table}',${alias}.rowid) ON CONFLICT(table_name,row_id) DO UPDATE SET seq=excluded.seq;`;
  const old=event==='UPDATE'?`INSERT INTO fleet_mirror_changes(table_name,row_id) SELECT '${table}',OLD.rowid WHERE OLD.rowid<>NEW.rowid ON CONFLICT(table_name,row_id) DO UPDATE SET seq=excluded.seq;`:'';
  return `CREATE TRIGGER IF NOT EXISTS fleet_mirror_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${old}${mark(event==='DELETE'?'OLD':'NEW')} END;`;
 }))
].join('\n');
export async function mirrorHead(env){return env.DB.prepare("SELECT epoch,floor,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='fleet_mirror_changes'),0) AS cursor,COALESCE((SELECT CAST(c.seq AS TEXT) FROM fleet_mirror_changes c JOIN system_settings s ON s.rowid=c.row_id WHERE c.table_name='system_settings' AND s.key='invoice_reader_rules'),(SELECT updated_at FROM system_settings WHERE key='invoice_reader_rules'),'') AS rulesRevision FROM fleet_mirror_state WHERE id=1").first();}
const reply=(data,status=200)=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'}});
export async function mirrorDelta(request,env,authorized){
 if(!await authorized(request,env))return reply({error:'Μη έγκυρος Server.'},401);
 const url=new URL(request.url),head=await mirrorHead(env),cursor=Number(url.searchParams.get('cursor'));
 if(!Number.isSafeInteger(cursor)||cursor<0)return reply({error:'Μη έγκυρος δείκτης αντιγράφου.'},400);
 if(url.searchParams.get('epoch')!==head.epoch||cursor<Number(head.floor)||cursor>Number(head.cursor))return reply({resetRequired:true,...head});
 const requested=Number(url.searchParams.get('until')),until=Number.isSafeInteger(requested)&&requested>=cursor&&url.searchParams.has('until')?Math.min(requested,Number(head.cursor)):Number(head.cursor);
 const page=(await env.DB.prepare('SELECT seq,table_name,row_id FROM fleet_mirror_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT 20').bind(cursor,until).all()).results||[],parts=[];
 // At most 20 rows. SQL builds JSON without expanding whole tables in JS.
 for(const table of new Set(page.map(r=>r.table_name))){
  if(!MIRROR_TABLES.includes(table))throw new Error('Unknown mirror table');
  const columns=(await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results||[];
  const fields=columns.flatMap(c=>["'"+c.name.replace(/'/g,"''")+"'",'t."'+c.name.replace(/"/g,'""')+'"']).join(',');
  const selected=page.filter(r=>r.table_name===table),source=selected.map(()=>`SELECT ? AS row_id,? AS seq`).join(' UNION ALL ');
  // Captured ids are independent of later coalescing in the journal.
  const row=await env.DB.prepare(`SELECT COALESCE(json_group_array(json_object('table','${table}','rowId',c.row_id,'seq',c.seq,'row',CASE WHEN t.rowid IS NULL THEN NULL ELSE json_object(${fields}) END)),'[]') AS data FROM (${source}) c LEFT JOIN ${table} t ON t.rowid=c.row_id`).bind(...selected.flatMap(r=>[r.row_id,r.seq])).first();
  const raw=row?.data||'[]';if(raw.length>2)parts.push(raw.slice(1,-1));
 }
 const next=page.length?Number(page[page.length-1].seq):until;
 const more=Boolean(await env.DB.prepare('SELECT 1 AS found FROM fleet_mirror_changes WHERE seq>? AND seq<=? LIMIT 1').bind(next,until).first());
 return reply('{"changes":['+parts.join(',')+'],'+JSON.stringify({epoch:head.epoch,until,nextCursor:more?next:until,hasMore:more}).slice(1));
}
export async function trimMirrorJournal(env){
 const head=await mirrorHead(env),floor=Math.max(0,Number(head.cursor)-50000);
 if(floor<=Number(head.floor))return;
 await env.DB.batch([env.DB.prepare('UPDATE fleet_mirror_state SET floor=MAX(floor,?) WHERE id=1').bind(floor),env.DB.prepare('DELETE FROM fleet_mirror_changes WHERE seq<=?').bind(floor)]);
}
