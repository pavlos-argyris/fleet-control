import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stableReviewJson } from '../cloudflare-worker/src/invoice-review-store.js';
import '../cloudflare-worker/public/service-model.js';

const APP_ID = 0x464c5450;
const DIGEST = /^[a-f0-9]{64}$/;
const OBJECT_FILE = /^[a-f0-9]{64}-[a-f0-9]{64}\.(pdf|png|jpg|webp|bin)$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (condition,message) => { if (!condition) throw new Error(message); };
const quoteIdentifier = name => {
  check(/^[a-zA-Z_][a-zA-Z0-9_]{0,120}$/.test(name),'Unsupported native schema identifier');
  return '"' + name + '"';
};

function fileProof(filename) {
  const information=lstatSync(filename);
  check(information.isFile() && !information.isSymbolicLink(),'Expected a regular private backup file');
  const file=openSync(filename,'r');
  try {
    const digest=createHash('sha256'), buffer=Buffer.alloc(65536);
    let size=0, count;
    while ((count=readSync(file,buffer,0,buffer.length,null))) {
      size+=count;
      digest.update(buffer.subarray(0,count));
    }
    check(size===information.size,'Backup file changed while reading it');
    return {size,sha256:digest.digest('hex')};
  } finally { closeSync(file); }
}

function verifyNativeSchema(db, manifest) {
  const {application_id}=db.prepare('PRAGMA application_id').get();
  check(application_id===APP_ID && manifest.applicationId===APP_ID && manifest.schemaVersion===1 &&
    manifest.sessionsExcluded===true && manifest.deviceIdentityExcluded===true && Number.isFinite(Date.parse(manifest.capturedAt)),
  'Expected a verified NativeDatabaseSnapshot v1 backup');
  const integrity=db.prepare('PRAGMA integrity_check').all();
  check(integrity.length===1 && integrity[0].integrity_check==='ok','SQLite integrity check failed');
  check(db.prepare('PRAGMA foreign_key_check').all().length===0,'SQLite foreign-key check failed');
  const tables=db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const expected=manifest.tables;
  check(Array.isArray(expected) && tables.length===expected.length,'Native backup table inventory differs');
  const digest=createHash('sha256');
  for (const [index,{name,sql}] of tables.entries()) {
    const count=db.prepare('SELECT count(*) AS rows FROM '+quoteIdentifier(name)).get().rows;
    check(expected[index]?.name===name && expected[index]?.rows===count,'Native backup table count differs');
    digest.update(name+'\0'+sql+'\0'+count+'\n');
  }
  check(digest.digest('hex')===manifest.schemaInventorySha256,'Native backup schema fingerprint differs');
  const state=db.prepare('SELECT phase,generation FROM native_primary_state WHERE id=1').get();
  check(state?.phase==='needs_recovery' && state.generation==='','Expected the sanitized backup SQLite, not the live database');
}

function createInventory() {
  const categories=new Map();
  return {
    put(kind, identity, row) {
      const key=stableReviewJson(identity);
      const entries=categories.get(kind) || new Map();
      check(!entries.has(key),'A Fleet ID is repeated inside its scope');
      entries.set(key,hash(stableReviewJson(row)));
      categories.set(kind,entries);
    },
    proof() {
      return Object.fromEntries([...categories].sort().map(([kind,rows]) => {
        const sorted=[...rows].sort(([a],[b])=>a<b?-1:a>b?1:0);
        return [kind,{count:sorted.length,idsSha256:hash(stableReviewJson(sorted.map(([id])=>id))),
          rowsSha256:hash(stableReviewJson(sorted))}];
      }));
    }
  };
}

function collectFiles(entry, keys) {
  check(Array.isArray(entry.attachments ?? []),'Invalid service attachment list');
  for (const attachment of entry.attachments ?? []) {
    check(attachment && typeof attachment.key==='string','Missing Fleet attachment key');
    keys.add(attachment.key);
    if (attachment.sourcePhoto) {
      check(typeof attachment.sourcePhoto.key==='string','Missing Fleet photograph key');
      keys.add(attachment.sourcePhoto.key);
    }
  }
}

