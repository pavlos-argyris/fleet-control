import assert from 'node:assert/strict';
import {WORKFORCE_SCHEMA,d1ExecScript,ensureWorkforceSchema} from '../cloudflare-worker/src/workforce.js';
import {MIRROR_SCHEMA,mirrorDelta} from '../cloudflare-worker/src/mirror-delta.js';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
const oldSchema=WORKFORCE_SCHEMA.replace("('fleet_history','shift','schedule_assignment','employee')","('fleet_history','shift','schedule_assignment')").replace('  login_enabled INTEGER NOT NULL DEFAULT 1,\n','').replace('  deleted_at TEXT,\n','').replace('  hours_source TEXT,\n','');
async function seed(){
 const fixture=createSimulation();await fixture.db.exec(d1ExecScript(oldSchema));
 await fixture.db.exec('CREATE TABLE invoice_import_drafts(id TEXT)');await fixture.db.exec(MIRROR_SCHEMA);
 fixture.db.sqlite.prepare("INSERT INTO app_users(id,full_name,username,password_hash,password_salt,created_at,updated_at) VALUES ('legacy','Legacy Staff','legacy','fixture-hash','fixture-salt','old','old')").run();
 for(const n of [17,91])fixture.db.sqlite.prepare("INSERT INTO deleted_records(rowid,id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name,reason) VALUES (?,?,'fleet_history',?,'Preserved record','{\"entry\":{\"notes\":\"αρχικό\"}}','old','legacy','Legacy Staff','unchanged')").run(n,'deleted-'+n,'record-'+n);
 return fixture;
}
const fixture=await seed(),before=fixture.db.sqlite.prepare('SELECT rowid,* FROM deleted_records ORDER BY rowid').all().map(x=>({...x}));
await ensureWorkforceSchema(fixture.env);await fixture.db.exec(MIRROR_SCHEMA);
assert.deepEqual(fixture.db.sqlite.prepare('SELECT rowid,* FROM deleted_records ORDER BY rowid').all().map(x=>({...x})),before,'archive bytes and row identities survive CHECK migration');
assert.equal(fixture.db.sqlite.prepare("SELECT login_enabled FROM app_users WHERE id='legacy'").get().login_enabled,1,'old accounts keep login enabled');
assert.equal(fixture.db.sqlite.prepare("SELECT deleted_at FROM app_users WHERE id='legacy'").get().deleted_at,null);
const head=fixture.db.sqlite.prepare('SELECT epoch FROM fleet_mirror_state').get();
const response=await mirrorDelta(new Request('https://fixture/api/server/system-export/delta?epoch='+head.epoch+'&cursor=0'),fixture.env,async()=>true),delta=await response.json();
assert.equal(response.status,200);for(const row of before)assert.ok(delta.changes.some(c=>c.table==='deleted_records'&&c.rowId===row.rowid&&c.row?.id===row.id),'pre-migration journal still resolves exact archived row');
fixture.db.sqlite.prepare("INSERT INTO deleted_records(id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name) VALUES ('staff-trash','employee','legacy','Legacy Staff','{}','now','legacy','Legacy Staff')").run();
assert.ok(fixture.db.sqlite.prepare("SELECT 1 FROM fleet_mirror_changes WHERE table_name='deleted_records' AND row_id=(SELECT rowid FROM deleted_records WHERE id='staff-trash')").get(),'mirror triggers reinstalled');
await ensureWorkforceSchema(fixture.env);assert.equal(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM deleted_records').get().n,3,'migration is repeatable');

const failing=await seed(),prepare=failing.db.prepare.bind(failing.db);
failing.db.prepare=sql=>sql==='DROP TABLE deleted_records'?{run:async()=>{throw new Error('Deliberate synthetic migration fault');}}:prepare(sql);
await assert.rejects(()=>ensureWorkforceSchema(failing.env));
assert.deepEqual(failing.db.sqlite.prepare('SELECT rowid,* FROM deleted_records ORDER BY rowid').all().map(x=>({...x})),before,'failed copy/swap rolls back the complete migration');
assert.equal(failing.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='deleted_records_issue7'").get().n,0);
failing.db.prepare=prepare;await ensureWorkforceSchema(failing.env);
assert.equal(failing.db.sqlite.prepare('SELECT COUNT(*) AS n FROM deleted_records').get().n,2,'retry preserves records');
console.log('PASS old workforce migration: preserved archive contents and rowids, default-enabled old accounts, valid mirror cursor/trigger identities, repeatability and atomic rollback/retry after an injected copy/swap failure.');
