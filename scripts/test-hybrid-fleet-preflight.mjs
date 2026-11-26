import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compareFleetPreflights, inspectNativeFleetBackup } from './hybrid-fleet-preflight.mjs';
import { prepareNativeInvoicePlan } from './hybrid-fleet-invoice-plan.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-private-preflight-'));
const database=path.join(folder,'snapshot.sqlite');
const copied=path.join(folder,'isolated-restore.sqlite');
const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp='2026-11-25T11:00:00.000Z';
const filename='a'.repeat(64)+'-'+'b'.repeat(64)+'.pdf';
const objectPath=path.join(folder,filename);
const key='service-documents/synthetic-machine/service/synthetic-file';
const content=Buffer.from('%PDF-1.4\nSynthetic test bytes\n%%EOF');
try {
  fs.writeFileSync(objectPath,content);
  let db=new DatabaseSync(database);
  db.exec(`
    PRAGMA application_id=1179407440;
    CREATE TABLE native_primary_state(id INTEGER PRIMARY KEY,phase TEXT,generation TEXT);
    INSERT INTO native_primary_state VALUES(1,'needs_recovery','');
    CREATE TABLE fleet_snapshot(id INTEGER PRIMARY KEY,version INTEGER,data TEXT,updated_at TEXT);
    CREATE TABLE vehicle_archives(bike_id TEXT PRIMARY KEY,snapshot_json TEXT);
    CREATE TABLE vehicle_registry(bike_id TEXT PRIMARY KEY,odometer INTEGER,active_shift_id TEXT);
    CREATE TABLE deleted_records(id TEXT PRIMARY KEY,record_type TEXT,payload TEXT);
    CREATE TABLE invoice_import_drafts(id TEXT PRIMARY KEY,data TEXT,status TEXT);
    CREATE TABLE fleet_operations(id TEXT PRIMARY KEY,type TEXT,payload TEXT,status TEXT);
    CREATE TABLE audit_log(id TEXT PRIMARY KEY,object_type TEXT,new_value TEXT);
    CREATE TABLE native_objects(key TEXT PRIMARY KEY,local_name TEXT,name TEXT,content_type TEXT,size INTEGER,sha256 TEXT,deleted_at TEXT);
    CREATE TABLE app_users(id TEXT PRIMARY KEY,username TEXT);
    CREATE TABLE shifts(id TEXT PRIMARY KEY,employee_id TEXT REFERENCES app_users(id));
    INSERT INTO app_users VALUES('synthetic-owner','private-fixture-user');
    INSERT INTO shifts VALUES('private-fixture-shift','synthetic-owner');
  `);
  const attachment={id:'doc',key,ocr:{invoiceNumber:'synthetic-private-number',invoiceDate:'2026-12-02',plate:'EXAMPLE',
    totalAmount:'124,00',netAmount:'100,00',vatAmount:'24,00',targetedOperationId:'synthetic-op'}};
  const service={id:'service',type:'service',km:4500,date:'2026-11-25',tasks:['Έλεγχος'],notes:'Synthetic',attachments:[attachment]};
  const knownQr='https://einvoice.impact.gr/p/SYNTHETIC-RECOVERY';
  const machine={id:'synthetic-machine',name:'Synthetic machine',createdAt:stamp,history:[service,
    {id:'other',type:'service',cost:'30,00',attachments:[],invoiceData:{qrJobId:'synthetic-truncated',qrUrl:knownQr,qrProcessingStatus:'error'}},
    {id:'shift-private-fixture-shift',type:'check',km:4501}]};
  const fleet={bikes:[machine]};
  db.prepare('INSERT INTO fleet_snapshot VALUES(1,37,?,?)').run(JSON.stringify(fleet),stamp);
  db.prepare('INSERT INTO vehicle_registry VALUES(?,?,?)').run(machine.id,4501,'private-fixture-shift');
  db.prepare('INSERT INTO vehicle_archives VALUES(?,?)').run('synthetic-archive',JSON.stringify({history:[{...service,id:'archive-entry'}]}));
  db.prepare('INSERT INTO deleted_records VALUES(?,?,?)').run('synthetic-delete','fleet_history',JSON.stringify({bikeId:machine.id,entry:service}));
  db.prepare('INSERT INTO deleted_records VALUES(?,?,?)').run('private-fixture-shift','shift','{"employeeId":"private-fixture-user"}');
  db.prepare('INSERT INTO invoice_import_drafts VALUES(?,?,?)').run('synthetic-draft','{}','ready');
  db.prepare('INSERT INTO fleet_operations VALUES(?,?,?,?)').run('synthetic-job','service_document_render',
    JSON.stringify({bikeId:machine.id,entryId:service.id,targetedOperationId:'synthetic-op'}),'pending');
  db.prepare('INSERT INTO fleet_operations VALUES(?,?,?,?)').run('synthetic-truncated','service_document_render',
    JSON.stringify({bikeId:'synthetic-mach',entryId:'other',qrUrl:knownQr}),'error');
  db.prepare('INSERT INTO audit_log VALUES(?,?,?)').run('synthetic-audit','service_document','{"safe":"fixture"}');
  db.prepare('INSERT INTO audit_log VALUES(?,?,?)').run('private-fixture-audit','employee','{"private":"private-fixture-user"}');
  db.prepare('INSERT INTO native_objects VALUES(?,?,?,?,?,?,NULL)').run(key,filename,'synthetic.pdf','application/pdf',content.length,hash(content));
  db.close();

  function manifest(file) {
    const check=new DatabaseSync(file,{readOnly:true});
    const {application_id}=check.prepare('PRAGMA application_id').get();
    const tableSchemaHash=createHash('sha256');
    const tables=check.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name,sql})=>{
      const {rows}=check.prepare('SELECT COUNT(*) AS rows FROM '+name).get();
      tableSchemaHash.update(name+'\0'+sql+'\0'+rows+'\n');
      return {name,rows};
    });
    const objects=check.prepare('SELECT key,local_name,name,content_type,size,sha256 FROM native_objects WHERE deleted_at IS NULL').all();
    check.close();
    const bytes=fs.readFileSync(file);
    return {applicationId:application_id,schemaVersion:1,tables,objects,schemaInventorySha256:tableSchemaHash.digest('hex'),
      capturedAt:stamp,size:bytes.length,sha256:hash(bytes),sessionsExcluded:true,deviceIdentityExcluded:true};
  }
  const native=manifest(database);
  const options={database,manifest:native,objects:folder};
  const original=inspectNativeFleetBackup(options);
  const invoicePlan=await prepareNativeInvoicePlan(options);
  assert.equal(invoicePlan.count,3);
  assert.match(invoicePlan.manifestHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(invoicePlan.jobs.map(job=>job.source),['legacy-operation','legacy-operation','legacy-draft']);
  assert.equal(invoicePlan.jobs[0].machineId,machine.id);
  assert.equal(invoicePlan.jobs[0].serviceId,service.id);
  assert.equal(invoicePlan.jobs[1].machineId,machine.id);
  assert.equal(invoicePlan.jobs[1].serviceId,'other');
  assert.equal(invoicePlan.jobs[1].reviewReason,undefined);
  assert.equal(JSON.parse(invoicePlan.originals[1].record.payload).bikeId,'synthetic-mach');
  assert.equal(invoicePlan.jobs[2].reviewReason,'original_service_not_verified');
  assert.doesNotMatch(JSON.stringify(invoicePlan),/private-fixture-user|private-fixture-shift/);
  assert.equal(original.integrityVerified,true);
  assert.equal(original.cutoverVerified,false);
  assert.equal(original.inventory.history.count,3);
  assert.equal(original.inventory.machineArchives.count,1);
  assert.equal(original.inventory.historyTrash.count,1);
  assert.equal(original.inventory.fleetAudit.count,1);
  assert.equal(original.inventory.pendingInvoiceJobs.count,2);
  assert.equal(original.totals.invoiceGrossCents,12400);
  assert.equal(original.totals.serviceCents,15400);
  assert.equal(original.files.missing,0);
  assert.doesNotMatch(JSON.stringify(original),/private-fixture|synthetic-private-number|synthetic-machine/);
  fs.copyFileSync(database,copied);
  const restored=inspectNativeFleetBackup({...options,database:copied});
  assert.deepEqual(compareFleetPreflights(original,restored),{matches:true,mismatches:[]});
  assert.equal((await prepareNativeInvoicePlan({...options,database:copied})).manifestHash,invoicePlan.manifestHash);
  db=new DatabaseSync(copied);
  fleet.bikes[0].history[0].attachments[0].ocr.totalAmount='127,00';
  db.prepare('UPDATE fleet_snapshot SET data=? WHERE id=1').run(JSON.stringify(fleet));
  db.close();
  assert.throws(()=>inspectNativeFleetBackup({...options,database:copied}),/checksum differs/);
  const changed=inspectNativeFleetBackup({...options,database:copied,manifest:manifest(copied)});
  assert(changed.blockingReasons.includes('source_invoice_amount_mismatch'));
  assert.deepEqual(compareFleetPreflights(original,changed),{matches:false,mismatches:['inventory','totals']});
  fs.writeFileSync(objectPath,Buffer.from(content).fill('x'));
  assert.throws(()=>inspectNativeFleetBackup(options),/bytes or checksum differ/);
  assert.equal(hash(fs.readFileSync(database)),native.sha256);
  console.log('PASS read-only native SQLite Fleet scope, stable IDs and hashes, attachments, pending jobs, isolated copy and exact cost reconciliation.');
} finally { fs.rmSync(folder,{recursive:true,force:true}); }