function verifyFiles(db, manifest, folder, keys, inventory) {
  const listed=new Map((manifest.objects||[]).map(row=>[row.key,row]));
  check(listed.size===(manifest.objects||[]).length,'Duplicate object key in native manifest');
  const available=new Set();
  const rows=db.prepare(`SELECT key,local_name,name,content_type,size,sha256 FROM native_objects
    WHERE deleted_at IS NULL AND key LIKE 'service-documents/%' ORDER BY key`);
  let bytes=0;
  for (const row of rows.iterate()) {
    check(OBJECT_FILE.test(row.local_name) && DIGEST.test(row.sha256) && Number.isSafeInteger(row.size) && row.size>0,
      'Invalid Fleet file inventory');
    check(stableReviewJson(row)===stableReviewJson(listed.get(row.key)),'Native Fleet object entry differs from manifest');
    check(folder,'A verified private copy of the Fleet documents is required');
    const proof=fileProof(resolve(folder,row.local_name));
    check(proof.size===row.size && proof.sha256===row.sha256,'Fleet document bytes or checksum differ');
    available.add(row.key);
    inventory.put('files',[row.key],row);
    bytes+=row.size;
  }
  for (const key of listed.keys()) {
    if (key.startsWith('service-documents/')) check(available.has(key),'A Fleet file from the native inventory is missing');
  }
  const missing=[...keys].filter(key=>!available.has(key)).length;
  const unreferenced=[...available].filter(key=>!keys.has(key)).length;
  return {count:available.size,bytes,referenced:keys.size,missing,unreferenced};
}

function inspectFleet(db, native, objects) {
  const inventory=createInventory(), machineIds=new Set(), serviceKeys=new Set(), fileKeys=new Set(), draftIds=new Set();
  const invoiceLinks=new Set();
  const totals={serviceCents:0,invoiceNetCents:0,invoiceVatCents:0,invoiceGrossCents:0,manualServiceCents:0,
    invoices:0,missingInvoiceGross:0,servicesWithoutAmount:0,invoiceAmountDiscrepancies:0,duplicateInvoiceLinks:0};
  const snapshot=db.prepare('SELECT version,data,updated_at FROM fleet_snapshot WHERE id=1').get();
  check(snapshot && Number.isSafeInteger(snapshot.version),'Missing canonical Fleet snapshot');
  const fleet=JSON.parse(snapshot.data);
  check(Array.isArray(fleet.bikes),'Invalid canonical Fleet snapshot');
  const model=globalThis.FleetServiceModel;
  function inspectEntry(bikeId, entry, group) {
    check(typeof entry?.id==='string' && entry.id && ['service','check'].includes(entry.type),'Invalid Fleet history record');
    inventory.put(group,[bikeId,entry.id],entry);
    collectFiles(entry,fileKeys);
    if (group!=='history' || entry.type!=='service') return;
    serviceKeys.add(stableReviewJson([bikeId,entry.id]));
    const attachments=entry.attachments||[];
    if (!attachments.length) {
      const amount=model.cents(entry.cost);
      if (amount===null) totals.servicesWithoutAmount++;
      else { totals.manualServiceCents+=amount; totals.serviceCents+=amount; }
    }
    for (const attachment of attachments) {
      if (invoiceLinks.has(attachment.key)) totals.duplicateInvoiceLinks++;
      invoiceLinks.add(attachment.key);
      const info=model.invoice(attachment), amounts=model.amounts(info);
      totals.invoices++;
      if (amounts.mismatch) totals.invoiceAmountDiscrepancies++;
      totals.invoiceNetCents+=amounts.net??0;
      totals.invoiceVatCents+=amounts.vat??0;
      if (amounts.gross===null) totals.missingInvoiceGross++;
      else { totals.invoiceGrossCents+=amounts.gross; totals.serviceCents+=amounts.gross; }
      inventory.put('invoices',[bikeId,entry.id,attachment.key],attachment);
    }
  }
  for (const bike of fleet.bikes) {
    check(typeof bike?.id==='string' && bike.id && Array.isArray(bike.history),'Invalid Fleet machine record');
    machineIds.add(bike.id);
    const {history,...record}=bike;
    inventory.put('machines',[bike.id],record);
    for (const entry of history) inspectEntry(bike.id,entry,'history');
  }
  for (const row of db.prepare('SELECT * FROM vehicle_archives ORDER BY bike_id').iterate()) {
    inventory.put('machineArchives',[row.bike_id],row);
    for (const entry of JSON.parse(row.snapshot_json).history||[]) inspectEntry(row.bike_id,entry,'archivedHistory');
  }
  for (const row of db.prepare(`SELECT * FROM vehicle_registry ORDER BY bike_id`).iterate()) {
    inventory.put('machineRegistry',[row.bike_id],row);
  }
  for (const row of db.prepare(`SELECT * FROM deleted_records WHERE record_type='fleet_history' ORDER BY id`).iterate()) {
    const {bikeId,entry}=JSON.parse(row.payload);
    check(typeof bikeId==='string' && typeof entry?.id==='string','Invalid Fleet record in trash');
    inventory.put('historyTrash',[row.id],row);
    collectFiles(entry,fileKeys);
  }
  for (const row of db.prepare('SELECT * FROM invoice_import_drafts ORDER BY id').iterate()) {
    inventory.put('invoiceDrafts',[row.id],row);
    draftIds.add(row.id);
    const draft=JSON.parse(row.data);
    if (draft.attachment && ['processing','ready','committing','error'].includes(row.status)) collectFiles({attachments:[draft.attachment]},fileKeys);
  }
  let unresolvedJobTargets=0;
  for (const row of db.prepare(`SELECT * FROM fleet_operations WHERE type IN ('service_document_render','service_document_reprocess_batch')
    AND status IN ('pending','error') ORDER BY id`).iterate()) {
    inventory.put('pendingInvoiceJobs',[row.id],row);
    const job=JSON.parse(row.payload);
    if (row.type==='service_document_render' &&
      !(job.draftId ? draftIds.has(job.draftId) : serviceKeys.has(stableReviewJson([job.bikeId,job.entryId])))) unresolvedJobTargets++;
  }
  for (const row of db.prepare(`SELECT * FROM audit_log WHERE object_type IN ('fleet','fleet_history','service_document','vehicle')
    ORDER BY id`).iterate()) inventory.put('fleetAudit',[row.id],row);
  const files=verifyFiles(db,native,objects,fileKeys,inventory);
  const blockingReasons=[];
  if (files.missing) blockingReasons.push('fleet_attachments_missing');
  if (unresolvedJobTargets) blockingReasons.push('invoice_job_target_missing');
  if (totals.invoiceAmountDiscrepancies) blockingReasons.push('source_invoice_amount_mismatch');
  if (totals.duplicateInvoiceLinks) blockingReasons.push('duplicate_invoice_link');
  const inventoryProof=inventory.proof();
  return {sourceSnapshotVersion:snapshot.version,sourceUpdatedAt:snapshot.updated_at,machines:machineIds.size,
    inventory:inventoryProof,totals,files,unresolvedJobTargets,blockingReasons};
}

// Consumes the already authenticated, decrypted private copy produced by
// NativeBackupReader. This tool never opens the running Android database.
export function inspectNativeFleetBackup({database,manifest,objects}) {
  for (const suffix of ['-wal','-shm','-journal']) check(!existsSync(database+suffix),'Expected a closed backup SQLite without sidecars');
  const before=fileProof(database);
  check(before.size===manifest.size && before.sha256===manifest.sha256,'Native backup SQLite checksum differs');
  const db=new DatabaseSync(database,{readOnly:true});
  let fleet;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    verifyNativeSchema(db,manifest);
    fleet=inspectFleet(db,manifest,objects);
  } finally { db.close(); }
  check(fileProof(database).sha256===before.sha256,'Backup database changed during the rehearsal');
  return {...fleet,format:'fleet-scope-preflight-v1',capturedAt:manifest.capturedAt,sourceDatabaseSha256:before.sha256,
    integrityVerified:true,dataUploaded:false,cutoverVerified:false};
}

export function compareFleetPreflights(source, copy) {
  const fields=['format','sourceSnapshotVersion','sourceUpdatedAt','machines','inventory','totals','files','unresolvedJobTargets'];
  check(source?.format==='fleet-scope-preflight-v1' && copy?.format===source.format,'Expected two compatible Fleet preflight manifests');
  const mismatches=fields.filter(field=>stableReviewJson(source[field])!==stableReviewJson(copy[field]));
  const matches=source.integrityVerified===true && copy.integrityVerified===true &&
    !mismatches.length && !source.blockingReasons?.length && !copy.blockingReasons?.length;
  return {matches,mismatches};
}

function main() {
  try {
    const {values}=parseArgs({options:{database:{type:'string'},manifest:{type:'string'},objects:{type:'string'},'compare-to':{type:'string'}}});
    check(values.database && values.manifest,'Usage: node scripts/hybrid-fleet-preflight.mjs --database <snapshot.sqlite> --manifest <nativeDatabase.json> [--objects <dir>]');
    const value=JSON.parse(readFileSync(values.manifest,'utf8'));
    const result=inspectNativeFleetBackup({...values,manifest:value.nativeDatabase||value});
    if (values['compare-to']) result.reconciliation=compareFleetPreflights(JSON.parse(readFileSync(values['compare-to'],'utf8')),result);
    console.log(JSON.stringify(result,null,2));
    if (result.blockingReasons.length || result.reconciliation?.matches===false) process.exitCode=2;
  } catch (error) {
    // System I/O messages can contain private names. Keep the report safe to
    // inspect without returning object filenames, QR links, or JSON contents.
    console.error(error.code||error instanceof SyntaxError ? 'Could not read or verify private Fleet backup input.' : error.message);
    process.exitCode=2;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main();
