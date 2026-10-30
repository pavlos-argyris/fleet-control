import { recoveryItems, recoveryResult } from './invoice-recovery.js';
import { routeDirectRelay } from './direct-relay.js';
import { invoiceReadComparison, READ_FIELDS } from './invoice-read-identity.js';
import { retryFailedInvoice } from './invoice-retry.js';
import { routeChangeEvents, publishChanges, changedScopes } from './change-events.js';
export { FleetEvents } from './change-events.js';
import { MIRROR_SCHEMA, mirrorDelta, mirrorHead, trimMirrorJournal } from './mirror-delta.js';
import '../public/service-model.js';
const ServiceModel = globalThis.FleetServiceModel;
import '../public/fleet-operations-model.js';
const OperationsModel = globalThis.FleetOperationsModel;
import { INVOICE_IMPORT_SCHEMA, routeInvoiceImports, readImportDraftForJob, finishImportDraft, restartImportDraft, invoiceDuplicates } from './invoice-imports.js';
import { visibleSnapshotRow, snapshotSummary, readServiceEntry, writeServiceEntry, fleetNames, readServiceDocument, fleetRegistrySnapshot, readSnapshotBike, writeSnapshotBike } from "./snapshot-store.js";
import { routeServiceOperations } from './service-operations.js';
import { stableReviewJson, readReviewReceipt, commitInvoiceReview } from './invoice-review-store.js';
import { parseInvoiceText, enrichInvoiceExtraction, evaluateInvoiceConfirmation, INVOICE_RULES_VERSION, MAX_INVOICE_TEXT, MAX_INVOICE_ITEMS } from './invoice-extraction.js';
import { routeReleases } from "./releases.js";
import {
  authenticateExternal,
  authorizedFor,
  createExternalAlert,
  ensureWorkforceSchema,
  d1ExecScript,
  maintainWorkforce,
  recordExternalAudit,
  routeWorkforce
} from "./workforce.js";

const MAX_BIKES = 40;
const MAX_HISTORY = 500;
const MAX_SERVICE_ATTACHMENTS = 10;
const MAX_PENDING = 100;
const PIN_WINDOW_SECONDS = 15 * 60;
const PIN_MAX_ATTEMPTS = 8;
const SESSION_SECONDS = 12 * 60 * 60;
const MAJOR_SERVICE_INTERVAL_KM = 10000;
// The Android Server can be configured to sync every five minutes. Keep a
// small grace period for mobile-network and Android scheduling delays so a
// healthy Server is not reported as offline between successful syncs.
const SERVER_HEARTBEAT_GRACE_MS = 7 * 60 * 1000;
const WEB_RELEASE_METADATA_CACHE_MS = 5 * 1000;
const STATUS_RESPONSE_CACHE_MS = 5 * 1000;
const SERVICE_RENDER_DELAY_MS = 90 * 1000;
const SERVICE_RENDER_MAX_ATTEMPTS = 3;
const INVOICE_REPROCESS_BATCH_SETTING = "service_invoice_reprocess_batch";
const INVOICE_REPROCESS_BATCH_STALE_MS = 20 * 60 * 1000;
const INVOICE_REPROCESS_BATCH_RESULT_TTL_MS = 30 * 1000;
const RUNTIME_SCHEMA_VERSION = "store-billing-aggregate-v2";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'canonical', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_operations (id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, applied_at TEXT);
CREATE INDEX IF NOT EXISTS fleet_operations_status_created ON fleet_operations(status, created_at);
CREATE TABLE IF NOT EXISTS fleet_releases (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL, object_key TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', manifest TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fleet_releases_kind_created ON fleet_releases(kind, created_at DESC);
CREATE TABLE IF NOT EXISTS fleet_sessions (token_hash TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_pin_attempts (fingerprint TEXT PRIMARY KEY NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, window_started INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
${INVOICE_IMPORT_SCHEMA}
INSERT OR IGNORE INTO fleet_snapshot (id, version, data, source, updated_at) VALUES (1, 0, '{"bikes":[]}', 'canonical', datetime('now'));
`;

let schemaPromise;
let activeWebReleaseCache = { value: null, expiresAt: 0, db: null };
let statusResponseCache = { value: null, expiresAt: 0, db: null };

export default {
  async fetch(request, env, context) {
    const startedAt = performanceNow();
    try {
      // Emergency entry must load while every D1 query is unavailable.
      if (new URL(request.url).pathname === '/direct.html' && request.method === 'GET') return env.ASSETS.fetch(request);
      const direct = await routeDirectRelay(request, env);
      if (direct) return direct;
      await ensureSchema(env);
      if (request.method === "OPTIONS") return withServerTiming(optionsResponse(), startedAt);
      const response=await route(request,env);
      const scope=response.ok?[...new Set([...changedScopes(request),...(new URL(request.url).pathname==='/api/server/exchange'?(response.headers.get('X-Fleet-Changed')||'').split(',').filter(Boolean):[])])]:[];
      if(scope.length&&env.FLEET_EVENTS){const notify=publishChanges(env,scope).catch(()=>{});if(context?.waitUntil)context.waitUntil(notify);else await notify;}
      return withServerTiming(response,startedAt);
    } catch (error) {
      console.error(error);
      return withServerTiming(json({ error: "Παρουσιάστηκε προσωρινό σφάλμα στον Fleet Control server." }, 500), startedAt);
    }
  },
  async scheduled(controller, env, context) {
    context.waitUntil((async () => {
      await ensureSchema(env);
      await trimMirrorJournal(env);
      const before=(await mirrorHead(env)).cursor;
      await maintainWorkforce(env, {
        serverLastSeen: await getSetting(env, "server_last_seen"),
        backupResult: await getSetting(env, "server_backup_result")
      }, { readSnapshot, readFleetRegistry: fleetRegistrySnapshot, readSnapshotBike, writeSnapshotBike });
      if((await mirrorHead(env)).cursor!==before)await publishChanges(env,['workforce','status']);
    })());
  }
};

function performanceNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function withServerTiming(response, startedAt) {
  if (!response || !response.headers || response.status===101) return response;
  const headers = new Headers(response.headers);
  const duration = Math.max(0, Math.round(performanceNow() - startedAt));
  const previous = headers.get("Server-Timing");
  headers.set("Server-Timing", previous ? `${previous}, worker;dur=${duration}` : `worker;dur=${duration}`);
  return new Response(response.body, { status: response.status, headers });
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error("Missing DB binding");
  if (!schemaPromise) schemaPromise = (async () => {
    // A Worker isolate may be recreated after a period of inactivity. Avoid
    // replaying the complete schema on every cold start once this release has
    // already verified the database.
    try {
      if (await getSetting(env, "runtime_schema_version") === RUNTIME_SCHEMA_VERSION) return;
    } catch {}
    await env.DB.exec(d1ExecScript(SCHEMA));
    await ensureReleaseChecksumColumn(env);
    await ensureWorkforceSchema(env);
    await env.DB.exec(MIRROR_SCHEMA);
    await env.DB.batch([
      env.DB.prepare("UPDATE fleet_mirror_state SET epoch=lower(hex(randomblob(16))) WHERE id=1 AND (NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_mirror_schema_v1') OR NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_payroll_schema_v2') OR NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_server_schema_v3'))"),
      env.DB.prepare("INSERT OR IGNORE INTO fleet_settings(key,value,updated_at) VALUES('ordexa_mirror_schema_v1','1',datetime('now'))"),
      env.DB.prepare("INSERT OR IGNORE INTO fleet_settings(key,value,updated_at) VALUES('ordexa_payroll_schema_v2','1',datetime('now'))"),
      env.DB.prepare("INSERT OR IGNORE INTO fleet_settings(key,value,updated_at) VALUES('ordexa_server_schema_v3','1',datetime('now'))")
    ]);
    await setSetting(env, "runtime_schema_version", RUNTIME_SCHEMA_VERSION);
  })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  await schemaPromise;
}

async function ensureReleaseChecksumColumn(env) {
  const columns = await env.DB.prepare("PRAGMA table_info(fleet_releases)").all();
  if (!(columns.results || []).some((column) => column.name === "sha256")) {
    await env.DB.exec("ALTER TABLE fleet_releases ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''");
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const events=await routeChangeEvents(request,env,authenticateExternal,json);if(events)return events;

  const ota = await routeReleases(request, env, { json, secureEqual, serverAuthorized, digestHex, invalidateWeb: () => { activeWebReleaseCache = { value: null, expiresAt: 0, db: null }; } });
  if (ota) return ota;
  const operations=await routeServiceOperations(request,env,{json,authenticateExternal,isManagementActor,snapshotSummary,statusPayload,readSnapshotBike,writeSnapshotBike,activeArchivedBikeIds,workforceOdometerFloor,normalizeBike,restoreFleetHistoryEntries,recordExternalAudit,historyChanges,impactToken,queueBike,ensureLegacyOilHistory});
  if(operations)return operations;


  if (path === "/api/status" && request.method === "GET") return statusResponse(env);
  if (path === "/api/client-update" && request.method === "GET") return clientUpdateResponse(request, env);
  if (path === "/api/snapshot" && request.method === "GET") return snapshotResponse(request, env);
  if (path === "/api/sync" && request.method === "GET") return legacySyncGet(request, env);
  if (path === "/api/sync" && request.method === "POST") return legacySyncPost(request, env);
  if (path === "/api/sync/bike" && request.method === "POST") return syncSingleBike(request, env, false);
  if (path === "/api/server/snapshot/bike" && request.method === "PUT") return syncSingleBike(request, env, true);
  if ((path === "/api/auth/login" || path === "/api/unlock") && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if ((path === "/api/admin/pin" || path === "/api/pin") && request.method === "POST") return updatePin(request, env);
  if (path === "/api/operations" && request.method === "POST") return submitOperation(request, env);
  if (path === "/api/backup/request" && request.method === "POST") return requestBackup(request, env);
  const invoiceImport=await routeInvoiceImports(request,env,{json,serverAuthorized,authenticateExternal,cleanText,qrUrlFromValue,isPublicExternalQrUrl,recordExternalAudit,fleetNames,readSnapshotBike,writeSnapshotBike,normalizeBike,attachServiceDocumentMetadata});
  if(invoiceImport)return invoiceImport;
  if (path === "/api/service-documents" && request.method === "POST") return uploadServiceDocument(request, env);
  if (path === "/api/service-documents" && request.method === "DELETE") return deleteServiceDocument(request, env);
  if (path === "/api/service-documents/import-qr" && request.method === "POST") return importQrServiceDocument(request, env);
  if (path.startsWith("/api/service-documents/jobs/") && request.method === "POST" && path.endsWith("/retry")) return retryServiceDocumentJob(request, env);
  if (path.startsWith("/api/service-documents/jobs/") && request.method === "GET") return serviceDocumentJobStatus(request, env);
  if (path === "/api/service-documents/resolve-qr" && request.method === "POST") return resolveQrServiceDocument(request, env);
  if (path === "/api/service-documents/ocr" && request.method === "POST") return ocrServiceDocument(request, env);
  if (path === "/api/admin/service-documents" && request.method === "GET") return listAdminServiceDocuments(request, env);
  if (path === "/api/admin/service-documents/retry-failed" && request.method === "POST") return retryFailedInvoice(request,env,{json,authenticateExternal,isManagementActor,readServiceEntry,readServiceDocument,serviceRenderState,jobAttachmentMatches,restartServiceDocument,reprocessAdminServiceDocument,resolveServiceDocumentFailure,digestHex,serverAuthorized});
  if (path === "/api/admin/service-documents/transfer-options" && request.method === "GET") return invoiceTransferOptions(request, env);
  if (path === "/api/admin/service-documents/reprocess-batch" && (request.method === "GET" || request.method === "POST")) return invoiceReprocessBatch(request, env);
  if (path === "/api/admin/service-documents/seen" && request.method === "POST") return markAdminServiceDocumentSeen(request, env);
  if (path === "/api/admin/service-documents/reprocess" && request.method === "POST") return reprocessAdminServiceDocument(request, env);
  if (path === "/api/admin/service-documents/undo-review" && request.method === "POST") return undoServiceReview(request, env);
  if (path === "/api/admin/server-report" && request.method === "GET") return serverPreparedReport(request,env);
  if (path === "/api/admin/service-followup" && request.method === "POST") return updateServiceFollowup(request, env);
  if (path === "/api/admin/service-documents/review" && request.method === "POST") return reviewAdminServiceDocument(request, env);
  if (path.startsWith("/api/service-documents/") && request.method === "GET") return downloadServiceDocument(request, env);
  const fleetHistoryMatch = path.match(/^\/api\/admin\/fleet\/([^/]+)\/history\/([^/]+)\/(edit|delete)$/);
  if (fleetHistoryMatch && request.method === "POST") {
    return fleetHistoryAction(request, env, decodeURIComponent(fleetHistoryMatch[1]), decodeURIComponent(fleetHistoryMatch[2]), fleetHistoryMatch[3]);
  }

  if (path === "/api/server/connection-check" && request.method === "GET") return serverConnectionCheck(request, env);
  if (path === "/api/server/exchange" && request.method === "POST") return serverExchange(request,env);
  if (path === "/api/server/pulse" && request.method === "POST") return serverPulse(request, env);
  if (path === "/api/server/service-documents/job-active" && request.method === "GET") {
    if (!await serverAuthorized(request,env)) return json({error:"Μη έγκυρος Server."},401);
    const row=await env.DB.prepare("SELECT status,json_extract(payload,'$.progress') AS progress,json_extract(payload,'$.progressStage') AS stage FROM fleet_operations WHERE id=? AND type='service_document_render'").bind(cleanText(url.searchParams.get("jobId"),120)).first();
    return json({active:row?.status === "pending",cancelled:row?.status === "cancelled",progress:Number(row?.progress||0),stage:row?.stage||""});
  }
  if (path === "/api/server/service-documents/reprocess" && request.method === "POST") {
    if (!await serverAuthorized(request,env)) return json({error:"Μη έγκυρος Server."},401);
    return reprocessAdminServiceDocument(request,env);
  }
  if ((path === "/api/admin/service-documents/restart" || path === "/api/server/service-documents/restart") && request.method === "POST") return restartServiceDocument(request, env);
  if (path === "/api/server/system-export/delta" && request.method === "GET") return mirrorDelta(request,env,serverAuthorized);
  if (path === "/api/server/pending" && request.method === "GET") return serverPending(request, env);
  if (path === "/api/server/ack" && request.method === "POST") return serverAck(request, env);
  if (path === "/api/server/operation-progress" && request.method === "POST") return serverOperationProgress(request, env);
  if (path === "/api/server/operation-error" && request.method === "POST") return serverOperationError(request, env);
  if (path === "/api/server/snapshot" && request.method === "PUT") return serverSnapshot(request, env);
  if (path === "/api/server/service-documents/analysis-result" && request.method === "POST") return storedAnalysisResult(request,env);
  if (path === "/api/server/service-documents/rendered" && request.method === "PUT") return uploadServerRenderedServiceDocument(request, env);
  if (path === "/api/server/service-documents/reprocess-batch" && (request.method === "GET" || request.method === "POST")) return serverInvoiceReprocessBatch(request, env);
  if (path === "/api/server/service-documents/restore" && request.method === "PUT") return restoreServerServiceDocument(request, env);
  if (path === "/api/server/heartbeat" && request.method === "POST") return serverHeartbeat(request, env);

  if (path === "/api/admin/releases/client" && request.method === "PUT") return uploadClientApk(request, env);
  if (path.startsWith("/api/admin/web-assets/") && request.method === "PUT") return uploadWebAsset(request, env, path);
  if (path === "/api/admin/web-assets/activate" && request.method === "POST") return activateWebRelease(request, env);
  if (path === "/api/admin/releases" && request.method === "GET") return listReleases(request, env);
  if (path === "/api/admin/releases/activate" && request.method === "POST") return activateRelease(request, env);
  if (path === "/download/client.apk" && request.method === "GET") return downloadClientApk(request, env);

  const workforce = await routeWorkforce(request, env, path, {
    serverAuthorized,
    verifyPin,
    readSnapshot,
    readFleetRegistry: fleetRegistrySnapshot,
    writeSnapshot,
    touchServer,
    mergeRestoreFleet: (current, incoming) => mergeFleets(normalizeFleet(current), normalizeFleet(incoming)),
    restoreFleetHistoryEntries
  });
  if (workforce) return workforce;

  if (path.startsWith("/api/")) return json({ error: "Η λειτουργία δεν βρέθηκε." }, 404);
  return serveWeb(request, env);
}

async function uploadServiceDocument(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.manage"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Η επισύναψη τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16 * 1024 * 1024) return json({ error: "Το τιμολόγιο δεν μπορεί να ξεπερνά τα 16 MB." }, 413);
  const form = await request.formData();
  const bikeId = cleanText(form.get("bikeId"), 80);
  const entryId = cleanText(form.get("entryId"), 120);
  const qrValue = normalizeQrValue(form.get("qrValue"));
  const file = form.get("file");
  if (!bikeId || !entryId || !file || typeof file.arrayBuffer !== "function") return json({ error: "Λείπει το αρχείο ή η σύνδεση με το service." }, 400);
  let type = documentContentType(file.type, file.name);
  if (type === "application/octet-stream" && typeof file.slice === "function") {
    type = detectDocumentContentType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  }
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  if (!allowed.has(type)) return json({ error: "Υποστηρίζονται μόνο PDF, JPG, PNG ή WEBP." }, 415);
  if (Number(file.size || 0) > 15 * 1024 * 1024) return json({ error: "Το τιμολόγιο δεν μπορεί να ξεπερνά τα 15 MB." }, 413);
  const snapshot = await readSnapshot(env);
  const bike = (snapshot.data.bikes || []).find((item) => String(item.id) === bikeId);
  const entry = bike && (bike.history || []).find((item) => String(item.id) === entryId);
  if (!entry || entry.type === "check") return json({ error: "Το service δεν βρέθηκε. Αποθήκευσε πρώτα το service και ξαναδοκίμασε." }, 404);
  const uploadId = cleanText(form.get("uploadId"), 100);
  if (uploadId && !/^[a-zA-Z0-9_-]{16,100}$/.test(uploadId)) return json({ error: "Μη έγκυρος κωδικός αποστολής." }, 400);
  const existing = uploadId && (entry.attachments || []).find(item => item.uploadId === uploadId);
  if (existing) return json({ ok: true, attachment: existing, duplicate: true });
  if ((entry.attachments || []).length >= MAX_SERVICE_ATTACHMENTS) return json({ error: "Μπορείς να κρατήσεις έως 10 τιμολόγια σε ένα service. Τα υπάρχοντα αρχεία διατηρούνται." }, 409);
  const originalName = cleanText(file.name || "invoice", 120).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const key = `service-documents/${encodeURIComponent(bikeId)}/${encodeURIComponent(entryId)}/${uploadId || crypto.randomUUID()}-${originalName}`;
  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);
  await bucket.put(key, file, { httpMetadata: { contentType: type, contentDisposition: `inline; filename="${originalName}"` }, customMetadata: { bikeId, entryId, uploadedBy: actor.id || actor.username || "admin", qrUrl: qrUrlFromValue(qrValue) } });
  const attachment = { uploadId, id: key.split("/").pop(), key, name: originalName, originalName, contentType: type, size: Number(file.size || 0), uploadedAt: new Date().toISOString(), qrValue, qrUrl: qrUrlFromValue(qrValue) };
  const stored = await attachServiceDocumentMetadata(env, bikeId, entryId, attachment);
  if (!stored.attached) {
    await bucket.delete(key);
    return json({ error: stored.error || "Το service δεν βρέθηκε ή διαγράφηκε." }, stored.status || 404);
  }
  return json({ ok: true, attachment: stored.attachment || attachment }, 201);
}

async function attachServiceDocumentMetadata(env, bikeId, entryId, attachment) {
  const names = await fleetNames(env);
  const proof = attachment.ocr ? parseInvoiceText(attachment.ocr.rawText) : null;
  const extracted = attachment.ocr ? refineInvoicePlateForFleet(normalizeServiceDocumentOcr(enrichInvoiceExtraction(attachment.ocr,proof)), names) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attachment.renderJobId && await renderJobCancelled(env,attachment.renderJobId)) return {attached:false,status:410,error:"Η παλιά προσπάθεια διακόπηκε."};
    const located = await readServiceEntry(env, bikeId, entryId);
    if (!located || located.entry.type === "check") return { attached: false };
    const { entry, bike } = located;
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    const duplicate = attachments.some(item => String(item.key) === String(attachment.key) || item.sourcePhoto?.key===attachment.key ||
      (attachment.renderJobId && String(item.renderJobId) === String(attachment.renderJobId)));
    if (duplicate) return { attached: true, duplicate: true, version: located.version, attachment: attachments.find(item => String(item.key) === String(attachment.key) || item.sourcePhoto?.key===attachment.key || (attachment.renderJobId && String(item.renderJobId) === String(attachment.renderJobId))) };
    if (attachments.length >= MAX_SERVICE_ATTACHMENTS && !attachments.some(file=>file.key===attachment.sourcePhoto?.key)) return { attached: false, status: 409,
      error: "Μπορείς να κρατήσεις έως 10 τιμολόγια σε ένα service. Τα υπάρχοντα αρχεία διατηρούνται." };
    mergeServiceQrMetadata(entry, attachment.qrValue, attachment.qrUrl, attachment.renderJobId ? {
      jobId: attachment.renderJobId, status: "completed", progress: 100, stage: "Ολοκληρώθηκε", error: ""
    } : null);
    attachment.name = uniqueInvoiceDisplayName(buildInvoiceDisplayName(bike.name, attachment.invoiceDate || attachment.ocr?.invoiceDate || "", entry.date, attachment.name), attachments, attachment.key);
    entry.attachments = [...attachments.filter(file=>file.key!==attachment.sourcePhoto?.key), attachment];
    const now = new Date().toISOString();
    if (extracted) {
      const before = ServiceModel.state(entry, {}), oldTasks = (entry.tasks || []).join('\n');
      const decision = await decideInvoiceRead(env, bike, entry, attachment, extracted, names, {}, attachment.ocrError || '',proof);
      attachment.ocr = normalizeServiceDocumentOcr(decision.data);
      if (!attachment.ocrError) {
        if(decision.tasks)entry.tasks = decision.tasks;
        if (!entry.notes || entry.notes === oldTasks) entry.notes = entry.tasks.join('\n');
        if (attachment.ocr.supplier && !entry.workshop) entry.workshop = attachment.ocr.supplier;
        entry.invoiceData = attachment.ocr;
      }
      if (decision.automatic) ServiceModel.decision(entry,attachment.key,before,attachment.ocr,'Αυτόματος έλεγχος · '+INVOICE_RULES_VERSION,now,false);
      entry.updatedAt = now;
      const normalized=normalizeHistory([entry])[0],storedFile=normalized.attachments.find(item=>item.key===attachment.key);
      const result=await commitInvoiceReview(env,{actor:{id:'invoice-reader',username:'invoice-reader',role:'system'},requestId:'attach-'+(attachment.renderJobId||attachment.id),hash:await sha256(attachment.key),
        updates:[{located,entry:normalized,bikePatch:{updatedAt:now}}],result:{attached:true,automaticConfirmed:decision.automatic,document:adminServiceDocumentRecord(bike,normalized,storedFile,null,[],true)},now,changed:true,
        source:'service-document-upload',renderJobId:attachment.renderJobId||'',autoConfirmation:decision.automatic?{...attachment.ocr,key:attachment.key,qrUrl:attachment.qrUrl||''}:null,audit:{action:decision.automatic?'service_document_auto_confirmed':'service_document_read',before,after:ServiceModel.state(normalized,attachment.ocr),reason:decision.automatic?attachment.ocr.confirmationReason:'Το τιμολόγιο αποθηκεύτηκε με τις αιτίες ελέγχου.'}});
      if (!result) continue;
      if (result.conflict) return {attached:false,status:409,error:'Το τιμολόγιο έχει ήδη διαφορετικό αποτέλεσμα.'};
      if (!attachment.ocrError) await resolveServiceDocumentFailure(env,attachment.renderJobId);
      return {...result,attachment:storedFile};
    }
    entry.updatedAt = now;
    const normalized = normalizeHistory([entry])[0];
    const version = await writeServiceEntry(env, located, normalized, "service-document-upload", now, attachment.renderJobId || "");
    if (version) { if(!attachment.ocrError)await resolveServiceDocumentFailure(env, attachment.renderJobId); return { attached: true, version }; }
  }
  return { attached: false, status: 409, error: "Το service ενημερώθηκε ταυτόχρονα. Δοκίμασε ξανά την προσθήκη του τιμολογίου." };
}

function mergeServiceQrMetadata(entry, qrValue, qrUrl, processing) {
  if (!entry || entry.type === "check") return false;
  const safeUrl = qrUrlFromValue(qrUrl || qrValue);
  if (!safeUrl) return false;
  const current = normalizeServiceInvoiceData(entry.invoiceData) || {};
  const next = normalizeServiceInvoiceData({
    ...current,
    qrUrl: safeUrl,
    source: current.source || "qr"
  });
  if (processing && next) {
    next.qrJobId = cleanText(processing.jobId, 120) || next.qrJobId;
    next.qrProcessingStatus = cleanText(processing.status, 30) || next.qrProcessingStatus || "processing";
    next.qrProcessingUpdatedAt = new Date().toISOString();
    if (processing.progress != null) next.qrProcessingProgress = String(cleanInteger(processing.progress, 0, 100, 0));
    if (processing.stage) next.qrProcessingStage = cleanText(processing.stage, 160);
    if (processing.error) next.qrProcessingError = cleanText(processing.error, 500);
    else delete next.qrProcessingError;
    if (processing.attempts != null) next.qrProcessingAttempts = String(Math.max(0, Number(processing.attempts) || 0));
  }
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  entry.invoiceData = next;
  return changed;
}

async function deleteServiceDocument(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.manage"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Η διαγραφή τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);

  const body = await request.json().catch(() => ({}));
  const bikeId = cleanText(body.bikeId, 100);
  const entryId = cleanText(body.entryId, 100);
  const key = cleanText(body.key, 500);
  const jobId = cleanText(body.jobId, 120);
  if (!bikeId || !entryId || (!key && !jobId) || (key && !isServiceDocumentKey(key))) {
    return json({ error: "Το τιμολόγιο ή η σύνδεσή του με το service δεν είναι έγκυρη." }, 400);
  }

  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);
  const snapshot = await readSnapshot(env);
  const fleet = JSON.parse(JSON.stringify(snapshot.data || { bikes: [] }));
  const bike = (fleet.bikes || []).find((item) => String(item.id) === bikeId);
  if (!bike) return json({ error: "Το μηχανάκι δεν βρέθηκε." }, 404);
  const entry = (Array.isArray(bike.history) ? bike.history : []).find((item) => String(item.id) === entryId);
  if (!entry || entry.type === "check") return json({ error: "Το service δεν βρέθηκε." }, 404);
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  const attachmentIndex = key ? attachments.findIndex((item) => String(item.key) === key) : -1;
  const deletedAttachment = attachmentIndex >= 0 ? JSON.parse(JSON.stringify(attachments[attachmentIndex])) : null;
  let pendingPayload = null;
  if (!deletedAttachment && jobId) {
    const operation = await env.DB.prepare("SELECT id, type, payload, status FROM fleet_operations WHERE id = ? LIMIT 1").bind(jobId).first();
    if (!operation || operation.type !== "service_document_render") return json({ error: "Η εργασία του τιμολογίου δεν βρέθηκε." }, 404);
    try { pendingPayload = JSON.parse(operation.payload || "{}"); } catch { pendingPayload = {}; }
    if (String(pendingPayload.bikeId) !== bikeId || String(pendingPayload.entryId) !== entryId) {
      return json({ error: "Η εργασία δεν αντιστοιχεί στο συγκεκριμένο service." }, 400);
    }
  }
  if (!deletedAttachment && !pendingPayload) return json({ error: "Το τιμολόγιο δεν βρέθηκε στο συγκεκριμένο service." }, 404);

  // Delete the private R2 object first. The metadata is removed from the
  // canonical snapshot only after the storage operation succeeds. A pending
  // QR job has no R2 object yet, so it is cancelled from fleet_operations.
  if (deletedAttachment) {
    await bucket.delete(key);
    attachments.splice(attachmentIndex, 1);
  }
  entry.attachments = attachments;
  const deletedQrUrl = qrUrlFromValue(deletedAttachment?.qrUrl || deletedAttachment?.qrValue || pendingPayload?.qrUrl || "");
  const currentInvoiceData = normalizeServiceInvoiceData(entry.invoiceData) || null;
  const currentQrJobId = String(currentInvoiceData?.qrJobId || "");
  const matchesCurrentInvoice = Boolean(currentInvoiceData && (
    (deletedQrUrl && String(currentInvoiceData.qrUrl || "") === deletedQrUrl) ||
    (jobId && currentQrJobId === jobId)
  ));
  if (matchesCurrentInvoice || (!attachments.length && (deletedAttachment || pendingPayload))) {
    // Keep the manually entered service itself and its history intact. Only
    // remove the QR/OCR link that belonged to the deleted invoice.
    entry.invoiceData = null;
  }
  const now = new Date().toISOString();
  entry.updatedAt = now;
  bike.historyCorrectedAt = now;
  bike.updatedAt = now;
  bike.odometerFloorKm = await workforceOdometerFloor(env, bikeId);
  const normalizedBike = normalizeBike(bike);
  const bikeIndex = (fleet.bikes || []).findIndex((item) => String(item.id) === bikeId);
  fleet.bikes[bikeIndex] = normalizedBike;
  const stored = await writeSnapshot(env, normalizeFleet(fleet), "admin-service-document-delete", snapshot.version + 1);
  const operationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vehicle_registry (bike_id,name,odometer,status,version,updated_at)
      VALUES (?,?,?,'available',1,?) ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,
      odometer=excluded.odometer,version=vehicle_registry.version+1,updated_at=excluded.updated_at`)
      .bind(normalizedBike.id, normalizedBike.name, normalizedBike.currentKm, now),
    env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) VALUES (?,'authenticated-client','snapshot_replace_bike',?,'pending',?)")
      .bind(operationId, JSON.stringify({ bike: normalizedBike }), now)
  ]);
  if (jobId) {
    await env.DB.prepare("UPDATE fleet_operations SET status = 'applied', applied_at = ? WHERE id = ? AND type = 'service_document_render'")
      .bind(now, jobId).run();
  }
  const batch = key ? await skipDeletedInvoiceFromBatch(env, key, now) : null;
  await recordExternalAudit(env, request, actor, "service_document_deleted", "service_document", key || jobId,
    deletedAttachment || pendingPayload, { bikeId, entryId, pending: !deletedAttachment }, "Διαγραφή τιμολογίου από το service", false);
  return json({ deleted: true, pending: !deletedAttachment, bike: normalizedBike, version: stored.version, operationId, batch });
}

function isServiceDocumentKey(value) {
  const key = cleanText(value, 500);
  return key.startsWith("service-documents/") && !key.includes("..") && !key.endsWith("/");
}

async function downloadServiceDocument(request, env) {
  if (!await mayViewFleet(request, env)) return json({ error: "Χρειάζεται σύνδεση για την προβολή του τιμολογίου." }, 401);
  const key = decodeURIComponent(new URL(request.url).pathname.slice("/api/service-documents/".length));
  if (!key.startsWith("service-documents/") || key.includes("..")) return json({ error: "Μη έγκυρο τιμολόγιο." }, 400);
  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);
  const object = await bucket.get(key);
  if (!object) return json({ error: "Το τιμολόγιο δεν βρέθηκε." }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const located=await readServiceDocument(env,key);
  for (const bike of located?[{history:[located.entry]}]:[]) {
    const attachment = (bike.history || []).flatMap((entry) => entry.attachments || []).find((item) => String(item.key) === key);
    if (attachment?.name) {
      const safeName = String(attachment.name).replace(/[\r\n"\\]/g, "_");
      headers.set("Content-Disposition", contentDispositionForFilename(safeName));
      break;
    }
  }
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

function jobAttachmentMatches(item,payload,jobId){if(payload.sourcePhotoKey&&item.key===payload.sourcePhotoKey)return false;return payload.documentKey?item.key===payload.documentKey&&item.renderJobId===jobId:String(item.renderJobId)===jobId||Boolean(payload.qrUrl&&String(item.qrUrl||item.qrValue)===String(payload.qrUrl));}
async function localAnalysisAvailable(env){return await getSetting(env,'server_offload_protocol')==='1';}
async function queueStoredAnalysis(env,key,body={}){
 const located=await readServiceDocument(env,key);if(!located||located.entry.type==='check')return json({error:'Το τιμολόγιο δεν βρέθηκε.'},404);
 const attachment=located.entry.attachments.find(a=>a.key===key),now=new Date().toISOString(),id=crypto.randomUUID();
 const payload={documentKey:key,bikeId:located.bike.id,entryId:located.entry.id,name:attachment.name,forceRead:body.forceRead===true,requestedAt:now,progress:5,progressStage:'Αναμονή τοπικής ανάγνωσης στον Server',attemptCount:0};
 await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO fleet_operations(id,source,type,payload,status,created_at) SELECT ?,'stored-document','service_document_render',?,'pending',? WHERE NOT EXISTS(SELECT 1 FROM fleet_operations WHERE status='pending' AND type='service_document_render' AND json_extract(payload,'$.documentKey')=?)").bind(id,JSON.stringify(payload),now,key),
  env.DB.prepare("UPDATE system_alerts SET object_id=(SELECT id FROM fleet_operations WHERE status='pending' AND type='service_document_render' AND json_extract(payload,'$.documentKey')=? ORDER BY created_at LIMIT 1) WHERE type='invoice_processing_failed' AND resolved=0 AND (object_id=? OR EXISTS(SELECT 1 FROM fleet_operations previous WHERE previous.id=system_alerts.object_id AND previous.type='service_document_render' AND json_extract(previous.payload,'$.documentKey')=?)) AND EXISTS(SELECT 1 FROM fleet_operations WHERE status='pending' AND type='service_document_render' AND json_extract(payload,'$.documentKey')=?)").bind(key,attachment.renderJobId||'',key,key)
 ]);
 const row=await env.DB.prepare("SELECT id,payload FROM fleet_operations WHERE status='pending' AND type='service_document_render' AND json_extract(payload,'$.documentKey')=? ORDER BY created_at LIMIT 1").bind(key).first();
 if(!row)return json({error:'Η εργασία άλλαξε. Ανανέωσε τα τιμολόγια πριν δοκιμάσεις ξανά.'},409);
 return json({ok:true,queued:true,jobId:row.id,status:'processing',key,document:adminServiceDocumentRecord(located.bike,located.entry,attachment,{jobId:row.id,payload:JSON.parse(row.payload),operationStatus:'pending',createdAt:now})},202);
}
async function storedAnalysisResult(request,env){
 if(!await serverAuthorized(request,env))return json({error:'Μη έγκυρος Server.'},401);
 const body=await request.json(),id=cleanText(body.jobId,120),row=await env.DB.prepare('SELECT type,status,payload FROM fleet_operations WHERE id=?').bind(id).first();
 if(!row||row.type!=='service_document_render')return json({error:'Η εργασία δεν βρέθηκε.'},404);
 if(row.status==='cancelled')return json({error:'Η προσπάθεια διακόπηκε.',cancelled:true},410);
 const payload=JSON.parse(row.payload),key=payload.documentKey;if(!key)return json({error:'Μη έγκυρη εργασία αρχείου.'},400);
 const located=await readServiceDocument(env,key);if(!located||located.bike.id!==payload.bikeId||located.entry.id!==payload.entryId)return json({error:'Το τιμολόγιο αφαιρέθηκε ή μετακινήθηκε.',cancelled:true},410);
 const attachment=located.entry.attachments.find(a=>a.key===key);if(attachment.renderJobId===id)return json({ok:true,reused:true,document:adminServiceDocumentRecord(located.bike,located.entry,attachment)});
 const local=normalizeServiceDocumentOcr(body.localOcr)||{},confident=local.localReadStatus==='confident'&&Number(local.ocrConfidence)>=70;
 let extracted={...local,source:'server-local',ocrSource:'server-local',ocrFallbackUsed:false},warning='';
 if(!confident){try{const object=await (env.SERVICE_DOCS||env.RELEASES)?.get(key);if(!object)throw new Error('Το αρχείο δεν βρέθηκε.');const start=performanceNow();extracted=aiInvoiceAnalysis(await extractStoredInvoiceOcr(env,new Uint8Array(await object.arrayBuffer()),documentContentType(object.httpMetadata?.contentType||'',attachment.name||key),attachment.name||key),local,performanceNow()-start);Object.assign(extracted,{source:'cloudflare-ai',ocrSource:'cloudflare-ai',ocrFallbackUsed:true,ocrFallbackReason:local.ocrFallbackReason||'Αβέβαιη τοπική ανάγνωση.'});}catch(error){warning=cleanText(error.message,500);Object.assign(extracted,{ocrFallbackUsed:true,ocrFallbackError:warning});}}
 if(await renderJobCancelled(env,id))return json({error:'Η προσπάθεια διακόπηκε.',cancelled:true},410);
 const result=await applyServiceDocumentReprocess(env,request,{id:'android-server',username:'android-server',role:'owner'},null,null,located.bike,located.entry,attachment,invoiceDataForServiceDocument(located.entry,attachment),extracted,warning,{jobId:id,source:'server-local-stored-analysis',audit:false});
 return json({ok:true,...result,extractionError:warning,fallbackUsed:!confident});
}

async function ocrServiceDocument(request, env) {
  if (!await authorizedFor(request, env, "fleet.manage")) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const body = await request.json().catch(() => ({}));
  const key = cleanText(body.key, 500);
  if (!key.startsWith("service-documents/") || key.includes("..")) return json({ error: "Μη έγκυρο τιμολόγιο." }, 400);
  if(await localAnalysisAvailable(env)&&!body.forceAi)return queueStoredAnalysis(env,key,body);
  if(!env.AI)return json({error:"Το OCR δεν έχει ενεργοποιηθεί."},503);
  const bucket = env.SERVICE_DOCS || env.RELEASES;
  const object = await bucket?.get(key);
  if (!object) return json({ error: "Το τιμολόγιο δεν βρέθηκε." }, 404);
  const type = object.httpMetadata?.contentType || "";
  const bytes = new Uint8Array(await object.arrayBuffer());
  let extracted;
  let source = "image";
  if (type === "application/pdf") {
    if (!env.AI.toMarkdown) return json({ error: "Η ανάγνωση PDF δεν είναι διαθέσιμη σε αυτή την έκδοση Workers AI." }, 503);
    const filename = key.split("/").pop() || "invoice.pdf";
    const converted = await env.AI.toMarkdown({
      name: filename,
      blob: new Blob([bytes], { type: "application/pdf" })
    });
    const result = Array.isArray(converted) ? converted[0] : converted;
    if (!result || result.format === "error" || !result.data) {
      return json({ error: result?.error || "Δεν ήταν δυνατή η ανάγνωση του PDF." }, 422);
    }
    source = "pdf";
    extracted = await extractInvoiceFromText(env, String(result.data), source);
  } else if (type.startsWith("image/")) {
    if (["image/heic", "image/heif"].includes(type)) {
      return json({ error: "Η φωτογραφία είναι HEIC/HEIF. Μετέτρεψέ την σε JPG ή ανέβασε PDF για OCR." }, 415);
    }
    extracted = await extractInvoiceFromImage(env, bytes, type);
  } else {
    return json({ error: "Υποστηρίζονται μόνο PDF, JPG, PNG ή WEBP." }, 415);
  }
  extracted = refineInvoicePlateForFleet(extracted, (await readSnapshot(env)).data.bikes);
  return json({ ok: true, extracted, source, requiresConfirmation: true });
}

const INVOICE_EXTRACTION_PROMPT = "Εξήγαγε σε JSON τα πεδία supplier, invoiceNumber, invoiceDate, mark, plate, odometerKm, workPerformed, lineItems, parts, laborAmount, netAmount, vatAmount, totalAmount, comments, notes. Το netAmount είναι η ρητή καθαρή αξία και το vatAmount το ποσό ΦΠΑ, όχι ποσοστό. Αν δεν φαίνονται ξεκάθαρα, άφησέ τα κενά και μην υπολογίζεις υποθετικά ποσά. Οι γραμμές του τιμολογίου είναι οι πραγματικές εργασίες ή ανταλλακτικά: βάλε κάθε ξεχωριστή γραμμή και στα lineItems ή parts, χωρίς να τις ενώσεις σε μία παράγραφο. Το workPerformed να είναι επίσης λίστα γραμμών χωρισμένων με νέα γραμμή. Αν το τιμολόγιο γράφει λάδι ή προϊόν λαδιού, κράτησε και την ακριβή ονομασία. Στα lineItems, parts και workPerformed κράτησε μόνο την περιγραφή της εργασίας ή του ανταλλακτικού και όχι τον κωδικό είδους/SKU/κωδικό αναφοράς που προηγείται. Αν δεν υπάρχει πεδίο, βάλε κενό string ή κενή λίστα. Μην προσθέτεις όρους πληρωμής, τρόπο πληρωμής, τοίς μετρητοίς ή κείμενο συναλλαγής στις εργασίες/ανταλλακτικά. Η πινακίδα διαβάζεται μόνο από σαφές πεδίο πινακίδας/αριθμού κυκλοφορίας ή σχόλια οχήματος: τρία γράμματα από ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ ή τα αντίστοιχα λατινικά και 3–4 ψηφία. Μην θεωρείς κωδικούς ειδών, μοντέλα, αριθμούς παραστατικών ή διευθύνσεις ως πινακίδες. Αν δεν είναι σαφές, βάλε κενή πινακίδα. Σε τιμολόγια Impact/eInvoicing, διάβασε πινακίδα και χιλιόμετρα από τα Σχόλια, ακόμη και αν είναι σε επόμενη γραμμή. Τα ψηφία της πινακίδας δεν είναι χιλιόμετρα. Η invoiceDate είναι η Ημερομηνία Έκδοσης, όχι αποστολής, παράδοσης ή αδειοδότησης. Η totalAmount είναι η Συνολική Αξία με ΦΠΑ, όχι καθαρό ποσό, ποσό ΦΠΑ, προηγούμενο/νέο υπόλοιπο ή ποσότητα. Ένωσε τις γραμμές που συνεχίζουν την ίδια περιγραφή ανταλλακτικού, αλλά κράτησε διαφορετικά είδη ξεχωριστά. Επέστρεψε μόνο JSON και μην επινοήσεις στοιχεία.";

function aiResponseText(response) {
  return String(response?.result || response?.response || response?.choices?.[0]?.message?.content || "");
}

function parseInvoiceAiResponse(response, rawText, source) {
  const text = aiResponseText(response);
  let parsed = {};
  try {
    parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  } catch {}
  return normalizeServiceDocumentOcr({
    ...parsed,
    rawText: String(rawText || text).slice(0, MAX_INVOICE_TEXT),
    source
  }) || { rawText: String(rawText || text).slice(0, MAX_INVOICE_TEXT), source };
}

async function extractInvoiceFromText(env, text, source = "qr", forceAi = false) {
  const content = String(text || "").slice(0, MAX_INVOICE_TEXT);
  const parsed=parseInvoiceText(text);
  if(!forceAi&&parsed.completeTable&&!parsed.problems.length&&['plate','odometerKm','invoiceNumber','invoiceDate','netAmount','vatAmount','totalAmount'].every(field=>parsed.data[field])) {
    return normalizeServiceDocumentOcr(enrichInvoiceExtraction({...parsed.data,rawText:content,source,localReadStatus:'confident',ocrConfidence:95,
      analysisEngine:'labelled-text',analysisVersion:INVOICE_RULES_VERSION,fieldEvidence:parsed.fields,textTruncated:String(text||'').length>MAX_INVOICE_TEXT},parsed));
  }
  const response = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [
      { role: "system", content: "Είσαι βοηθός ανάγνωσης ελληνικών ηλεκτρονικών τιμολογίων. Διάβασε μόνο ό,τι υπάρχει στο κείμενο και μην επινοείς στοιχεία." },
      { role: "user", content: `${INVOICE_EXTRACTION_PROMPT}\n\nΚείμενο ηλεκτρονικού τιμολογίου:\n${content}` }
    ],
    chat_template_kwargs: { enable_thinking: false }
  });
  return normalizeServiceDocumentOcr(enrichInvoiceExtraction(parseInvoiceAiResponse(response, content, source),parsed));
}

async function extractInvoiceFromImage(env, bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const image = `data:${type};base64,${btoa(binary)}`;
  const response = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [
      { role: "system", content: "Είσαι βοηθός OCR ελληνικών τιμολογίων. Διάβασε μόνο ό,τι φαίνεται στο έγγραφο και μην επινοείς στοιχεία." },
      {
        role: "user",
        content: [
          { type: "text", text: INVOICE_EXTRACTION_PROMPT },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ],
    chat_template_kwargs: { enable_thinking: false }
  });
  return parseInvoiceAiResponse(response, aiResponseText(response), "image");
}

function isPublicExternalQrUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    if (parsed.port && !["80", "443"].includes(parsed.port)) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "0.0.0.0" || host === "::1") return false;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some((part) => part > 255)) return false;
      const [a, b] = octets;
      if (a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function htmlToInvoiceText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>(?=.)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);
}

async function fetchExternalQrPage(url, signal) {
  let current = url;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isPublicExternalQrUrl(current)) throw new Error("unsafe_qr_redirect");
    const response = await fetch(current, { redirect: "manual", signal, headers: { Accept: "text/html,application/pdf,application/json,image/*" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
    const location = response.headers.get("location");
    if (!location) return { response, url: current };
    current = new URL(location, current).toString();
  }
  throw new Error("qr_redirect_limit");
}

function externalPdfCandidates(html, baseUrl) {
  const candidates = [];
  const add = (value) => {
    try {
      const candidate = new URL(String(value || ""), baseUrl).toString();
      if (!isPublicExternalQrUrl(candidate) || candidates.includes(candidate)) return;
      if (/\.pdf(?:[?#]|$)|download|print|invoice|parastat|timolog/i.test(candidate)) candidates.push(candidate);
    } catch {}
  };
  const attributes = /(?:href|src|data-url|data-download-url)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attributes.exec(String(html || ""))) && candidates.length < 8) add(match[1]);
  return candidates;
}

async function extractQrPdfPayload(env, response, qrValue, qrUrl, sourceUrl) {
  const type = documentContentType(response.headers.get("content-type") || "", sourceUrl);
  if (type !== "application/pdf") return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 15 * 1024 * 1024) throw new Error("qr_pdf_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024) throw new Error("qr_pdf_too_large");
  const filename = "invoice-qr-" + new Date().toISOString().slice(0, 10) + ".pdf";
  let extracted = null;
  let extractionError = "";
  if (env.AI?.toMarkdown) {
    try {
      const converted = await env.AI.toMarkdown({ name: filename, blob: new Blob([bytes], { type: "application/pdf" }) });
      const result = Array.isArray(converted) ? converted[0] : converted;
      if (result && result.format !== "error" && result.data) extracted = await extractInvoiceFromText(env, String(result.data), "qr-pdf");
      else extractionError = "Δεν ολοκληρώθηκε η ανάγνωση του PDF του QR.";
    } catch {
      extractionError = "Δεν ολοκληρώθηκε η ανάγνωση του PDF του QR.";
    }
  } else {
    extractionError = "Το OCR δεν είναι διαθέσιμο στον Worker.";
  }
  return { bytes, filename, type: "application/pdf", extracted, extractionError, qrValue, qrUrl, sourceUrl };
}

async function importQrServiceDocument(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.manage"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Η εισαγωγή τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);
  const body = await request.json().catch(() => ({}));
  const bikeId = cleanText(body.bikeId, 80);
  const entryId = cleanText(body.entryId, 120);
  const qrValue = normalizeQrValue(body.value);
  const qrUrl = qrUrlFromValue(qrValue);
  if (!bikeId || !entryId || !qrValue) return json({ error: "Λείπει το μηχανάκι, το service ή το QR." }, 400);
  if (!qrUrl || !isPublicExternalQrUrl(qrUrl)) return json({ ok: false, qrValue, qrUrl, code: "invalid_qr_url", error: "Το QR δεν περιέχει ασφαλή δημόσιο σύνδεσμο." }, 422);
  const located = await readServiceEntry(env, bikeId, entryId);
  const entry = located?.entry;
  if (!entry || entry.type === "check") return json({ error: "Το service δεν βρέθηκε. Αποθήκευσε πρώτα το service και ξαναδοκίμασε." }, 404);
  const sourcePhotoKey=cleanText(body.sourcePhotoKey,500);
  const photo=sourcePhotoKey?(entry.attachments||[]).flatMap(file=>[file,file.sourcePhoto]).find(file=>file?.key===sourcePhotoKey&&ServiceModel.sourcePhoto(file)):null;
  if(sourcePhotoKey&&!photo)return json({error:"Η αρχική φωτογραφία δεν βρέθηκε στο service."},404);
  const existing = (entry.attachments || []).find(item => item.contentType==='application/pdf' && String(item.qrUrl || item.qrValue) === qrUrl);
  if(existing&&photo&&!existing.sourcePhoto){existing.sourcePhoto=ServiceModel.sourcePhoto(photo);existing.uploadId=existing.uploadId||photo.uploadId||"";entry.attachments=entry.attachments.filter(file=>file.key!==photo.key);entry.updatedAt=new Date().toISOString();const saved=await writeServiceEntry(env,located,entry,'invoice-photo-link',entry.updatedAt);if(!saved)return json({error:"Το service άλλαξε. Δοκίμασε ξανά."},409);}
  if (existing) return json({ ok: true, duplicate: true, documentAvailable: true, attachment: existing, extracted: existing.ocr || null, qrValue, qrUrl, requiresConfirmation: Boolean(existing.ocr) });
  const duplicateMatches=(await invoiceDuplicates(env,{qrUrl})).filter(match=>String(match.bikeId)!==bikeId||String(match.entryId)!==entryId);
  if(duplicateMatches.length&&!body.allowDuplicate)return json({error:"Το τιμολόγιο υπάρχει ήδη σε άλλο service.",code:"duplicate_invoice",matches:duplicateMatches},409);
  const pending = await findPendingServiceRender(env, bikeId, entryId, qrUrl);
  if (!pending && !photo && (entry.attachments || []).length >= MAX_SERVICE_ATTACHMENTS) return json({ error: "Μπορείς να κρατήσεις έως 10 τιμολόγια σε ένα service. Τα υπάρχοντα αρχεία διατηρούνται." }, 409);
  if (pending) {
    if(photo&&!pending.payload.sourcePhotoKey){const updated={...pending.payload,sourcePhotoKey};await env.DB.prepare("UPDATE fleet_operations SET payload=? WHERE id=? AND status='pending' AND payload=?").bind(JSON.stringify(updated),pending.id,JSON.stringify(pending.payload)).run();pending.payload=updated;}
    await updateServiceDocumentProcessingSnapshot(env, pending.payload, {
      jobId: pending.id,
      status: "processing",
      progress: pending.payload.progress || 5,
      stage: pending.payload.progressStage || "Αναμονή από τον Server",
      error: pending.payload.lastError || "",
      attempts: Number(pending.payload.attemptCount || 0)
    });
    return json({
      ok: true,
      queued: true,
      jobId: pending.id,
      progress: Number(pending.payload.progress || 5),
      stage: pending.payload.progressStage || "Αναμονή από τον Server",
      documentAvailable: false,
      qrValue,
      qrUrl,
      code: "server_render_queued",
      message: "Το QR στάλθηκε στον Server για δημιουργία PDF."
    }, 202);
  }
  const jobId = crypto.randomUUID();
  const payload = {
    bikeId,
    entryId,
    qrValue,
    qrUrl,
    ...(photo?{sourcePhotoKey}:{}),
    requestedAt: new Date().toISOString(),
    requestedBy: cleanText(actor.id || actor.username || "admin", 120),
    attemptCount: 0,
    lastError: "",
    lastAttemptAt: "",
    progress: 5,
    progressStage: "QR αποθηκεύτηκε · αναμονή Server"
  };
  await env.DB.prepare("INSERT INTO fleet_operations (id, source, type, payload, status, created_at) VALUES (?, 'authenticated-client', 'service_document_render', ?, 'pending', ?)")
    .bind(jobId, JSON.stringify(payload), new Date().toISOString()).run();
  await updateServiceDocumentProcessingSnapshot(env, payload, {
    jobId,
    status: "processing",
    progress: 5,
    stage: payload.progressStage,
    error: "",
    attempts: 0
  });
  return json({
    ok: true,
    queued: true,
    jobId,
    progress: 5,
    stage: payload.progressStage,
    documentAvailable: false,
    qrValue,
    qrUrl,
    code: "server_render_queued",
    message: "Το QR στάλθηκε στον Server για δημιουργία PDF."
  }, 202);
}

async function findPendingServiceRender(env, bikeId, entryId, qrUrl) {
  const result = await env.DB.prepare("SELECT id, payload FROM fleet_operations WHERE type = 'service_document_render' AND status = 'pending' ORDER BY created_at DESC LIMIT 100").all();
  for (const row of result.results || []) {
    try {
      const payload = JSON.parse(row.payload || "{}");
      if (String(payload.bikeId) === String(bikeId) && String(payload.entryId) === String(entryId) && String(payload.qrUrl) === String(qrUrl)) {
        return { id: row.id, payload };
      }
    } catch {}
  }
  return null;
}

async function serviceDocumentJobStatus(request, env) {
  if (!await authorizedFor(request, env, "fleet.view")) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const path = new URL(request.url).pathname;
  const jobId = decodeURIComponent(path.slice("/api/service-documents/jobs/".length));
  if (!jobId || jobId.length > 120) return json({ error: "Μη έγκυρη εργασία τιμολογίου." }, 400);
  const row = await env.DB.prepare("SELECT id, type, payload, status, created_at, applied_at FROM fleet_operations WHERE id = ? LIMIT 1").bind(jobId).first();
  if (!row || row.type !== "service_document_render") return json({ error: "Η εργασία τιμολογίου δεν βρέθηκε." }, 404);
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}
  if (row.status === "cancelled") return json({ ok: true, jobId, status: "cancelled", stage: "Διακόπηκε για νέα προσπάθεια" });
  const located = await readServiceEntry(env, payload.bikeId, payload.entryId);
  const entry = located?.entry;
  const attachment = (entry?.attachments || []).find((item) => jobAttachmentMatches(item,payload,jobId));
  if (attachment) {
    return json({ ok: true, jobId, status: "completed", progress: 100, stage: "Ολοκληρώθηκε", attempts: Number(payload.attemptCount || 0), attachment, extracted: attachment.ocr || null, qrValue: payload.qrValue, qrUrl: payload.qrUrl });
  }
  if (row.status === "applied" && entry) {
    const failure = missingServiceDocumentState(payload);
    await notifyServiceDocumentFailure(env, payload, jobId, failure.error, failure.code);
    return json({ ok: true, jobId, ...failure, qrValue: payload.qrValue, qrUrl: payload.qrUrl });
  }
  const state = serviceRenderState(payload, row.status, row.created_at);
  return json({ ok: true, jobId, ...state, appliedAt: row.applied_at || null, qrValue: payload.qrValue, qrUrl: payload.qrUrl });
}

function missingServiceDocumentState(payload) {
  if (payload?.documentKey) return {status:"error",progress:75,code:"analysis_incomplete",canRetry:true,stage:"Η ανάλυση του τιμολογίου δεν επιβεβαιώθηκε",error:"Το αρχικό αρχείο διατηρείται, αλλά η ανάλυσή του δεν ολοκληρώθηκε. Πάτησε Επανάληψη."};
  return { status: "error", progress: Math.max(5, Math.min(95, Number(payload?.progress) || 5)),
    code: "document_missing", stage: "Το PDF δεν συνδέθηκε με το service", canRetry: true,
    error: "Η εργασία δηλώθηκε ολοκληρωμένη, αλλά δεν βρέθηκε συνδεδεμένο PDF. Πάτησε Επανάληψη για νέα προσπάθεια από το αποθηκευμένο QR." };
}

async function notifyServiceDocumentFailure(env, payload, jobId, error, phase="processing") {
  if (!jobId || !payload?.bikeId || !payload?.entryId || payload.draftId) return;
  try {
    const attempt = String(payload.retryRequestedAt || payload.requestedAt || "initial").slice(0,40);
    const dedupe = "invoice-qr:" + jobId + ":" + attempt + ":" + phase;
    if (await env.DB.prepare("SELECT id FROM system_alerts WHERE dedupe_key=? LIMIT 1").bind(dedupe).first()) return;
    const activeAlert=await env.DB.prepare("SELECT id,message FROM system_alerts WHERE type='invoice_processing_failed' AND object_id=? AND resolved=0 LIMIT 1").bind(jobId).first();
    if(activeAlert){await env.DB.prepare('UPDATE system_alerts SET message=? WHERE id=? AND resolved=0').bind(String(activeAlert.message||'').split(': ')[0]+': '+cleanText(error,350)+' Η προσπάθεια απέτυχε· μπορείς να επιλέξεις Επανάληψη.',activeAlert.id).run();return;}
    const located = await readServiceEntry(env, payload.bikeId, payload.entryId);
    if (!located || located.entry.type === "check") return;
    await env.DB.prepare("INSERT OR IGNORE INTO alert_rules(type,enabled,severity,channel,updated_at) VALUES ('invoice_processing_failed',1,'warning','both',?)").bind(new Date().toISOString()).run();
    const date = String(located.entry.date || "").slice(0,10).split('-').reverse().join('/');
    await createExternalAlert(env, "invoice_processing_failed", "warning", "Το τιμολόγιο χρειάζεται επανάληψη",
      cleanText(located.bike.name,80) + " · service " + date + ": " + cleanText(error,350) + " Άνοιξε το service ή τα Τιμολόγια για έλεγχο και επανάληψη.",
      "invoice_job", jobId, dedupe);
  } catch (error) { console.warn("Invoice failure notification could not be stored."); }
}

async function resolveServiceDocumentFailure(env, jobId) {
  if (!jobId) return;
  try { await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='invoice_processing_failed' AND object_id=? AND resolved=0").bind(new Date().toISOString(),jobId).run(); }
  catch (error) { console.warn("Invoice notification could not be resolved."); }
}

function serviceRenderState(payload, rowStatus, createdAt) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const startedAt = safePayload.requestedAt || createdAt || "";
  const startedMs = Date.parse(startedAt);
  const elapsedSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : 0;
  const attempts = Math.max(0, Number(safePayload.attemptCount || 0));
  const hasError = Boolean(String(safePayload.lastError || "").trim());
  let status = rowStatus === "error" ? "error" : rowStatus === "applied" ? "completed" : (hasError || elapsedSeconds >= Math.round(SERVICE_RENDER_DELAY_MS / 1000) ? "delayed" : "processing");
  const progress = status === "completed"
    ? 100
    : cleanInteger(safePayload.progress, 5, 95, 5);
  const stage = status === "error"
    ? "Απαιτείται επανάληψη"
    : status === "delayed"
      ? (safePayload.progressStage || "Καθυστέρηση · ο Server θα ξαναδοκιμάσει")
      : (safePayload.progressStage || "Σε επεξεργασία από τον Server");
  return {
    status,
    progress,
    stage,
    elapsedSeconds,
    attempts,
    error: String(safePayload.lastError || ""),
    canRetry: status === "error" || status === "delayed",
    createdAt: createdAt || startedAt,
    lastAttemptAt: safePayload.lastAttemptAt || ""
  };
}

async function updateServiceDocumentProcessingSnapshot(env, payload, state) {
  if (!payload || !payload.bikeId || !payload.entryId) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const located = await readServiceEntry(env, payload.bikeId, payload.entryId);
    if (!located || located.entry.type === "check") return null;
    const entry = located.entry;
    const current = normalizeServiceInvoiceData(entry.invoiceData) || {};
    const next = { ...current };
    const set = (key, value) => {
      if (value === undefined || value === null) return;
      const text = String(value).trim();
      if (text) next[key] = text;
      else delete next[key];
    };
    set("qrJobId", state.jobId || payload.jobId || "");
    set("qrProcessingStatus", state.status || "processing");
    set("qrProcessingStartedAt", payload.requestedAt || new Date().toISOString());
    set("qrProcessingUpdatedAt", new Date().toISOString());
    set("qrProcessingError", state.error || "");
    set("qrProcessingAttempts", Number(state.attempts || 0));
    set("qrProcessingProgress", cleanInteger(state.progress, 0, 100, 0));
    set("qrProcessingStage", state.stage || "Σε επεξεργασία από τον Server");
    if (payload.qrUrl && !next.qrUrl) next.qrUrl = qrUrlFromValue(payload.qrUrl);
    if (!next.source) next.source = "qr";
    entry.invoiceData = normalizeServiceInvoiceData(next);
    const now = new Date().toISOString();
    entry.updatedAt = now;
    const version = await writeServiceEntry(env, located, entry, "service-document-processing", now, state.jobId || "");
    if (version) return { version };
  }
  throw new Error("Η πρόοδος ενημερώνεται ταυτόχρονα. Θα ξαναδοκιμάσει.");
}

async function renderJobCancelled(env, jobId) {
  return (await env.DB.prepare("SELECT status FROM fleet_operations WHERE id=?").bind(jobId).first())?.status === "cancelled";
}

async function restartServiceDocument(request, env) {
  if (!await serverAuthorized(request, env)) {
    let actor;
    try { actor = await authenticateExternal(request, env, "fleet.manage"); }
    catch (error) { return json({ error: error.message }, Number(error.status) || 401); }
    if (!isManagementActor(actor)) return json({ error: "Χρειάζεται λογαριασμός διαχείρισης." }, 403);
  }
  const body = await request.json().catch(() => ({}));
  const jobId = cleanText(body.jobId,120);
  const row = jobId ? await env.DB.prepare("SELECT id,type,payload,status FROM fleet_operations WHERE id=?").bind(jobId).first() : null;
  if (jobId && (!row || row.type !== "service_document_render")) return json({error:"Η εργασία δεν βρέθηκε."},404);
  if (row?.status === "cancelled") return json({error:"Έχει ήδη ξεκινήσει νέα προσπάθεια. Ανανέωσε τη λίστα."},409);
  let payload = {};
  try { payload = JSON.parse(row?.payload || "{}"); } catch {}
  if(payload.draftId){
    const draft=await readImportDraftForJob(env,jobId),restarted=await restartImportDraft(env,draft);
    if(!restarted)return json({error:"Το προσχέδιο έχει ήδη ολοκληρωθεί ή άλλαξε. Ανανέωσε τη λίστα."},409);
    return json({ok:true,restarted:true,jobId:restarted.jobId,previousJobId:jobId,status:"processing"});
  }
  const located = await readServiceEntry(env,payload.bikeId || cleanText(body.bikeId,80),payload.entryId || cleanText(body.entryId,120));
  if (!located || located.entry.type === "check") return json({error:"Το service δεν βρέθηκε."},404);
  if(payload.documentKey){await env.DB.prepare("UPDATE fleet_operations SET status='cancelled',applied_at=? WHERE id=? AND status IN ('pending','error')").bind(new Date().toISOString(),jobId).run();return queueStoredAnalysis(env,payload.documentKey,{});}
  const qrUrl = qrUrlFromValue(payload.qrUrl || body.qrUrl || located.entry.invoiceData?.qrUrl);
  if (!qrUrl || !isPublicExternalQrUrl(qrUrl)) return json({error:"Δεν υπάρχει έγκυρο QR. Σκάναρε ξανά το τιμολόγιο."},400);
  const photo=located.entry.attachments?.find(file=>String(file.qrUrl||file.qrValue)===qrUrl&&ServiceModel.sourcePhoto(file));
  const sourcePhotoKey=payload.sourcePhotoKey||photo?.key||'';
  const existing = located.entry.attachments?.find(x => x.key!==sourcePhotoKey && (String(x.qrUrl || x.qrValue) === qrUrl || (jobId && String(x.renderJobId) === jobId)));
  if (existing) {
    if (existing.ocrError) {
      const headers=new Headers(request.headers);headers.delete("Content-Length");
      return reprocessAdminServiceDocument(new Request(new URL("/api/admin/service-documents/reprocess",request.url),{method:"POST",headers,body:JSON.stringify({key:existing.key,forceAi:true})}),env);
    }
    return json({ok:true,status:"completed",attachment:existing,reused:true});
  }
  // A legacy orphan card may have a newer live job: never start it twice.
  if (!row) {
    const active = await findPendingServiceRender(env,located.bike.id,located.entry.id,qrUrl);
    if (active) {
      await updateServiceDocumentProcessingSnapshot(env,active.payload,{jobId:active.id,status:"processing",progress:active.payload.progress || 5,stage:active.payload.progressStage || "Αναμονή Server",error:active.payload.lastError || ""});
      return json({ok:true,jobId:active.id,status:"processing",existing:true});
    }
  }
  const newId = crypto.randomUUID(), now = new Date().toISOString();
  const next = { bikeId:located.bike.id,entryId:located.entry.id,qrUrl,qrValue:payload.qrValue || qrUrl,
    ...(sourcePhotoKey?{sourcePhotoKey}:{}),requestedAt:now,attemptCount:0,progress:5,progressStage:"Νέα προσπάθεια · αναμονή Server",replacesJobId:jobId };
  const insert = row
    ? env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) SELECT ?,'manual-retry','service_document_render',?,'pending',? WHERE EXISTS (SELECT 1 FROM fleet_operations WHERE id=? AND status IN ('pending','error','applied') AND payload=?)").bind(newId,JSON.stringify(next),now,jobId,row.payload)
    : env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) SELECT ?,'manual-retry','service_document_render',?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM fleet_operations WHERE type='service_document_render' AND status='pending' AND json_extract(payload,'$.bikeId')=? AND json_extract(payload,'$.entryId')=? AND json_extract(payload,'$.qrUrl')=?)").bind(newId,JSON.stringify(next),now,located.bike.id,located.entry.id,qrUrl);
  const statements = [insert];
  if (row) statements.push(env.DB.prepare("UPDATE fleet_operations SET status='cancelled',applied_at=? WHERE id=? AND EXISTS (SELECT 1 FROM fleet_operations WHERE id=?)").bind(now,jobId,newId));
  if(row)statements.push(env.DB.prepare("UPDATE system_alerts SET object_id=? WHERE type='invoice_processing_failed' AND object_id=? AND resolved=0 AND EXISTS(SELECT 1 FROM fleet_operations WHERE id=?)").bind(newId,jobId,newId));
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta?.changes) return json({error:"Η εργασία άλλαξε. Ανανέωσε και δοκίμασε ξανά."},409);
  await updateServiceDocumentProcessingSnapshot(env,next,{jobId:newId,status:"processing",progress:5,stage:next.progressStage,error:"",attempts:0});
  return json({ok:true,restarted:true,jobId:newId,previousJobId:jobId,status:"processing"});
}

async function retryServiceDocumentJob(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.manage"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Η επανάληψη τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);
  const path = new URL(request.url).pathname;
  const jobId = decodeURIComponent(path.slice("/api/service-documents/jobs/".length, -"/retry".length));
  if (!jobId || jobId.length > 120) return json({ error: "Μη έγκυρη εργασία τιμολογίου." }, 400);
  const row = await env.DB.prepare("SELECT id, type, payload, status FROM fleet_operations WHERE id = ? LIMIT 1").bind(jobId).first();
  if (!row || row.type !== "service_document_render") return json({ error: "Η εργασία τιμολογίου δεν βρέθηκε." }, 404);
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}
  const located = await readServiceEntry(env, payload.bikeId, payload.entryId);
  if(payload.documentKey){await env.DB.prepare("UPDATE fleet_operations SET status='cancelled',applied_at=? WHERE id=? AND status IN ('pending','error')").bind(new Date().toISOString(),jobId).run();return queueStoredAnalysis(env,payload.documentKey,{});}
  const existing = (located?.entry.attachments || []).find(item => jobAttachmentMatches(item,payload,jobId));
  if (existing) {
    if (existing.ocrError) {
      const headers = new Headers(request.headers);
      headers.delete("Content-Length");
      const retryRequest = new Request(new URL("/api/admin/service-documents/reprocess", request.url), {
        method: "POST", headers, body: JSON.stringify({ key: existing.key, forceAi: true })
      });
      const response = await reprocessAdminServiceDocument(retryRequest, env);
      if (!response.ok) return response;
      const result = await response.json();
      return json({ ...result, jobId, reprocessed: true, status: result.ocrWarning ? "error" : "completed", progress: result.ocrWarning ? 0 : 100, error: result.ocrWarning || "" });
    }
    await updateServiceDocumentProcessingSnapshot(env, payload, { jobId, status: "completed", progress: 100, stage: "Ολοκληρώθηκε", error: "" });
    return json({ ok: true, jobId, status: "completed", progress: 100, attachment: existing });
  }
  const now = new Date().toISOString();
  // A retry is a new processing attempt. Reset its start timestamp so the
  // UI does not keep showing the age of the original QR job.
  payload.requestedAt = now;
  payload.attemptCount = 0;
  payload.lastError = "";
  payload.lastAttemptAt = now;
  payload.retryRequestedAt = now;
  payload.transientAttemptCount = 0;
  delete payload.nextAttemptAt;
  payload.progress = 5;
  payload.progressStage = "Επανάληψη · αναμονή από τον Server";
  await env.DB.prepare("UPDATE fleet_operations SET payload = ?, status = 'pending', applied_at = NULL WHERE id = ?")
    .bind(JSON.stringify(payload), jobId).run();
  await updateServiceDocumentProcessingSnapshot(env, payload, { jobId, status: "processing", progress: 5, stage: payload.progressStage, error: "", attempts: 0 });
  return json({ ok: true, queued: true, jobId, status: "processing", progress: 5, stage: payload.progressStage });
}

function mergeServerInvoiceData(...values) {
  const merged = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item)) {
        if (item.length) merged[key] = item.slice();
      } else if (item != null && String(item).trim()) {
        merged[key] = item;
      }
    }
  }
  return normalizeServiceInvoiceData(merged) || {};
}

function adminServiceDocumentStatus(attachment, data, warnings) {
  if (attachment?.ocrError) return "error";
  if (warnings.length) return "warning";
  if (data?.confirmedAt) return "confirmed";
  if (data && Object.keys(data).length) return "needs_review";
  return "uploaded";
}

function invoiceDataForServiceDocument(entry, attachment) {
  const fallback = !attachment || (entry?.attachments || []).length <= 1 ? entry?.invoiceData : null;
  const data = mergeServerInvoiceData(fallback, attachment?.qrData, attachment?.ocr);
  if(attachment?.key&&data.reviewDocumentKey&&data.reviewDocumentKey!==attachment.key){
    for(const field of ['confirmedAt','reviewedBy','confirmationMethod','confirmationRuleVersion','confirmationReason','correctedByUserAt','plateResolution','plateResolutionBikeId','plateResolutionPlate','plateResolutionRead','mileageResolution','mileageResolutionEntryId','mileageResolutionRead','mileageResolutionServiceKm','lastReadFingerprint','acknowledgedReadFingerprint','lastReadCanonicalFingerprint','acknowledgedReadCanonicalFingerprint','lastReadFields','acknowledgedReadFields','reviewDocumentKey'])delete data[field];
    data.reviewStatus='needs_review';
  }
  return data.confirmedAt ? data : normalizeServiceDocumentOcr(data) || {};
}

function adminServiceDocumentRecord(bike, entry, attachment, pending = null, allBikes = [], compact = false) {
  const data = invoiceDataForServiceDocument(entry, attachment);
  const invoiceLineCount=Math.max(Number(attachment?._listLineCount||entry?._listLineCount||0),Array.isArray(data.lineItems)?data.lineItems.length:0);
  const previewTruncated=Boolean(compact&&(attachment?._listWorkTruncated||entry?._listWorkTruncated||invoiceLineCount>12||Math.max(Number(entry?._listTaskCount||0),(entry?.tasks||[]).length)>12));
  if(compact)for(const field of ['rawText','fieldEvidence','analysisTimings'])delete data[field];
  const warnings = serviceDocumentWarnings(bike, entry, data);
  if(attachment?.ocrError&&data.confirmedAt)warnings.push({type:"latest-read-error",label:"Απέτυχε η νέα ανάγνωση",message:"Η προηγούμενη επιβεβαίωση διατηρείται. "+cleanText(attachment.ocrError,300)});
  if(compact){for(const field of ['lineItems','parts'])if(Array.isArray(data[field]))data[field]=data[field].slice(0,12);if(data.workPerformed)data.workPerformed=data.workPerformed.split('\n').slice(0,12).join('\n');}
  const name = attachment?.name || buildInvoiceDisplayName(bike?.name, data.invoiceDate, entry?.date, attachment?.originalName);
  const processing = pending ? serviceRenderState(pending.payload || {}, pending.operationStatus || "pending", pending.createdAt) : null;
  const status = processing ? processing.status : adminServiceDocumentStatus(attachment, data, warnings);
  const reviewSeenAt = attachment?.reviewSeenAt || data?.reviewSeenAt || "";
  return {
    id: attachment?.key || pending?.jobId || `${bike?.id || ""}:${entry?.id || ""}`,
    status,
    jobId: cleanText(pending?.jobId || attachment?.renderJobId, 120),
    bikeId: String(bike?.id || pending?.bikeId || ""),
    bikeName: String(bike?.name || pending?.bikeName || "—"),
    entryId: String(entry?.id || pending?.entryId || ""),
    serviceDate: String(entry?.date || pending?.serviceDate || ""),
    serviceKm: Number(entry?.km || pending?.serviceKm || 0),
    serviceUpdatedAt: String(entry?.updatedAt || ""),
    reviewJournal: compact ? [] : ServiceModel.journal(entry?.reviewJournal),
    tasks: Array.isArray(entry?.tasks) ? entry.tasks.slice(0, compact?12:5120) : [],
    invoiceLineCount, previewTruncated,
    key: String(attachment?.key || ""),
    name,
    originalName: String(attachment?.originalName || ""),
    sourcePhoto: ServiceModel.sourcePhoto(attachment?.sourcePhoto),
    contentType: String(attachment?.contentType || "application/pdf"),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || "",
    qrValue: String(attachment?.qrValue || pending?.qrValue || data.qrUrl || ""),
    qrUrl: String(attachment?.qrUrl || pending?.qrUrl || data.qrUrl || ""),
    invoiceData: data,
    warnings,
    transferOptions: [],
    transferOptionsLazy: true,
    detailsLazy: Boolean(compact && attachment?.key),
    error: String(attachment?.ocrError || processing?.error || ""),
    processing: Boolean(processing && ["processing", "delayed"].includes(processing.status)),
    progress: processing ? processing.progress : (status === "confirmed" ? 100 : 0),
    progressStage: processing ? processing.stage : "",
    elapsedSeconds: processing ? processing.elapsedSeconds : 0,
    attempts: processing ? processing.attempts : 0,
    canRetry: Boolean(processing?.canRetry || attachment?.ocrError),
    canRestart: Boolean(processing && !attachment?.key),
    createdAt: pending?.createdAt || attachment?.uploadedAt || "",
    lastAttemptAt: processing?.lastAttemptAt || "",
    reviewSeenAt,
    isNew: !reviewSeenAt && status !== "confirmed"
  };
}

async function invoiceTransferOptions(request, env) {
  if (!await authorizedFor(request, env, "fleet.view")) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const url = new URL(request.url);
  const located = await readServiceEntry(env, cleanText(url.searchParams.get("bikeId"), 100), cleanText(url.searchParams.get("entryId"), 120));
  const key = cleanText(url.searchParams.get("key"), 500);
  const attachment = located?.entry.attachments?.find(item => String(item.key) === key);
  if (!located || !attachment) return json({ error: "Το τιμολόγιο δεν βρέθηκε." }, 404);
  const data = invoiceDataForServiceDocument(located.entry, attachment);
  const extra = {};
  if(url.searchParams.get('includeDocument')==='1'){
    extra.document=adminServiceDocumentRecord(located.bike,located.entry,attachment);
    extra.document.reviewRevision=await invoiceReviewRevision(located.entry,attachment);
  }
  const names = await fleetNames(env);
  const exact = data.plate ? names.filter(b => b.id !== located.bike.id && invoicePlateKey(b.name) === invoicePlateKey(data.plate)) : [];
  const candidates = exact.length ? exact : names.filter(b => b.id !== located.bike.id);
  if (!candidates.length) return json({ options: [], ...extra });
  const ids = candidates.map(b => String(b.id));
  const rows = await env.DB.prepare(`SELECT json_extract(b.value,'$.id') AS bikeId, json_extract(b.value,'$.name') AS bikeName,
    json_extract(h.value,'$.id') AS entryId, json_extract(h.value,'$.date') AS serviceDate, json_extract(h.value,'$.km') AS serviceKm
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h
    WHERE s.id=1 AND json_extract(b.value,'$.id') IN (${ids.map(() => '?').join(',')})
    AND json_extract(h.value,'$.type') != 'check' ORDER BY bikeName, serviceKm DESC LIMIT 200`).bind(...ids).all();
  const options = (rows.results || []).sort((a,b) => String(a.bikeName).localeCompare(String(b.bikeName), "el") || Number(b.serviceKm || 0) - Number(a.serviceKm || 0));
  return json({ options, ...extra });
}

async function listAdminServiceDocuments(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.view"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!actor) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const url=new URL(request.url),paged=url.searchParams.get('paged')==='1';
  const cursor=url.searchParams.get('cursor')||'',limit=4;
  if(paged&&cursor&&!/^\d+:\d+$/.test(cursor))return json({error:'Μη έγκυρη σελίδα τιμολογίων.'},400);
  const summary = await snapshotSummary(env);
  const offset=paged&&cursor?Number(cursor.split(':')[1]):0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>20000)return json({error:'Μη έγκυρη σελίδα τιμολογίων.'},400);
  if(paged&&cursor&&Number(cursor.split(':')[0])!==summary.version)return json({error:'Τα τιμολόγια άλλαξαν. Η λίστα θα διαβαστεί ξανά.',code:'invoice_list_changed'},409);
  const shortArray=expr=>`json((SELECT COALESCE(json_group_array(CASE WHEN x.type IN ('object','array') THEN json(x.value) ELSE x.value END),'[]') FROM (SELECT value,type FROM json_each(${expr}) LIMIT 12) x))`;
  // SQLite projects bounded list previews. Full detail is read only on open.
  const shortInvoice=expr=>`json_set(json_remove(${expr},'$.rawText','$.fieldEvidence','$.analysisTimings'),
    '$.lineItems',${shortArray("json_extract("+expr+",'$.lineItems')")},
    '$.parts',${shortArray("json_extract("+expr+",'$.parts')")},
    '$.workPerformed',CASE WHEN json_array_length(${expr},'$.lineItems')>0 THEN '' ELSE substr(COALESCE(json_extract(${expr},'$.workPerformed'),''),1,600) END)`;

  const invoiceRows = await env.DB.prepare(`SELECT s.version AS snapshot_version, json_extract(b.value,'$.id') AS bike_id,
    json_extract(b.value,'$.name') AS bike_name,
    json_object('id',json_extract(h.value,'$.id'),'type',json_extract(h.value,'$.type'),
      'date',json_extract(h.value,'$.date'),'km',json_extract(h.value,'$.km'),
      'updatedAt',json_extract(h.value,'$.updatedAt'),'tasks',${shortArray("json_extract(h.value,'$.tasks')")},'_listTaskCount',json_array_length(h.value,'$.tasks'),'_listWorkTruncated',length(COALESCE(json_extract(h.value,'$.invoiceData.workPerformed'),''))>600,'_listLineCount',json_array_length(h.value,'$.invoiceData.lineItems'),
      'invoiceData',${shortInvoice("json_extract(h.value,'$.invoiceData')")},
      'attachments',json((SELECT COALESCE(json_group_array(json(json_set(a.value,'$.ocr',${shortInvoice("json_extract(a.value,'$.ocr')")},'$.qrData',${shortInvoice("json_extract(a.value,'$.qrData')")},'$._listWorkTruncated',MAX(length(COALESCE(json_extract(a.value,'$.ocr.workPerformed'),'')),length(COALESCE(json_extract(a.value,'$.qrData.workPerformed'),'')))>600,'$._listLineCount',MAX(COALESCE(json_array_length(a.value,'$.ocr.lineItems'),0),COALESCE(json_array_length(a.value,'$.qrData.lineItems'),0))))),'[]')
        FROM json_each(h.value,'$.attachments') a))) AS entry_json
    FROM fleet_snapshot s, json_each(s.data,'$.bikes') b, json_each(b.value,'$.history') h
    WHERE s.id=1 AND json_extract(h.value,'$.type') != 'check'
    AND (json_array_length(h.value,'$.attachments') > 0 OR json_extract(h.value,'$.invoiceData.qrUrl') IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=json_extract(b.value,'$.id')) ORDER BY b.key,h.key ${paged?'LIMIT ? OFFSET ?':''}`).bind(...(paged?[limit+1,offset]:[])).all();
  if(paged&&invoiceRows.results?.some(row=>Number(row.snapshot_version)!==summary.version))return json({error:'Τα τιμολόγια άλλαξαν κατά την ανάγνωση.',code:'invoice_list_changed'},409);
  const hasMore=paged&&invoiceRows.results.length>limit;
  if(paged)invoiceRows.results=invoiceRows.results.slice(0,limit);
  let mapStart=performanceNow(),mapMs=0;
  const bikes = new Map();
  for (const row of invoiceRows.results || []) {
    if (!bikes.has(row.bike_id)) bikes.set(row.bike_id, { id: row.bike_id, name: row.bike_name, history: [] });
    bikes.get(row.bike_id).history.push(JSON.parse(row.entry_json));
  }
  const snapshot = { version: Number(invoiceRows.results?.[0]?.snapshot_version ?? summary.version), data: { bikes: [...bikes.values()] } };
  mapMs+=performanceNow()-mapStart;
  const pendingRows = await env.DB.prepare("SELECT id, payload, status, created_at FROM fleet_operations WHERE type = 'service_document_render' AND status IN ('pending','error') ORDER BY created_at DESC LIMIT 100").all();
  mapStart=performanceNow();
  const pendingIds=new Set((pendingRows.results||[]).map(row=>row.id));
  const documents = [];
  for (const bike of snapshot.data.bikes || []) {
    for (const entry of bike.history || []) {
      if (entry.type === "check") continue;
      for (const attachment of entry.attachments || []) {
        documents.push(adminServiceDocumentRecord(bike, entry, attachment, null, snapshot.data.bikes,true));
      }
      const legacy=ServiceModel.qrDocumentState(entry);
      if (entry.invoiceData?.qrUrl && !pendingIds.has(entry.invoiceData.qrJobId) && (legacy?.needsVerification || (!(entry.attachments || []).length && !entry.invoiceData.qrJobId))) {
        documents.push(adminServiceDocumentRecord(bike, entry, null, {
          bikeId: bike.id, bikeName: bike.name, entryId: entry.id,
          serviceDate: entry.date, serviceKm: entry.km,
          qrValue: entry.invoiceData.qrUrl, qrUrl: entry.invoiceData.qrUrl,
          jobId: entry.invoiceData.qrJobId,
          payload: entry.invoiceData.qrJobId ? {
            requestedAt: entry.invoiceData.qrProcessingStartedAt || entry.updatedAt || new Date().toISOString(),
            attemptCount: entry.invoiceData.qrProcessingAttempts || 0,
            lastError: legacy?.needsVerification ? missingServiceDocumentState({}).error : entry.invoiceData.qrProcessingError || "",
            progress: entry.invoiceData.qrProcessingProgress || 5,
            progressStage: entry.invoiceData.qrProcessingStage || "Σε επεξεργασία από τον Server"
          } : {},
          operationStatus: legacy?.needsVerification || entry.invoiceData.qrProcessingStatus === "error" ? "error" : "pending",
          createdAt: entry.invoiceData.qrProcessingStartedAt || entry.updatedAt || ""
        }, snapshot.data.bikes,true));
      }
    }
  }
  for (const row of pendingRows.results || []) {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch {}
    const bike = (snapshot.data.bikes || []).find((item) => String(item.id) === String(payload.bikeId));
    const entry = bike && (bike.history || []).find((item) => String(item.id) === String(payload.entryId));
    if (!bike || !entry) continue;
    if(payload.sourcePhotoKey){const photo=entry.attachments?.find(file=>file.key===payload.sourcePhotoKey);if(photo){const index=documents.findIndex(item=>item.key===photo.key);if(index>=0)documents[index]=adminServiceDocumentRecord(bike,entry,photo,{jobId:row.id,payload,operationStatus:row.status,createdAt:row.created_at},snapshot.data.bikes,true);continue;}}
    if(payload.documentKey){const attachment=entry.attachments?.find(file=>file.key===payload.documentKey);if(attachment&&attachment.renderJobId!==row.id){const index=documents.findIndex(item=>item.key===payload.documentKey);if(index>=0)documents[index]=adminServiceDocumentRecord(bike,entry,attachment,{jobId:row.id,payload,operationStatus:row.status,createdAt:row.created_at},snapshot.data.bikes,true);}continue;}
    const existing = (entry.attachments || []).find((item) => String(item.renderJobId) === String(row.id) || String(item.qrUrl || item.qrValue) === String(payload.qrUrl));
    if (existing) continue;
    documents.push(adminServiceDocumentRecord(bike, entry, null, {
      jobId: row.id, bikeId: bike.id, bikeName: bike.name, entryId: entry.id,
      serviceDate: entry.date, serviceKm: entry.km, qrValue: payload.qrValue, qrUrl: payload.qrUrl,
      payload, operationStatus: row.status, createdAt: row.created_at
    }, snapshot.data.bikes,true));
  }
  documents.sort((left, right) => String(right.uploadedAt || right.serviceDate || "").localeCompare(String(left.uploadedAt || left.serviceDate || "")));
  const response=json({ ok: true, documents,hasMore,nextCursor:hasMore?summary.version+':'+(offset+limit):'', serverVersion: snapshot.version, generatedAt: new Date().toISOString() });
  mapMs+=performanceNow()-mapStart;response.headers.set('Server-Timing','invoice-list-js;dur='+mapMs.toFixed(2));response.headers.set('X-Fleet-Invoice-Entries',String(invoiceRows.results.length));return response;
}

async function markAdminServiceDocumentSeen(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.view"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!actor) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const body = await request.json().catch(() => ({}));
  const bikeId = cleanText(body.bikeId, 100);
  const entryId = cleanText(body.entryId, 100);
  const key = cleanText(body.key, 500);
  if (!bikeId || !entryId) return json({ error: "Λείπει η σύνδεση με το service." }, 400);
  for (let attempt=0; attempt<5; attempt++) {
    const located = await readServiceEntry(env, bikeId, entryId);
    if (!located || located.entry.type === "check") return json({ error: "Το service δεν βρέθηκε." }, 404);
    const entry = located.entry;
    const now = new Date().toISOString();
    const data = normalizeServiceInvoiceData(entry.invoiceData) || {};
    const attachment = key && (entry.attachments || []).find(item => String(item.key) === key);
    if(key && !attachment)return json({error:'Το τιμολόγιο δεν βρέθηκε.'},404);
    if(data.reviewSeenAt && (!attachment || attachment.reviewSeenAt))return json({ok:true,reviewSeenAt:attachment?.reviewSeenAt||data.reviewSeenAt,version:located.version,unchanged:true});
    data.reviewSeenAt = data.reviewSeenAt || now;
    entry.invoiceData = data;
    if (attachment) attachment.reviewSeenAt = attachment.reviewSeenAt || now;
    // Viewing an invoice changes only seen metadata, never the service revision.
    const version = await writeServiceEntry(env, located, entry, "admin-service-document-seen", now);
    if (version) return json({ ok: true, reviewSeenAt: data.reviewSeenAt, version });
  }
  return json({ error: "Το service ενημερώθηκε ταυτόχρονα. Δοκίμασε ξανά." }, 409);
}

function normalizeInvoiceDecision(value, result) {
  const issues = list => (Array.isArray(list) ? list : []).slice(0, 40).map(item => ({field:cleanText(item?.field,60),code:cleanText(item?.code,80),message:cleanText(item?.message,400)})).filter(item=>item.field&&item.code&&item.message);
  if (Array.isArray(value.reviewIssues) && value.reviewIssues.length) result.reviewIssues = issues(value.reviewIssues);
  if (value.textTruncated != null) result.textTruncated = value.textTruncated === true || value.textTruncated === 'true';
  if (value.extractionChecks && typeof value.extractionChecks === 'object') result.extractionChecks = {
    version:cleanText(value.extractionChecks.version,80),completeTable:value.extractionChecks.completeTable===true,
    rowCount:cleanInteger(value.extractionChecks.rowCount,0,100000,0),problems:issues(value.extractionChecks.problems)
  };
}

async function decideInvoiceRead(env, bike, entry, attachment, data, names, previous = {}, readError = '', proof) {
  if(previous.reviewDocumentKey&&previous.reviewDocumentKey!==attachment.key)previous={};
  const now = new Date().toISOString(), protectedData = Boolean(previous.confirmedAt || previous.correctedByUserAt || previous.mileageResolution || previous.plateResolution);
  const comparison=invoiceReadComparison(data,ServiceModel.cents);
  const fingerprint=await sha256(stableReviewJson(comparison));
  const fieldHashes=async value=>Object.fromEntries(await Promise.all(READ_FIELDS.map(async field=>[field,await sha256(stableReviewJson(value[field]))])));
  const readFields=await fieldHashes(comparison);
  let acceptedFields=null;try{const parsed=JSON.parse(previous.acknowledgedReadFields||(!previous.acknowledgedReadFingerprint?previous.lastReadFields:'')||'null');if(parsed&&READ_FIELDS.every(f=>/^[a-f0-9]{64}$/.test(parsed[f])))acceptedFields=parsed;}catch{}
  // Legacy releases acknowledged the raw extraction shape. Keep compatibility
  // while moving comparisons to stable semantic values (including item order).
  const legacy={};
  for(const field of READ_FIELDS)legacy[field]=field==='plate'?invoicePlateKey(data[field]):/Amount$/.test(field)?ServiceModel.cents(data[field]):data[field]??null;
  const legacyFingerprint=protectedData?await sha256(stableReviewJson(legacy)):'';
  let acknowledged=fingerprint===previous.acknowledgedReadCanonicalFingerprint||legacyFingerprint===previous.acknowledgedReadFingerprint;
  if(protectedData&&!acknowledged&&!acceptedFields&&!previous.acknowledgedReadCanonicalFingerprint&&previous.rawText){
    const oldProof=parseInvoiceText(previous.rawText);
    // This migration is permitted only with independent complete labelled
    // evidence. Intentional manual values remain separate from that evidence.
    if(oldProof.completeTable&&oldProof.data.plate&&oldProof.data.odometerKm&&oldProof.data.invoiceNumber&&oldProof.data.invoiceDate&&['netAmount','vatAmount','totalAmount'].every(f=>oldProof.data[f]!=null))
      {const oldComparison=invoiceReadComparison(oldProof.data,ServiceModel.cents);acceptedFields=await fieldHashes(oldComparison);acknowledged=stableReviewJson(oldComparison)===stableReviewJson(comparison);}
  }
  if (protectedData) {
    if(!acceptedFields)acceptedFields=acknowledged?readFields:await fieldHashes(invoiceReadComparison(previous,ServiceModel.cents));
    const issues = [];
    if (!readError && !acknowledged) for (const field of READ_FIELDS) {
      const fresh = data[field];
      if (fresh !== undefined && readFields[field]!==acceptedFields[field]) issues.push({field,code:'new-extraction-difference',message:'Η νέα ανάγνωση διαφέρει από την προηγούμενη απόφαση στο πεδίο '+field+'. Η προηγούμενη τιμή διατηρήθηκε.'});
    }
    // Keep all business values and explicit resolutions, including intentional
    // omissions. Only evidence/status for this attempt may be refreshed.
    const preserved = {...previous,reviewDocumentKey:attachment.key,lastReadFingerprint:fingerprint,lastReadCanonicalFingerprint:fingerprint,lastReadFields:JSON.stringify(readFields),reviewIssues:readError?(previous.reviewIssues||[]):issues};
    if(acceptedFields)preserved.acknowledgedReadFields=JSON.stringify(acceptedFields);
    if (previous.confirmedAt) preserved.confirmationMethod=previous.confirmationMethod||'manual';
    for(const field of ['rawText','fieldEvidence','analysisEngine','analysisVersion','analysisCacheHit','analysisDurationMs','analysisTimings','extractionChecks','ocrSource','ocrFallbackUsed','ocrFallbackReason','ocrFallbackError','localReadStatus','localReadAt','ocrConfidence']) if(data[field]!==undefined)preserved[field]=data[field];
    return {data:preserved,automatic:false,preserved:true};
  }
  const decision=evaluateInvoiceConfirmation(data,{bike,entry,bikes:names,previous,readError,proof});
  if (decision.eligible) {
    const duplicates=await invoiceDuplicates(env,{qrUrl:attachment.qrUrl||data.qrUrl||'',supplier:data.supplier||'',invoiceNumber:data.invoiceNumber||'',excludeKey:attachment.key});
    if(duplicates.length) {decision.eligible=false;decision.reasons.push({field:'invoiceNumber',code:'duplicate-invoice',message:'Το ίδιο παραστατικό είναι ήδη συνδεδεμένο με άλλη καταχώρηση. Χρειάζεται έλεγχος.'});}
  }
  const tasks=mergeInvoiceTasks(entry.tasks,invoiceWorkItems(data),5121),tasksFit=tasks.length<=5120;
  if(!tasksFit){decision.eligible=false;decision.reasons.push({field:'lineItems',code:'service-task-limit',message:'Το service υπερβαίνει τις 5.120 εργασίες. Όλες οι γραμμές διατηρούνται στο παραστατικό· οι προηγούμενες εργασίες δεν αντικαταστάθηκαν.'});}
  const result={...data,reviewDocumentKey:attachment.key,lastReadFingerprint:fingerprint,lastReadCanonicalFingerprint:fingerprint,lastReadFields:JSON.stringify(readFields),reviewIssues:decision.reasons,ocrConfidence:String(decision.score),confirmationRuleVersion:decision.version};
  delete result.confirmedAt;delete result.reviewedBy;delete result.confirmationMethod;delete result.confirmationReason;
  if(decision.eligible)Object.assign(result,{confirmedAt:now,reviewedBy:'Fleet Control · αυτόματος έλεγχος',reviewStatus:'confirmed',confirmationMethod:'automatic',confirmationReason:'Μοναδική πινακίδα, συμφωνία χιλιομέτρων, σαφής αριθμός/ημερομηνία, πλήρης πίνακας και συμφωνία καθαρής αξίας + ΦΠΑ = συνόλου.'});
  else result.reviewStatus='needs_review';
  return {data:result,automatic:decision.eligible,preserved:false,tasks:tasksFit?tasks:null};
}

async function applyServiceDocumentReprocess(env, request, actor, snapshot, fleet, originalBike, originalEntry, originalAttachment, previous, extracted, ocrWarning, options = {}) {
  const proof=parseInvoiceText(extracted?.rawText);
  const names=await fleetNames(env),owner=actor||{id:'android-server',role:'system'};
  const requestId=options.analysisId?'analysis-'+options.analysisId:options.jobId?'analysis-'+options.jobId:crypto.randomUUID();
  const hash=await sha256(stableReviewJson(options.analysisId?{key:originalAttachment.key,analysisId:options.analysisId}:{key:originalAttachment.key,extracted,ocrWarning,jobId:options.jobId||''}));
  const receipt=await readReviewReceipt(env,owner,requestId,hash);
  if(receipt&&!receipt.conflict)return receipt;
  for(let attempt=0;attempt<5;attempt++){
    const located=await readServiceEntry(env,originalBike.id,originalEntry.id),entry=located?.entry,bike=located?.bike;
    const attachment=entry?.attachments?.find(item=>String(item.key)===String(originalAttachment.key));
    if(!attachment)throw new Error('Το τιμολόγιο διαγράφηκε κατά την ανάγνωση.');
    if(options.jobId&&attachment.renderJobId===options.jobId)return {document:adminServiceDocumentRecord(bike,entry,attachment),version:located.version,reused:true};
    if(options.jobId&&await renderJobCancelled(env,options.jobId))throw new Error('Η προσπάθεια διακόπηκε.');
    const current=invoiceDataForServiceDocument(entry,attachment),before=reviewBusinessState(entry),revisionBefore=await invoiceReviewRevision(entry,attachment);
    const fresh=refineInvoicePlateForFleet(normalizeServiceDocumentOcr(enrichInvoiceExtraction({...extracted,qrUrl:attachment.qrUrl||current.qrUrl||'',source:extracted?.source||current.source||options.source||'reprocessed'},proof))||{},names);
    const confirmed=Boolean(current.confirmedAt||current.reviewStatus==='confirmed');
    // An unavailable reader may update error/evidence metadata only. It must
    // not perform the old retroactive cleanup of service tasks/notes/workshop.
    const outcome=ocrWarning?{data:{...current},automatic:false,preserved:confirmed}:await decideInvoiceRead(env,bike,entry,attachment,fresh,names,current,'',proof);
    const data=outcome.data;
    for(const field of ['qrJobId','qrProcessingStatus','qrProcessingStartedAt','qrProcessingUpdatedAt','qrProcessingAttempts','qrProcessingProgress','qrProcessingStage','reviewSeenAt'])if(!data[field]&&current[field])data[field]=current[field];
    const now=new Date().toISOString();data.ocrReprocessedAt=now;
    for(const field of ['ocrSource','ocrFallbackUsed','ocrFallbackReason','ocrFallbackError','localReadStatus','localReadAt','ocrConfidence'])if(fresh[field]!==undefined)data[field]=fresh[field];
    if(ocrWarning)data.ocrFallbackError=cleanText(ocrWarning,500);
    else {
      delete data.ocrFallbackError;delete data.qrProcessingError;
      if(fresh.ocrFallbackUsed==='false')delete data.ocrFallbackReason;
      Object.assign(data,{qrProcessingStatus:'completed',qrProcessingProgress:'100',qrProcessingStage:'Ολοκληρώθηκε',qrProcessingUpdatedAt:now});
    }
    data.reviewStatus=data.reviewStatus||current.reviewStatus||'';
    if(current.confirmedAt)data.confirmedAt=current.confirmedAt;
    if(current.reviewedBy)data.reviewedBy=current.reviewedBy;
    attachment.ocr=normalizeServiceDocumentOcr(data);attachment.ocrError=cleanText(ocrWarning,500);
    if(options.jobId){
      attachment.renderJobId=options.jobId;Object.assign(attachment.ocr,{qrJobId:options.jobId,qrProcessingStatus:ocrWarning?'error':'completed',qrProcessingProgress:ocrWarning?'0':'100',qrProcessingStage:ocrWarning?'Η ανάγνωση δεν ολοκληρώθηκε':'Ολοκληρώθηκε'});
      if(ocrWarning)attachment.ocr.qrProcessingError=cleanText(ocrWarning,500);else delete attachment.ocr.qrProcessingError;
    }
    if(!ocrWarning&&!outcome.preserved){
      attachment.name=uniqueInvoiceDisplayName(buildInvoiceDisplayName(bike.name,data.invoiceDate,entry.date,attachment.name),entry.attachments,attachment.key);
      const tasks=outcome.tasks;
      if(tasks&&stableReviewJson(tasks)!==stableReviewJson(entry.tasks)){const notesWereTasks=!entry.notes||entry.notes===entry.tasks.join('\n');entry.tasks=tasks;if(notesWereTasks)entry.notes=tasks.join('\n');}
      if(attachment.ocr.supplier&&attachment.ocr.supplier!==current.supplier&&(!entry.workshop||entry.workshop===current.supplier))entry.workshop=attachment.ocr.supplier;
    }
    if(!ocrWarning)entry.invoiceData=attachment.ocr;
    if(outcome.automatic)ServiceModel.decision(entry,attachment.key,ServiceModel.state(JSON.parse(located.entryJson),current),attachment.ocr,'Αυτόματος έλεγχος · '+INVOICE_RULES_VERSION,now,false);
    const serviceChanged=stableReviewJson(reviewBusinessState(entry))!==stableReviewJson(before);
    const revisionAfter=await invoiceReviewRevision(entry,attachment),contentChanged=revisionBefore!==revisionAfter;
    if(contentChanged)entry.updatedAt=now;
    const normalized=normalizeHistory([entry])[0],storedFile=normalized.attachments.find(item=>item.key===attachment.key);
    const document=adminServiceDocumentRecord(bike,normalized,storedFile,null,[],true);document.reviewRevision=revisionAfter;
    const result={automaticConfirmed:outcome.automatic,confirmedPreserved:confirmed,ocrWarning:cleanText(ocrWarning,500),serviceChanged,document,warnings:document.warnings};
    const saved=await commitInvoiceReview(env,{actor:owner,requestId,hash,updates:[{located,entry:normalized,bikePatch:contentChanged?{updatedAt:now}:{}}],result,now,changed:true,
      source:options.source||'admin-service-document-reprocess',syncBike:!ocrWarning,renderJobId:options.jobId||'',autoConfirmation:outcome.automatic?{...attachment.ocr,key:attachment.key,qrUrl:attachment.qrUrl||''}:null,
      audit:options.audit===false?false:{action:ocrWarning?'service_document_read_failed':'service_document_reprocessed',before:{bikeId:bike.id,entryId:entry.id,invoiceData:ServiceModel.state(JSON.parse(located.entryJson),current).invoiceData},after:{bikeId:bike.id,entryId:entry.id,serviceChanged,invoiceData:ServiceModel.state(normalized,attachment.ocr).invoiceData,error:cleanText(ocrWarning,500)},reason:options.auditLabel||'Νέα ανάγνωση τιμολογίου',ip:request.headers.get('CF-Connecting-IP')||''}});
    if(!saved)continue;
    if(saved.conflict)throw new Error('Η εργασία ανάγνωσης έχει ήδη διαφορετικό αποτέλεσμα.');
    if(options.jobId&&!ocrWarning)await resolveServiceDocumentFailure(env,options.jobId);
    return saved;
  }
  throw new Error('Το service ενημερώθηκε ταυτόχρονα. Δοκίμασε ξανά την ανάγνωση.');
}

async function reprocessAdminServiceDocument(request, env) {
  let actor;
  try { actor = await serverAuthorized(request,env) ? {id:"android-server",username:"android-server",role:"owner"} : await authenticateExternal(request, env, "fleet.manage"); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Η επανεπεξεργασία τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);

  const body = await request.json().catch(() => ({}));
  const key = cleanText(body.key, 500);
  const forceAi = body.forceAi === true || body.forceAI === true || String(body.forceAi || body.forceAI || "").toLowerCase() === "true";
  const aiRequestReason = forceAi
    ? "Ζητήθηκε χειροκίνητα από τον διαχειριστή."
    : "Ζητήθηκε νέα ανάγνωση με Workers AI.";
  if (!isServiceDocumentKey(key)) return json({ error: "Λείπει η σύνδεση με το τιμολόγιο." }, 400);
  if(!forceAi&&await localAnalysisAvailable(env))return queueStoredAnalysis(env,key,body);
  if(forceAi)await env.DB.prepare("UPDATE fleet_operations SET status='cancelled',applied_at=? WHERE type='service_document_render' AND status='pending' AND json_extract(payload,'$.documentKey')=?").bind(new Date().toISOString(),key).run();
  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);

  const located = await readServiceDocument(env, key);
  if (!located || located.entry.type === "check") return json({ error: "Το τιμολόγιο δεν βρέθηκε." }, 404);
  const bike = located.bike;
  const entry = located.entry;
  const attachment = entry.attachments.find(item => String(item.key) === key);
  const fleet = { bikes: await fleetNames(env) };
  const snapshot = { version: located.version };
  const object = await bucket.get(key);
  if (!object) return json({ error: "Το αρχείο του τιμολογίου δεν βρέθηκε στο R2." }, 404);
  const type = documentContentType(object.httpMetadata?.contentType || "", attachment.name || key);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const current = invoiceDataForServiceDocument(entry, attachment);
  let extracted = null;
  let ocrWarning = "";
  try {
    if (!env.AI) throw new Error("Το OCR/AI δεν έχει ενεργοποιηθεί στον Worker.");
    extracted = await extractStoredInvoiceOcr(env, bytes, type, attachment.name || key, forceAi);
    extracted = normalizeServiceDocumentOcr({
      ...extracted,
      source: "cloudflare-ai",
      ocrSource: "cloudflare-ai",
      ocrFallbackUsed: true,
      ocrFallbackReason: aiRequestReason,
      ocrFallbackError: ""
    });
  } catch (error) {
    // Failed extraction records the error without applying service changes.
    ocrWarning = error?.message || "Δεν ολοκληρώθηκε η νέα ανάγνωση του τιμολογίου.";
    extracted = normalizeServiceDocumentOcr({
      ...current,
      source: "cloudflare-ai",
      ocrSource: "cloudflare-ai",
      ocrFallbackUsed: true,
      ocrFallbackReason: aiRequestReason,
      ocrFallbackError: ocrWarning
    });
  }

  const outcome = await applyServiceDocumentReprocess(env, request, actor, snapshot, fleet, bike, entry, attachment, current, extracted, ocrWarning, {
    source: "admin-service-document-reprocess",
    auditLabel: forceAi ? "Χειροκίνητη ανάγνωση τιμολογίου με Workers AI" : "Νέα ανάγνωση και καθαρισμός παλιού τιμολογίου με Workers AI"
  });
  return json({
    ok: true,
    key,
    ...outcome
  });
}

async function invoiceReprocessBatch(request, env) {
  const permission = request.method === "GET" ? "fleet.view" : "fleet.manage";
  let actor;
  try { actor = await authenticateExternal(request, env, permission); }
  catch (error) { return json({ error: error?.message || "Χρειάζεται σύνδεση διαχείρισης." }, Number(error?.status) || 401); }
  if (!actor) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);

  const current = await readInvoiceReprocessBatch(env);
  const now = new Date().toISOString();
  const nowMs = Date.now();
  if (request.method === "GET") {
    let batch = current;
    if (batch && batch.status === "processing" && nowMs - invoiceBatchTime(batch.updatedAt) > INVOICE_REPROCESS_BATCH_STALE_MS) {
      batch = {
        ...batch,
        status: "error",
        error: "Δεν ελήφθη ενημέρωση από τη σύνδεση που ξεκίνησε τη διαδικασία.",
        completedAt: now,
        updatedAt: now
      };
      if(!await saveInvoiceReprocessBatch(env,batch,current))batch=await readInvoiceReprocessBatch(env);
    }
    if (batch && !["processing","paused"].includes(batch.status) && nowMs - invoiceBatchTime(batch.completedAt) > INVOICE_REPROCESS_BATCH_RESULT_TTL_MS) batch = null;
    return json({ ok: true, batch });
  }

  const body = await request.json().catch(() => ({}));
  const action = cleanText(body.action, 30).toLowerCase();
  if (action === "start") {
    const mode = body.mode || "server-first";
    if (!["server-first", "workers-ai"].includes(mode)) return json({ error: "Μη έγκυρος τρόπος ανάγνωσης." }, 400);
    if (current && (current.status === "paused" || current.status === "processing" && nowMs - invoiceBatchTime(current.updatedAt) <= INVOICE_REPROCESS_BATCH_STALE_MS)) {
      return json({ ok: true, started: false, owner: false, batch: current });
    }
    if (Array.isArray(body.items) && body.items.length>5000) return json({error:'Η εργασία δέχεται έως 5.000 τιμολόγια. Δεν ξεκίνησε μερική λίστα.'},400);
    const submitted = (Array.isArray(body.items) ? body.items : []).map((item) => ({
      id: cleanText(item?.id, 160),
      key: cleanText(item?.key, 500),
      name: cleanText(item?.name, 240), forceRead:body.forceRead===true
    })).filter((item) => isServiceDocumentKey(item.key));
    const seenKeys=new Set(),items=body.recovery===true?recoveryItems(Array.isArray(body.items)?body.items:[],cleanText,isServiceDocumentKey):submitted.filter(item=>{if(seenKeys.has(item.key))return false;seenKeys.add(item.key);return true;});
    if(body.recovery===true&&items.length!==(Array.isArray(body.items)?new Set(body.items.map(i=>i.key||JSON.stringify([i.bikeId,i.entryId,i.jobId||i.qrUrl]))).size:0))return json({error:'Η λίστα περιλαμβάνει μη έγκυρη πηγή. Δεν ξεκίνησε μερική επανάληψη.'},400);
    if(body.recovery===true&&(!items.length||new TextEncoder().encode(JSON.stringify(items)).length>500000))return json({error:'Η λίστα είναι κενή ή πολύ μεγάλη. Επίλεξε μικρότερη περίοδο ή πινακίδα· δεν αποθηκεύτηκε μερική λίστα.'},400);
    const total = items.length || cleanInteger(body.total, 1, 5000, 0);
    if (!total) return json({ error: "Δεν υπάρχουν τιμολόγια για νέα ανάγνωση." }, 400);
    const batch = {
      id: cleanText(body.batchId, 120) || crypto.randomUUID(),
      status: "processing",
      mode,
      recovery:body.recovery===true,results:[],queued:0,
      total,
      items,
      completed: 0,
      failed: 0,
      automaticConfirmed: 0, needsReview: 0, confirmedPreserved: 0,
      currentIndex: 0,
      currentName: "Προετοιμασία…",
      currentStartedAt: now,
      progress: 0,
      startedAt: now,
      updatedAt: now,
      completedAt: "",
      error: "",
      startedBy: cleanText(actor.fullName || actor.username || actor.id, 120)
    };
    // The Android Server owns the actual PDF reading. It processes one item
    // per sync cycle, so every connected portal can watch the same D1 state.
    const saved=await saveInvoiceReprocessBatch(env,batch,current,true);
    if(!saved)return json({ok:true,started:false,owner:false,batch:await readInvoiceReprocessBatch(env)});
    return json({ ok: true, started: true, owner: true, batch }, 201);
  }

  const batchId = cleanText(body.batchId, 120);
  if (!batchId || !current || String(current.id) !== batchId) return json({ error: "Η κοινή εργασία επανεπεξεργασίας δεν βρέθηκε ή ολοκληρώθηκε." }, 409);
  if(action==='pause'||action==='resume'){
    if(Number(current.completed)>=Number(current.total))return json({error:'Η εργασία έχει ολοκληρωθεί.'},409);
    const next={...current,status:action==='pause'?'paused':'processing',updatedAt:now,error:'',completedAt:''};
    if(!await saveInvoiceReprocessBatch(env,next,current,action==='resume'))return json({error:'Η εργασία άλλαξε ταυτόχρονα. Ανανέωσε την πρόοδο.',batch:await readInvoiceReprocessBatch(env)},409);
    return json({ok:true,batch:next});
  }
  if (current.status !== "processing") return json({ ok: true, batch: current, ignored: true });

  const total = Math.max(1, Number(current.total) || 1);
  const completed = Math.max(Number(current.completed) || 0, Math.min(total, cleanInteger(body.completed, 0, total, Number(current.completed) || 0)));
  const failed = Math.max(Number(current.failed) || 0, Math.min(total, cleanInteger(body.failed, 0, total, Number(current.failed) || 0)));
  const currentIndex = Math.max(0, Math.min(total, cleanInteger(body.currentIndex, 0, total, Number(current.currentIndex) || 0)));
  const progress = Math.max(0, Math.min(99, Number.isFinite(Number(body.progress)) ? Math.round(Number(body.progress)) : Math.round((completed / total) * 100)));
  const update = {
    ...current,
    completed,
    failed,
    currentIndex,
    currentName: cleanText(body.currentName, 240) || current.currentName || "Επεξεργασία τιμολογίου",
    currentStartedAt: cleanText(body.currentStartedAt, 40) || current.currentStartedAt || now,
    progress,
    updatedAt: now,
    error: cleanText(body.error, 500) || ""
  };
  if (action === "complete") {
    update.completed = total;
    update.progress = 100;
    update.status = failed > 0 ? "completed_with_errors" : "completed";
    update.completedAt = now;
  } else if (action === "error") {
    update.status = "error";
    update.error = cleanText(body.error, 500) || "Η νέα ανάγνωση σταμάτησε απρόσμενα.";
    update.completedAt = now;
  } else if (action !== "update") {
    return json({ error: "Μη έγκυρη ενέργεια batch." }, 400);
  }
  if(!await saveInvoiceReprocessBatch(env,update,current))return json({error:'Η εργασία άλλαξε ταυτόχρονα.',batch:await readInvoiceReprocessBatch(env)},409);
  return json({ ok: true, batch: update });
}

async function readInvoiceReprocessBatch(env) {
  const raw = await getSetting(env, INVOICE_REPROCESS_BATCH_SETTING);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    Object.defineProperty(value,'_storedValue',{value:raw,enumerable:false});
    return value;
  } catch {
    return null;
  }
}

async function saveInvoiceReprocessBatch(env,next,previous,queueOperation=false) {
  next.revision=crypto.randomUUID();
  const value=JSON.stringify(next),expected=previous?previous._storedValue||JSON.stringify(previous):null,now=new Date().toISOString();
  const statements=[env.DB.prepare(`INSERT INTO fleet_settings(key,value,updated_at)
    SELECT ?,?,? WHERE (?=1 OR NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key=?))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE fleet_settings.value=?`)
    .bind(INVOICE_REPROCESS_BATCH_SETTING,value,now,previous?1:0,INVOICE_REPROCESS_BATCH_SETTING,expected)];
  if(queueOperation){
    const guard="EXISTS(SELECT 1 FROM fleet_settings WHERE key=? AND value=?)";
    statements.push(env.DB.prepare("UPDATE fleet_operations SET status='cancelled' WHERE type='service_document_reprocess_batch' AND status='pending' AND "+guard).bind(INVOICE_REPROCESS_BATCH_SETTING,value));
    statements.push(env.DB.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) SELECT ?,'invoice-reader','service_document_reprocess_batch',?,'pending',? WHERE "+guard)
      .bind('invoice-reprocess-'+next.id+'-'+next.revision,JSON.stringify({batchId:next.id}),now,INVOICE_REPROCESS_BATCH_SETTING,value));
  }
  const results=await env.DB.batch(statements);
  return Number(results[0].meta?.changes||0)>0;
}

// A document can be deleted while the Android Server is processing the
// shared reprocess queue. Remove it from that queue immediately so the next
// poll never waits for a key that no longer exists. Deletion is intentional,
// therefore it is counted as skipped rather than failed.
async function skipDeletedInvoiceFromBatch(env, key, now = new Date().toISOString()) {
  const current = await readInvoiceReprocessBatch(env);
  if (!key || !current || current.status !== "processing") return current;
  const items = Array.isArray(current.items) ? current.items : [];
  const removedIndex = items.findIndex((item) => String(item?.key || "") === String(key));
  if (removedIndex < 0) return current;

  const oldIndex = Math.max(0, Math.min(items.length, Number(current.currentIndex) || 0));
  const removedBeforeCurrent = removedIndex < oldIndex;
  const nextItems = items.filter((_, index) => index !== removedIndex);
  const nextTotal = nextItems.length;
  const nextIndex = Math.max(0, Math.min(nextTotal, oldIndex - (removedBeforeCurrent ? 1 : 0)));
  const oldCompleted = Math.max(0, Number(current.completed) || 0);
  const nextCompleted = Math.max(0, Math.min(nextTotal, oldCompleted - (removedBeforeCurrent ? 1 : 0)));
  const skipped = Math.max(0, Number(current.skipped) || 0) + 1;
  const next = {
    ...current,
    items: nextItems,
    total: nextTotal,
    completed: nextCompleted,
    currentIndex: nextIndex,
    currentName: nextItems[nextIndex]?.name || "Ολοκληρώθηκε η νέα ανάγνωση",
    progress: nextTotal ? Math.min(99, Math.round((nextCompleted / nextTotal) * 100)) : 100,
    skipped,
    lastSkippedName: String(items[removedIndex]?.name || "Διαγραμμένο τιμολόγιο"),
    updatedAt: now,
    error: ""
  };
  if (!nextTotal || nextIndex >= nextTotal) {
    next.status = "completed";
    next.completed = nextTotal;
    next.currentIndex = nextTotal;
    next.progress = 100;
    next.currentName = "Ολοκληρώθηκε η νέα ανάγνωση";
    next.completedAt = now;
  } else {
    next.status = "processing";
    next.completedAt = "";
  }
  if(!await saveInvoiceReprocessBatch(env,next,current))return readInvoiceReprocessBatch(env);
  return next;
}

function invoiceBatchTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

async function serverInvoiceReprocessBatch(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  let current = await readInvoiceReprocessBatch(env);
  const initiallyRead = current;
  await touchServer(env);
  if (request.method === "GET") {
    if (current && current.status === "processing" && Date.now() - invoiceBatchTime(current.updatedAt) > INVOICE_REPROCESS_BATCH_STALE_MS) {
      current = {
        ...current,
        status: "error",
        error: "Δεν ελήφθη ενημέρωση από τον Server που ξεκίνησε τη διαδικασία.",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if(!await saveInvoiceReprocessBatch(env,current,initiallyRead))current=await readInvoiceReprocessBatch(env);
    }
    const batch = current || null;
    const items = Array.isArray(batch?.items) ? batch.items : [];
    const index = Math.max(0, Number(batch?.currentIndex) || 0);
    const requestedWindow = cleanInteger(new URL(request.url).searchParams.get("window"), 1, 10, 1);
    const windowItems = batch && batch.status === "processing"
      ? items.slice(index, Math.min(items.length, index + (batch.recovery?Math.min(2,requestedWindow):requestedWindow)))
      : [];
    const item = windowItems[0] || null;
    return json({
      ok: true,
      batch,
      item,
      items: windowItems,
      complete: Boolean(!batch || (batch.status && batch.status !== "processing"))
    });
  }

  const body = await request.json().catch(() => ({}));
  if(body.action==='pause'){
    if(!current||current.id!==cleanText(body.batchId,120)||current.status!=='processing')return json({error:'Η ουρά άλλαξε ή δεν εκτελείται.'},409);
    const next={...current,status:'paused',updatedAt:new Date().toISOString(),error:cleanText(body.error,500)||'Παύση από τον Server. Η θέση της ουράς διατηρείται.'};
    if(!await saveInvoiceReprocessBatch(env,next,current))return json({error:'Η ουρά άλλαξε ταυτόχρονα.'},409);
    return json({ok:true,batch:next});
  }
  if (body.action === "resume") {
    if (!current || Number(current.completed)>=Number(current.total)) return json({error:"Δεν υπάρχει διακοπείσα εργασία προς συνέχιση."},409);
    const now=new Date().toISOString();
    current={...current,status:"processing",error:"",completedAt:"",updatedAt:now};
    if(!await saveInvoiceReprocessBatch(env,current,initiallyRead,true))return json({error:'Η εργασία άλλαξε ταυτόχρονα.'},409);
    return json({ok:true,resumed:true,batch:current});
  }
  if (cleanText(body.action, 30).toLowerCase() !== "result") return json({ error: "Μη έγκυρη ενέργεια Server batch." }, 400);
  const batchId = cleanText(body.batchId, 120);
  if (!current || current.status !== "processing" || String(current.id) !== batchId) {
    return json({ ok: true, batch: current || null, complete: true, ignored: true });
  }
  const items = Array.isArray(current.items) ? current.items : [];
  const index = Math.max(0, Number(current.currentIndex) || 0);
  const item = items[index];
  if (!item) {
    const completed = { ...current, status: current.failed ? "completed_with_errors" : "completed", completed: Number(current.total) || items.length, progress: 100, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if(!await saveInvoiceReprocessBatch(env,completed,current))return json({ok:true,batch:await readInvoiceReprocessBatch(env),conflict:true});
    return json({ ok: true, batch: completed, complete: true });
  }
  const key = cleanText(body.key, 500);
  if(current.recovery&&!item.key){
    if(Number(body.index)!==index||String(body.id)!==String(item.id))return json({error:'Η θέση της επανάληψης άλλαξε. Ανανέωσε την ουρά.'},409);
    const headers=new Headers(request.headers);headers.delete('Content-Length');
    const retry=new Request(new URL('/api/admin/service-documents/retry-failed',request.url),{method:'POST',headers,body:JSON.stringify({jobId:item.jobId,bikeId:item.bikeId,entryId:item.entryId,qrUrl:item.qrUrl})});
    const response=await retryFailedInvoice(retry,env,{json,authenticateExternal,isManagementActor,readServiceEntry,readServiceDocument,serviceRenderState,jobAttachmentMatches,restartServiceDocument,reprocessAdminServiceDocument,resolveServiceDocumentFailure,digestHex,serverAuthorized});
    const value=await response.json(),failed=!response.ok||!!value.ocrWarning||value.status==='error';
    // A racing submit has no confirmed queue receipt. Keep the current item;
    // the native durable work queue backs off and re-reads before retrying.
    if(value.busy)return json({error:'Η ίδια επανάληψη υποβάλλεται ήδη. Η ουρά διατηρείται.'},409);
    const next=recoveryResult(current,item,index,{failed,queued:!!value.queued||value.status==='processing',skipped:!!value.skipped,error:failed?(value.error||value.ocrWarning||'Η επανάληψη απέτυχε.'):'',document:value.document},new Date().toISOString());
    if(!await saveInvoiceReprocessBatch(env,next,current))return json({ok:true,conflict:true,batch:await readInvoiceReprocessBatch(env)});
    return json({ok:true,batch:next,complete:next.status!=='processing',failed,queued:!!value.queued||value.status==='processing',skipped:!!value.skipped});
  }
  if (!isServiceDocumentKey(key) || key !== String(item.key)) return json({ error: "Το αποτέλεσμα δεν αντιστοιχεί στο τρέχον τιμολόγιο." }, 409);

  const located = await readServiceDocument(env, key);
  const bike = located?.bike;
  const entry = located?.entry;
  const attachment = entry?.attachments?.find(candidate => String(candidate.key) === key);
  const snapshot = { version: located?.version || 0 };
  const fleet = { bikes: [] };

  let failed = false;
  let skipped = false;
  let fallbackUsed = false;
  const forceWorkersAi = current.mode === "workers-ai";
  let aiUsed = false;
  let ocrWarning = "";
  let confirmationOutcome = null;
  if (bike && entry && attachment && entry.type !== "check") {
    const local = normalizeServiceDocumentOcr(body.localOcr);
    const localStatus = String(local?.localReadStatus || "").toLowerCase();
    const localConfidence = cleanInteger(local?.ocrConfidence, 0, 100, 0);
    const localConfident = Boolean(local && (localStatus === "confident" || (!localStatus && localConfidence >= 70 && invoiceWorkItems(local).length > 0)));
    let extracted = !forceWorkersAi && localConfident ? normalizeServiceDocumentOcr({
      ...local,
      source: "server-local",
      ocrSource: "server-local",
      ocrFallbackUsed: false,
      ocrFallbackReason: "",
      ocrFallbackError: ""
    }) : null;
    const fallbackReason = forceWorkersAi ? "Επιλέχθηκε υποχρεωτική ανάγνωση με Workers AI."
      : local?.ocrFallbackReason || (local ? "Η τοπική ανάγνωση βρήκε αμφίβολα στοιχεία." : "Η τοπική ανάγνωση του Server απέτυχε.");
    if (!extracted) {
      fallbackUsed = !forceWorkersAi;
      aiUsed = true;
      try {
        const bucket = env.SERVICE_DOCS || env.RELEASES;
        const object = await bucket?.get(key);
        if (!object) throw new Error("Το PDF του τιμολογίου δεν βρέθηκε στο R2.");
        const storedType = documentContentType(object.httpMetadata?.contentType || attachment.contentType || "", attachment.name || key);
        const aiStarted=performanceNow();
        extracted = aiInvoiceAnalysis(await extractStoredInvoiceOcr(env, new Uint8Array(await object.arrayBuffer()), storedType, attachment.name || key, forceWorkersAi),local,performanceNow()-aiStarted);
        extracted = normalizeServiceDocumentOcr({
          ...extracted,
          ocrSource: "cloudflare-ai",
          ocrFallbackUsed: fallbackUsed,
          ocrFallbackReason: fallbackReason,
          ocrFallbackError: "",
          localReadStatus: localStatus || "failed"
        });
      } catch (error) {
        failed = true;
        ocrWarning = error?.message || "Δεν ολοκληρώθηκε η ανάγνωση με Workers AI.";
        extracted = normalizeServiceDocumentOcr({
          ...(forceWorkersAi ? {} : local || {}),
          ocrSource: forceWorkersAi ? "cloudflare-ai" : "server-local",
          ocrFallbackUsed: fallbackUsed,
          ocrFallbackReason: fallbackReason,
          ocrFallbackError: ocrWarning
        });
      }
    }
    const currentData = invoiceDataForServiceDocument(entry, attachment);
    confirmationOutcome = await applyServiceDocumentReprocess(env, request, { id: "android-server", username: "android-server", role: "owner" }, snapshot, fleet, bike, entry, attachment, currentData, extracted, ocrWarning, {
      source: "server-service-document-reprocess",
      analysisId:'batch-'+current.id+'-'+index,
      audit: false,
      auditLabel: "Server τοπική ανάγνωση τιμολογίου"
    });
  } else {
    // The PDF may have been deleted after the Server fetched the queue. It
    // is a deliberate skip, not an OCR failure and must not leave the batch
    // stuck or mark it as completed_with_errors.
    skipped = true;
  }

  const now = new Date().toISOString();
  const total = Math.max(1, Number(current.total) || items.length || 1);
  const nextIndex = Math.min(total, index + 1);
  const nextCompleted = Math.max(Number(current.completed) || 0, nextIndex);
  const nextFailed = Math.min(total, Math.max(Number(current.failed) || 0, Number(current.failed) || 0) + (failed ? 1 : 0));
  const next = {
    ...current,
    completed: nextCompleted,
    failed: nextFailed,
    automaticConfirmed: (Number(current.automaticConfirmed)||0) + (!failed&&!skipped&&confirmationOutcome?.document?.status==='confirmed'&&confirmationOutcome.document.invoiceData?.confirmationMethod==='automatic'?1:0),
    confirmedPreserved: (Number(current.confirmedPreserved)||0) + (!failed&&!skipped&&confirmationOutcome?.document?.status==='confirmed'&&confirmationOutcome.document.invoiceData?.confirmationMethod!=='automatic'?1:0),
    needsReview: (Number(current.needsReview)||0) + (!failed&&!skipped&&confirmationOutcome?.document?.status!=='confirmed'?1:0),
    fallbackCount: Math.max(Number(current.fallbackCount) || 0, Number(current.fallbackCount) || 0) + (fallbackUsed ? 1 : 0),
    aiCount: Math.max(0, Number(current.aiCount) || 0) + (aiUsed ? 1 : 0),
    skipped: Math.max(Number(current.skipped) || 0, Number(current.skipped) || 0) + (skipped ? 1 : 0),
    currentIndex: nextIndex,
    currentName: nextIndex < items.length ? String(items[nextIndex]?.name || "Επόμενο τιμολόγιο") : "Ολοκληρώθηκε η νέα ανάγνωση",
    currentStartedAt: now,
    progress: nextIndex >= total ? 100 : Math.min(99, Math.round((nextIndex / total) * 100)),
    updatedAt: now,
    error: ocrWarning || ""
  };
  if (nextIndex >= total) {
    next.status = nextFailed > 0 ? "completed_with_errors" : "completed";
    next.completedAt = now;
  }
  if(current.recovery)next.results=(current.results||[]).concat({id:item.id,key:item.key,name:item.name,status:failed?'error':skipped?'skipped':confirmationOutcome?.document?.status==='confirmed'?'confirmed':'needs_review',error:ocrWarning||''});
  // A delete can finish while the Server is reading the PDF. Re-check the
  // queue before committing the result so a late response cannot reinsert a
  // deleted item or overwrite the queue position chosen by the delete path.
  const latest = await readInvoiceReprocessBatch(env);
  const latestItems = Array.isArray(latest?.items) ? latest.items : [];
  const queueChanged = !latest || latest.status !== "processing"
    || String(latest.id || "") !== String(current.id || "")
    || Number(latest.currentIndex) !== index
    || String(latestItems[index]?.key || "") !== key;
  if (queueChanged) {
    return json({
      ok: true,
      batch: latest || null,
      complete: Boolean(!latest || latest.status !== "processing"),
      skipped,
      failed,
      conflict: true,
      error: ocrWarning
    });
  }
  if(!await saveInvoiceReprocessBatch(env,next,current))return json({ok:true,batch:await readInvoiceReprocessBatch(env),conflict:true});
  return json({ ok: true, batch: next, complete: next.status !== "processing", fallbackUsed, aiUsed, skipped, failed, error: ocrWarning });
}

async function extractStoredInvoiceOcr(env, bytes, type, filename, forceAi = false) {
  if (type === "application/pdf") {
    if (!env.AI?.toMarkdown) throw new Error("Η ανάγνωση PDF δεν είναι διαθέσιμη στον Worker.");
    const converted = await env.AI.toMarkdown({
      name: filename || "invoice.pdf",
      blob: new Blob([bytes], { type: "application/pdf" })
    });
    const result = Array.isArray(converted) ? converted[0] : converted;
    if (!result || result.format === "error" || !result.data) throw new Error("Δεν ολοκληρώθηκε η ανάγνωση του PDF.");
    return extractInvoiceFromText(env, String(result.data), "reprocessed-pdf", forceAi);
  }
  if (type.startsWith("image/")) {
    if (["image/heic", "image/heif"].includes(type)) throw new Error("Η φωτογραφία είναι HEIC/HEIF και δεν μπορεί να διαβαστεί από το OCR.");
    return extractInvoiceFromImage(env, bytes, type);
  }
  throw new Error("Το αρχείο του τιμολογίου δεν είναι υποστηριζόμενο PDF ή εικόνα.");
}

function reviewBusinessState(entry) {
  return { ...ServiceModel.state(entry, {}), id:entry.id, type:entry.type, date:entry.date, cost:entry.cost || '' };
}

async function invoiceReviewRevision(entry, attachment) {
  const current = invoiceDataForServiceDocument(entry,attachment), data = {};
  for (const field of ['supplier','invoiceNumber','invoiceDate','plate','odometerKm','totalAmount','netAmount','vatAmount','workPerformed','comments','lineItems','parts',
    'plateResolution','plateResolutionBikeId','plateResolutionPlate','plateResolutionRead','mileageResolution','mileageResolutionEntryId','mileageResolutionRead','mileageResolutionServiceKm','lastReadFingerprint','lastReadCanonicalFingerprint','lastReadFields','reviewIssues','reviewDocumentKey']) {
    if (current[field] !== undefined) data[field] = current[field];
  }
  return sha256(stableReviewJson({entry:reviewBusinessState(entry),key:attachment.key,data}));
}

async function invoiceReviewResponse(env, body, result) {
  if (result.conflict) return json({error:'Ο κωδικός αυτής της αποστολής χρησιμοποιήθηκε με διαφορετικές διορθώσεις. Άνοιξε ξανά τον έλεγχο.',code:'review_request_conflict'},409);
  if (body.compactResponse === true) return json(result);
  // Older clients still receive their bike field. Only that bike is loaded.
  const located = await readSnapshotBike(env,String(result.document.bikeId));
  const entry=located?.bike.history?.find(item=>String(item.id)===String(result.document.entryId)),file=entry?.attachments?.find(item=>item.key===result.document.key);
  const document=entry&&file?adminServiceDocumentRecord(located.bike,entry,file):result.document;
  if(entry&&file)document.reviewRevision=await invoiceReviewRevision(entry,file);
  return json({...result,document,bike:located?.bike || null});
}

async function reviewAdminServiceDocument(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, 'fleet.manage'); }
  catch (error) { return json({error:error?.message || 'Χρειάζεται σύνδεση διαχείρισης.'},Number(error?.status)||401); }
  if (!isManagementActor(actor)) return json({error:'Η επιβεβαίωση τιμολογίου επιτρέπεται μόνο σε λογαριασμό διαχείρισης.'},403);
  const body = await request.json().catch(()=>({})),bikeId=cleanText(body.bikeId,100),entryId=cleanText(body.entryId,100),key=cleanText(body.key,500);
  if (!bikeId || !entryId || !isServiceDocumentKey(key)) return json({error:'Λείπει η σύνδεση με το τιμολόγιο.'},400);
  if (body.requestId !== undefined && !/^[a-zA-Z0-9_-]{16,100}$/.test(String(body.requestId))) return json({error:'Μη έγκυρος κωδικός αποθήκευσης.'},400);
  if (body.expectedReviewRevision !== undefined && !/^[a-f0-9]{64}$/.test(String(body.expectedReviewRevision))) return json({error:'Μη έγκυρη έκδοση ελέγχου.'},400);
  const requestId=body.requestId || crypto.randomUUID(),hash=await sha256(stableReviewJson(body));
  const receipt=await readReviewReceipt(env,actor,requestId,hash);
  if (receipt) return invoiceReviewResponse(env,body,receipt);
  const shouldMove=!body.keepOnCurrent && body.moveToBikeId && body.moveToEntryId;
  const targetBikeId=shouldMove?cleanText(body.moveToBikeId,100):bikeId,targetEntryId=shouldMove?cleanText(body.moveToEntryId,100):entryId;
  if (shouldMove && targetBikeId===bikeId && targetEntryId===entryId) return json({error:'Το τιμολόγιο είναι ήδη συνδεδεμένο με αυτό το service.'},400);
  for (let attempt=0;attempt<5;attempt++) {
    const located=await readServiceEntry(env,bikeId,entryId),entry=located?.entry;
    const attachment=entry?.attachments?.find(item=>String(item.key)===key);
    if (!entry || entry.type==='check' || !attachment) return json({error:'Το τιμολόγιο ή το service δεν βρέθηκε.'},404);
    const destination=shouldMove?await readServiceEntry(env,targetBikeId,targetEntryId):located,target=destination?.entry;
    if (!target || target.type==='check') return json({error:'Το service προορισμού δεν βρέθηκε.'},404);
    if (shouldMove && target.attachments.filter(item=>item.key!==key).length>=MAX_SERVICE_ATTACHMENTS) return json({error:'Το service προορισμού έχει ήδη 10 τιμολόγια. Τα υπάρχοντα αρχεία διατηρούνται.'},409);
    const revision=body.expectedReviewRevision?await invoiceReviewRevision(entry,attachment):null;
    const original=invoiceDataForServiceDocument(entry,attachment),before=ServiceModel.state(entry,original),targetBefore=ServiceModel.state(target,invoiceDataForServiceDocument(target,target.attachments?.at(-1)));
    const sourceBusiness=reviewBusinessState(entry),targetBusiness=reviewBusinessState(target),submitted=body.invoiceData&&typeof body.invoiceData==='object'&&!Array.isArray(body.invoiceData)?body.invoiceData:{};
    const data=mergeServerInvoiceData(original,submitted),now=new Date().toISOString(),name=cleanText(actor.full_name||actor.fullName||actor.username||actor.user_id||'admin',120);
    for (const field of ['supplier','invoiceNumber','invoiceDate','plate','odometerKm','totalAmount','netAmount','vatAmount','workPerformed','comments']) if(Object.hasOwn(submitted,field)) data[field]=cleanText(submitted[field],field==='workPerformed'?MAX_INVOICE_TEXT:2000);
    const tasks=mergeInvoiceTasks(Array.isArray(body.tasks)?body.tasks:entry.tasks,invoiceWorkItems(data));
    if (body.mileageDecision && !['keep','apply'].includes(body.mileageDecision)) return json({error:'Μη έγκυρη επιλογή χιλιομέτρων.'},400);
    if ((body.mileageDecision || body.updateServiceKm===true) && Number(body.expectedServiceKm)!==Number(target.km)) return json({error:'Τα χιλιόμετρα άλλαξαν. Άνοιξε ξανά τον έλεγχο.',code:'review_conflict'},409);
    const invoiceKm=invoiceOdometer(data.odometerKm),kmChanged=body.updateServiceKm===true && invoiceKm!==Number(target.km);
    if (body.updateServiceKm===true && (!invoiceKm || invoiceKm>2000000000)) return json({error:'Γράψε σωστά τα χιλιόμετρα του τιμολογίου.'},400);
    if (kmChanged) {data.serviceKmBeforeCorrection=String(target.km);data.serviceKmAfterCorrection=String(invoiceKm);target.km=invoiceKm;data.correctedByUserAt=now;}
    if (invoiceKm && (body.mileageDecision || body.updateServiceKm===true)) Object.assign(data,{mileageResolution:body.updateServiceKm===true?'apply':'keep',mileageResolutionEntryId:targetEntryId,mileageResolutionRead:String(invoiceKm),mileageResolutionServiceKm:String(target.km)});
    if (body.keepOnCurrent===true && data.plate && invoicePlateKey(data.plate)!==invoicePlateKey(located.bike.name)) Object.assign(data,{plateResolution:'kept-current',plateResolutionBikeId:bikeId,plateResolutionPlate:invoicePlateKey(located.bike.name),plateResolutionRead:invoicePlateKey(data.plate)});
    const meaningful=['plate','odometerKm','totalAmount','netAmount','vatAmount','workPerformed','invoiceDate','supplier','invoiceNumber','comments','lineItems','parts','mileageResolution','mileageResolutionEntryId','mileageResolutionRead','mileageResolutionServiceKm','plateResolution','plateResolutionBikeId','plateResolutionPlate','plateResolutionRead'];
    const contentChanged=meaningful.some(field=>stableReviewJson(data[field]??null)!==stableReviewJson(original[field]??null));
    if (contentChanged) data.correctedByUserAt=now;
    data.confirmedAt=contentChanged?now:original.confirmedAt||now;
    data.reviewedBy=contentChanged?name:original.reviewedBy||name;
    data.reviewDocumentKey=key;data.confirmationMethod='manual';data.confirmationRuleVersion=INVOICE_RULES_VERSION;data.confirmationReason='Επιβεβαίωση από διαχειριστή';delete data.reviewIssues;
    delete data.ocrFallbackError;delete data.qrProcessingError;
    if(original.lastReadFingerprint)data.acknowledgedReadFingerprint=original.lastReadFingerprint;
    if(original.lastReadCanonicalFingerprint)data.acknowledgedReadCanonicalFingerprint=original.lastReadCanonicalFingerprint;
    if(original.lastReadFields)data.acknowledgedReadFields=original.lastReadFields;
    data.reviewStatus='confirmed';data.reviewSeenAt=original.reviewSeenAt||attachment.reviewSeenAt||now;
    let outputFile=attachment;
    if (shouldMove) {
      const remaining=entry.attachments.filter(item=>item.key!==key),otherTasks=remaining.flatMap(item=>invoiceWorkItems(mergeServerInvoiceData(item.qrData,item.ocr)));
      const imported=invoiceWorkItems(data).map(normalizedTaskKey),shared=otherTasks.map(normalizedTaskKey);
      entry.tasks=(entry.tasks||[]).filter(task=>!imported.includes(normalizedTaskKey(task))||shared.includes(normalizedTaskKey(task)));
      if(stableReviewJson(entry.tasks)!==stableReviewJson(sourceBusiness.tasks))entry.notes=entry.tasks.join('\n');
      entry.attachments=remaining;const last=remaining.at(-1);entry.invoiceData=last?mergeServerInvoiceData(last.qrData,last.ocr):null;
      outputFile={...attachment};target.attachments=target.attachments.filter(item=>item.key!==key).concat(outputFile);
      target.tasks=mergeInvoiceTasks(target.tasks,invoiceWorkItems(data));
    } else target.tasks=tasks.length?tasks:target.tasks;
    if (stableReviewJson(target.tasks)!==stableReviewJson(targetBusiness.tasks))target.notes=target.tasks.join('\n');
    if (data.supplier)target.workshop=data.supplier;
    const newName=uniqueInvoiceDisplayName(buildInvoiceDisplayName(destination.bike.name,data.invoiceDate,target.date,attachment.name),target.attachments,key);
    const invoiceChanged=shouldMove || stableReviewJson(data)!==stableReviewJson(original) || !!attachment.ocrError || attachment.name!==newName;
    const serviceChanged=shouldMove || stableReviewJson(reviewBusinessState(target))!==stableReviewJson(targetBusiness);
    const changed=invoiceChanged||serviceChanged;
    if (changed && ((body.expectedReviewRevision && revision!==body.expectedReviewRevision) || (!body.expectedReviewRevision && body.expectedEntryUpdatedAt!==undefined && String(body.expectedEntryUpdatedAt)!==String(JSON.parse(located.entryJson).updatedAt||'')))) return json({error:'Το service ή τα στοιχεία του τιμολογίου άλλαξαν. Άνοιξε ξανά τον έλεγχο· οι διορθώσεις σου δεν αντικατέστησαν νεότερα δεδομένα.',code:'review_conflict'},409);
    const updates=[];
    if(changed){
      Object.assign(outputFile,{ocr:data,qrData:data,ocrError:'',reviewSeenAt:data.reviewSeenAt,name:newName});target.invoiceData=data;target.updatedAt=now;
      ServiceModel.decision(target,key,shouldMove?targetBefore:before,data,name,now,!!shouldMove);
      if(shouldMove){entry.updatedAt=now;updates.push({located,entry:normalizeHistory([entry])[0],bikePatch:{updatedAt:now}});}
      updates.push({located:destination,entry:normalizeHistory([target])[0],bikePatch:{updatedAt:now}});
    } else updates.push({located,entry,bikePatch:{}});
    if(kmChanged){
      const full=await readSnapshotBike(env,targetBikeId);
      if(!full)return json({error:'Το μηχανάκι προορισμού δεν βρέθηκε.'},404);
      for(const update of updates)if(String(update.located.bike.id)===targetBikeId){const index=full.bike.history.findIndex(item=>item.id===update.entry.id);if(index>=0)full.bike.history[index]=update.entry;}
      full.bike.historyCorrectedAt=now;full.bike.odometerFloorKm=await workforceOdometerFloor(env,targetBikeId);
      const normalized=normalizeBike(full.bike),update=updates.at(-1);update.bikeJson=full.json;
      for(const field of ['lastServiceKm','currentKm','nextServiceKm','lastCheckedAt','historyCorrectedAt','odometerFloorKm','hasMajorService','lastMajorServiceKm','lastMajorServiceMilestoneKm','pendingMajorServiceKm','nextMajorServiceKm','majorServiceTargetKm'])update.bikePatch[field]=normalized[field];
    }
    const storedEntry=updates.at(-1).entry,storedFile=storedEntry.attachments.find(item=>item.key===key);
    const document=adminServiceDocumentRecord(destination.bike,storedEntry,storedFile,null,[],true);document.reviewRevision=await invoiceReviewRevision(storedEntry,storedFile);
    const result={ok:true,requestId,document,serviceChanged:!!serviceChanged,invoiceChanged:!!invoiceChanged,unchanged:!changed,...(shouldMove?{moved:true,movedFromKey:key}:{})};
    const saved=await commitInvoiceReview(env,{actor,requestId,hash,updates,result,now,changed,source:shouldMove?'admin-service-document-move':'admin-service-document-review',audit:{action:shouldMove?'service_document_moved':'service_document_reviewed',before:{bikeId,entryId,state:before},after:{bikeId:targetBikeId,entryId:targetEntryId,invoiceData:ServiceModel.state(storedEntry,data).invoiceData,serviceChanged},reason:shouldMove?'Μεταφορά τιμολογίου στο σωστό μηχανάκι':'Επιβεβαίωση και διόρθωση στοιχείων τιμολογίου',ip:request.headers.get('CF-Connecting-IP')||''}});
    if(saved)return invoiceReviewResponse(env,body,saved);
  }
  return json({error:'Υπάρχουν ταυτόχρονες ενημερώσεις. Οι διορθώσεις σου παραμένουν· δοκίμασε ξανά.',code:'review_busy'},409);
}

async function resolveQrServiceDocument(request, env) {
  if (!await authorizedFor(request, env, "fleet.manage")) return json({ error: "Χρειάζεται σύνδεση διαχείρισης." }, 401);
  const body = await request.json().catch(() => ({}));
  const qrValue = normalizeQrValue(body.value);
  const qrUrl = qrUrlFromValue(qrValue);
  if (!qrValue) return json({ error: "Δεν βρέθηκε περιεχόμενο QR." }, 400);
  if (!qrUrl) return json({ ok: true, qrValue, extracted: null, error: "Το QR δεν περιέχει δημόσιο ηλεκτρονικό URL." });
  if (!isPublicExternalQrUrl(qrUrl)) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Το URL του QR δεν επιτρέπεται για αυτόματη ανάγνωση." });
  if (!env.AI) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Το OCR/AI δεν είναι διαθέσιμο στον Worker." });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = (await fetchExternalQrPage(qrUrl, controller.signal)).response;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return json({ ok: true, qrValue, qrUrl, extracted: null, error: `Η ηλεκτρονική σελίδα επέστρεψε HTTP ${response.status}.` });
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 8 * 1024 * 1024) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Η ηλεκτρονική σελίδα είναι πολύ μεγάλη για αυτόματη ανάγνωση." });
    if (type.includes("application/pdf")) {
      if (!env.AI.toMarkdown) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Δεν είναι διαθέσιμη η ανάγνωση PDF από το QR." });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 8 * 1024 * 1024) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Το PDF του QR είναι πολύ μεγάλο." });
      const converted = await env.AI.toMarkdown({ name: "qr-invoice.pdf", blob: new Blob([bytes], { type: "application/pdf" }) });
      const result = Array.isArray(converted) ? converted[0] : converted;
      if (!result || result.format === "error" || !result.data) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Δεν διαβάστηκε το PDF του QR." });
      const extracted = await extractInvoiceFromText(env, String(result.data), "qr-pdf");
      return json({ ok: true, qrValue, qrUrl, extracted: { ...extracted, qrUrl, source: "qr-pdf" }, requiresConfirmation: true });
    }
    const raw = await response.text();
    const text = type.includes("text/html") ? htmlToInvoiceText(raw) : raw.slice(0, 60000);
    if (!text.trim()) return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Η ηλεκτρονική σελίδα δεν επέστρεψε αναγνώσιμο κείμενο." });
    const extracted = await extractInvoiceFromText(env, text, "qr");
    return json({ ok: true, qrValue, qrUrl, extracted: { ...extracted, qrUrl, source: "qr" }, requiresConfirmation: true });
  } catch (error) {
    return json({ ok: true, qrValue, qrUrl, extracted: null, error: "Δεν ήταν δυνατή η αυτόματη ανάγνωση της ηλεκτρονικής σελίδας του QR." });
  }
}

function baseHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Fleet-Pin, X-Fleet-Client-Key, X-Fleet-Server-Key, X-Admin-Pin, X-Idempotency-Key, X-Release-Version, X-Release-Notes, X-File-Name",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...extra
  };
}

function json(payload, status = 200, extra = {}) {
  return Response.json(payload, {
    status,
    headers: baseHeaders({ "Cache-Control": "no-store", ...extra })
  });
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: baseHeaders() });
}

function cleanText(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function decodeJsonHeader(value) {
  const encoded = cleanText(value, 24000);
  if (!encoded) return null;
  try {
    const remainder = encoded.length % 4;
    const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/") + padding;
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function documentContentType(type, filename = "") {
  const supplied = cleanText(type, 80).toLowerCase().split(";")[0].trim();
  if (supplied === "image/jpg") return "image/jpeg";
  if (supplied && supplied !== "application/octet-stream") return supplied;
  const extension = String(filename || "").toLowerCase().split("?")[0].split(".").pop();
  return ({
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif"
  })[extension] || "application/octet-stream";
}

function detectDocumentContentType(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (value.length >= 4 && value[0] === 0x25 && value[1] === 0x50 && value[2] === 0x44 && value[3] === 0x46) return "application/pdf";
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg";
  if (value.length >= 8 && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47) return "image/png";
  if (value.length >= 12 && String.fromCharCode(...value.slice(0, 4)) === "RIFF" && String.fromCharCode(...value.slice(8, 12)) === "WEBP") return "image/webp";
  if (value.length >= 12 && String.fromCharCode(...value.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...value.slice(8, 12)).toLowerCase();
    if (brand.includes("heic") || brand.includes("heif") || brand.includes("mif1")) return "image/heic";
  }
  return "application/octet-stream";
}

function cleanInteger(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function isoDateTime(value, fallback) {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function calendarDate(value) {
  const candidate = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : new Date().toISOString().slice(0, 10);
}

function strictCalendarDate(value) {
  const candidate = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
  const parsed = new Date(`${candidate}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : "";
}

function normalizeDeletedHistoryIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => cleanText(id, 100)).filter(Boolean))].slice(0, MAX_HISTORY);
}

function normalizeQrValue(value) {
  return cleanText(value, 4000);
}

function qrUrlFromValue(value) {
  const candidate = normalizeQrValue(value);
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString().slice(0, 2000) : "";
  } catch {
    return "";
  }
}

function compactInvoicePlate(value) {
  const raw = cleanText(value, 60).toLocaleUpperCase("el");
  const compact = raw
    .replace(/[\s_]+/g, "-")
    .replace(/[^A-Z0-9Α-ΩΆΈΉΊΌΎΏΪΫ-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return compact.slice(0, 40) || "ΜΗΧΑΝΑΚΙ";
}

function invoiceDateForName(value, fallback) {
  const candidate = cleanText(value, 80);
  const iso = strictCalendarDate(candidate.slice(0, 10));
  if (iso) return iso;
  const match = candidate.match(/(^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\D|$)/);
  if (match) {
    const day = String(match[2]).padStart(2, "0");
    const month = String(match[3]).padStart(2, "0");
    const year = match[4];
    const normalized = `${year}-${month}-${day}`;
    if (strictCalendarDate(normalized)) return normalized;
  }
  return strictCalendarDate(fallback) || new Date().toISOString().slice(0, 10);
}

function buildInvoiceDisplayName(bikeName, invoiceDate, fallbackDate, fallbackName) {
  const plate = compactInvoicePlate(bikeName || fallbackName || "ΜΗΧΑΝΑΚΙ");
  return `${plate}_${invoiceDateForName(invoiceDate, fallbackDate)}.pdf`;
}

function contentDispositionForFilename(value) {
  const name = cleanText(value, 160).replace(/[\r\n"\\]/g, "_") || "invoice.pdf";
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_") || "invoice.pdf";
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function uniqueInvoiceDisplayName(baseName, attachments, currentKey) {
  const base = cleanText(baseName, 120) || "ΜΗΧΑΝΑΚΙ_" + new Date().toISOString().slice(0, 10) + ".pdf";
  const match = base.match(/^(.*?)(\.pdf)$/i);
  const stem = match ? match[1] : base;
  const extension = match ? match[2] : ".pdf";
  const taken = new Set((Array.isArray(attachments) ? attachments : [])
    .filter((item) => String(item?.key || "") !== String(currentKey || ""))
    .map((item) => cleanText(item?.name, 120).toLocaleLowerCase("el")));
  if (!taken.has(base.toLocaleLowerCase("el"))) return base;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${stem}_${index}${extension}`;
    if (!taken.has(candidate.toLocaleLowerCase("el"))) return candidate;
  }
  return `${stem}_${Date.now()}${extension}`;
}

function normalizedTaskKey(value) {
  return cleanText(value, 500).toLocaleLowerCase("el")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9α-ω]+/g, "");
}

function isOilTask(value) { return ServiceModel.isOilTask(value); }

function splitInvoiceWork(value, structured = false) {
  const text=typeof value==='string'||typeof value==='number'?cleanText(String(value),MAX_INVOICE_TEXT):invoiceLineText(value,500);
  return text
    .split(structured?/\r?\n|\s*[•;]+\s*/:/\r?\n|\s*[•;]+\s*|\s*,\s*/)
    .map((part) => invoiceLineText(part, 500))
    .filter(Boolean)
    .slice(0, MAX_INVOICE_ITEMS);
}

function cleanInvoiceWorkText(value) {
  const text = String(value || "");
  const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const match = /οροι\s+πληρωμης|τροπος\s+πληρωμης|πληρωμης\s+συναλλαγης|τοις\s+μετρητοις|payment\s+terms|cash\s+payment/.exec(folded);
  if (!match) return text.trim();
  // Convert the folded index back to the original, preserving Greek accents.
  let index = 0, length = 0;
  for (const letter of text) { if (length >= match.index) break; index += letter.length; length += letter.normalize("NFD").replace(/[\u0300-\u036f]/g, "").length; }
  return text.slice(0, index).replace(/[\s:;·—–-]+$/, "").trim();
}

function invoiceWorkItems(data) {
  const values = [];
  values.push(...splitInvoiceWork(data?.workPerformed,Boolean(data?.lineItems?.length)));
  values.push(...(Array.isArray(data?.lineItems) ? data.lineItems : []));
  values.push(...(Array.isArray(data?.parts) ? data.parts : []));
  const result=[],seen=new Set();
  for(const item of values){const text=cleanInvoiceWorkText(invoiceLineText(item,500)),key=normalizedTaskKey(text);if(!key||seen.has(key))continue;seen.add(key);result.push(text);if(result.length>=MAX_INVOICE_ITEMS)break;}
  return result;
}

function stripInvoicePartCode(value) {
  const original = cleanText(value, 3000);
  let text = original;
  text = text.replace(/^\s*(?:κωδ(?:ικός)?|κωδ\.?|code|sku|item\s*code|ref(?:erence)?)[\s:#№-]*[A-ZΑ-Ω0-9][A-ZΑ-Ω0-9./_-]{1,}\s*(?:[-–—:|]\s*)?/iu, "");
  text = text.replace(/^\s*[A-ZΑ-Ω]{1,6}[-_\/]?\d{3,}\s*[-–—:|]\s*/iu, "");
  text = text.replace(/^\s*\d{4,}\s*[-–—:|]\s*/, "");
  text = text.replace(/^\s*\d{4,}\s+(?=[A-Za-zΑ-ΩΆΈΉΊΌΎΏΪΫα-ωάέήίόύώϊϋ])/u, "");
  return cleanText(text || original, 500);
}

function invoiceLineText(value, limit = 500) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return cleanText(stripInvoicePartCode(String(value)), limit);
  if (typeof value === "object" && !Array.isArray(value)) {
    const preferred = ["description", "name", "item", "text", "label", "title", "work", "service", "part", "product", "details", "value"];
    for (const key of preferred) {
      if (value[key] != null && String(value[key]).trim()) return cleanText(stripInvoicePartCode(String(value[key])), limit);
    }
    try {
      const flattened = Object.entries(value).filter(([, item]) => item != null && String(item).trim()).map(([key, item]) => `${key}: ${item}`).join(" · ");
      return cleanText(stripInvoicePartCode(flattened), limit);
    } catch {}
  }
  return cleanText(stripInvoicePartCode(String(value).replace(/\[object Object\]/g, "")), limit);
}

function mergeInvoiceTasks(existing, imported, limit = 5120) {
  const result = [], keys = new Set();
  let oilIndex = -1;
  const oilDetail = (value) => String(value || "")
    .replace(/\b(change|changed|replacement|replace)\s+oil(s)?\b/ig, "")
    .replace(/\b(oil|ladi)\s+change\b/ig, "")
    .replace(/αλλαγ(?:η|ή)\s+λαδι(?:ών|ων|α)/ig, "")
    .replace(/λαδι(?:ών|ων|α)/ig, "")
    .replace(/[–—:;,·]+/g, " ").replace(/\s+/g, " ").trim();
  const add = (raw) => {
    const task = cleanInvoiceWorkText(invoiceLineText(raw, 500));
    if (!task) return;
    if (isOilTask(task) && oilIndex >= 0) {
      const currentDetail = oilDetail(result[oilIndex]);
      const nextDetail = oilDetail(task);
      const detail = currentDetail.length >= nextDetail.length ? currentDetail : nextDetail;
      keys.delete(normalizedTaskKey(result[oilIndex]));
      result[oilIndex] = (detail ? `Αλλαγή λαδιών — ${detail}` : "Αλλαγή λαδιών").slice(0, 180);
      keys.add(normalizedTaskKey(result[oilIndex]));
      return;
    }
    const key = normalizedTaskKey(task);
    if (!key || keys.has(key)) return;
    keys.add(key);
    if (isOilTask(task)) oilIndex=result.length;
    result.push(task);
  };
  (Array.isArray(existing) ? existing : []).forEach(add);
  (Array.isArray(imported) ? imported : []).forEach(add);
  return result.slice(0, limit);
}

function invoiceOdometer(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  const parsed = Number(digits);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function invoicePlateKey(value) {
  const greek = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ";
  const latin = "ABEZHIKMNOPTYX";
  return String(value || "").normalize("NFKC").toUpperCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (letter) => latin.charAt(greek.indexOf(letter)))
    .replace(/[^A-Z0-9Α-Ω]/g, "");
}

function strictInvoicePlate(value) {
  const key = invoicePlateKey(value);
  return /^[ABEZHIKMNOPTYX]{3}[0-9]{3,4}$/.test(key) ? key.slice(0, 3) + "-" + key.slice(3) : "";
}

function hasInvoicePlateContext(rawText, key) {
  const text = String(rawText || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const contexts = text.match(/(?:πινακιδα|αρ\.?\s*κυκλ\.?|plate|registration|σχολια|comments)[^\n]{0,120}(?:\n[^\n]{0,40})?/g) || [];
  return contexts.some((context) => invoicePlateKey(context).includes(key));
}

function refineInvoicePlateForFleet(data, bikes) {
  if (!data || data.confirmedAt || !data.plate) return data;
  const key = invoicePlateKey(data.plate);
  const fleet = Array.isArray(bikes) ? bikes : [];
  if (fleet.some((bike) => invoicePlateKey(bike.name) === key)) return data;
  // A single letter typo is tolerated only in an explicitly labelled plate
  // or comments, with identical digits and one unique registered vehicle.
  if (!hasInvoicePlateContext(data.rawText, key)) return data;
  const candidates = fleet.filter((bike) => {
    const candidate = invoicePlateKey(bike.name);
    return /^[ABEZHIKMNOPTYX]{3}[0-9]{3,4}$/.test(candidate) && candidate.slice(3) === key.slice(3) &&
      [...candidate.slice(0, 3)].filter((letter, index) => letter !== key[index]).length === 1;
  });
  if (candidates.length !== 1) return data;
  return { ...data, plate: strictInvoicePlate(candidates[0].name), plateAutoCorrectedFrom: data.plate };
}

function serviceDocumentWarnings(bike, entry, data) {
  const warnings = [];
  const invoicePlate = invoicePlateKey(data?.plate);
  const selectedPlate = invoicePlateKey(bike?.name);
  const plateResolved = data?.confirmedAt && data?.plateResolution === "kept-current" &&
    data.plateResolutionBikeId === String(bike?.id) && data.plateResolutionPlate === selectedPlate && data.plateResolutionRead === invoicePlate;
  if (data?.plate && bike?.name && invoicePlate !== selectedPlate && !plateResolved) {
    warnings.push({ type: "plate", label: "Διαφορετική πινακίδα", message: `Το τιμολόγιο γράφει ${data.plate}, ενώ το service είναι συνδεδεμένο με ${bike.name}.` });
  }
  const invoiceKm = invoiceOdometer(data?.odometerKm);
  const serviceKm = Math.round(Number(entry?.km) || 0);
  if (invoiceKm && invoiceKm !== serviceKm && !ServiceModel.resolved(entry, data)) {
    warnings.push({ type: "odometer", label: "Διαφορετικά χιλιόμετρα", message: `Το τιμολόγιο γράφει ${invoiceKm.toLocaleString("el-GR")} χλμ., ενώ το service έχει ${serviceKm.toLocaleString("el-GR")} χλμ.` });
  }
  if (ServiceModel.amounts(data).mismatch) warnings.push({ type: "amount", label: "Διαφορά ποσών", message: "Η καθαρή αξία και ο ΦΠΑ δεν συμφωνούν με το τελικό ποσό. Έλεγξε το PDF." });
  if (!data?.confirmedAt && String(data?.ocrFallbackUsed || "").toLowerCase() === "true") {
    const reason = cleanText(data?.ocrFallbackReason, 240) || "Η τοπική ανάγνωση ήταν αμφίβολη ή απέτυχε.";
    const manual = /^Ζητήθηκε χειροκίνητα/i.test(reason);
    warnings.push({
      type: "ocr-fallback",
      label: manual ? "Workers AI κατόπιν εντολής" : "Χρησιμοποιήθηκε Workers AI",
      message: `${reason} ${manual ? "Χρησιμοποιήθηκε Workers AI κατόπιν εντολής." : "Έγινε αυτόματο fallback στο Workers AI."}`
    });
  }
  if (!data?.confirmedAt && String(data?.ocrFallbackError || "").trim()) {
    warnings.push({ type: "ocr-fallback-error", label: "Χρειάζεται έλεγχος OCR", message: cleanText(data.ocrFallbackError, 300) });
  }
  for (const item of data?.reviewIssues || []) warnings.push({type:'invoice-'+item.code,label:'Χρειάζεται έλεγχος',message:item.message,field:item.field});
  return warnings;
}

function normalizeInvoiceWorkPerformed(value, limit = MAX_INVOICE_TEXT, structured = false) {
  const source = Array.isArray(value) ? value : [value];
  const items = source.flatMap((item) => splitInvoiceWork(item,structured))
    .map((item) => cleanInvoiceWorkText(invoiceLineText(item, 500)))
    .filter(Boolean)
    .slice(0, MAX_INVOICE_ITEMS);
  return cleanText(items.join("\n"), limit);
}

function normalizeServiceInvoiceData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of ["supplier", "invoiceNumber", "invoiceDate", "mark", "plate", "odometerKm", "workPerformed", "comments", "laborAmount", "netAmount", "vatAmount", "totalAmount", "notes", "source", "qrUrl", "confirmedAt", "reviewedBy", "reviewStatus", "ocrReprocessedAt", "ocrSource", "ocrFallbackUsed", "ocrFallbackReason", "ocrFallbackError", "localReadStatus", "localReadAt", "ocrConfidence", "qrJobId", "qrProcessingStatus", "qrProcessingStartedAt", "qrProcessingUpdatedAt", "qrProcessingError", "qrProcessingAttempts", "qrProcessingProgress", "qrProcessingStage", "reviewSeenAt", "plateResolution", "plateResolutionBikeId", "plateResolutionPlate", "plateResolutionRead", "correctedByUserAt", "serviceKmBeforeCorrection", "serviceKmAfterCorrection", "mileageResolution", "mileageResolutionEntryId", "mileageResolutionRead", "mileageResolutionServiceKm", "plateAutoCorrectedFrom", "confirmationMethod", "confirmationRuleVersion", "confirmationReason", "lastReadFingerprint", "acknowledgedReadFingerprint", "lastReadCanonicalFingerprint", "acknowledgedReadCanonicalFingerprint", "lastReadFields", "acknowledgedReadFields", "reviewDocumentKey"]) {
    if (value[field] == null) continue;
    if (field === "qrProcessingProgress") {
      result[field] = String(cleanInteger(value[field], 0, 100, 5));
      continue;
    }
    if (field === "workPerformed") {
      const work = normalizeInvoiceWorkPerformed(value[field],MAX_INVOICE_TEXT,Boolean(value.lineItems?.length));
      if (work) result[field] = work;
      continue;
    }
    if (field === "ocrConfidence") {
      result[field] = String(cleanInteger(value[field], 0, 100, 0));
      continue;
    }
    if (["ocrFallbackUsed"].includes(field)) {
      result[field] = value[field] === true || String(value[field]).toLowerCase() === "true" ? "true" : "false";
      continue;
    }
    if (cleanText(String(value[field]), 2000)) result[field] = cleanText(String(value[field]), 2000);
  }
  if (value.rawText != null) result.rawText = cleanText(String(value.rawText), MAX_INVOICE_TEXT);
  if (Array.isArray(value.parts)) result.parts = value.parts.map((part) => cleanInvoiceWorkText(invoiceLineText(part, 500))).filter(Boolean).slice(0, MAX_INVOICE_ITEMS);
  if (Array.isArray(value.lineItems)) result.lineItems = value.lineItems.map((part) => cleanInvoiceWorkText(invoiceLineText(part, 500))).filter(Boolean).slice(0, MAX_INVOICE_ITEMS);
  normalizeInvoiceAnalysis(value,result);
  normalizeInvoiceDecision(value,result);
  if(String(value.rawText||'').length>MAX_INVOICE_TEXT)result.textTruncated=true;
  return Object.keys(result).length ? result : null;
}

function aiInvoiceAnalysis(value,local,aiMs=0) {
  const fields={};
  for(const field of ['plate','odometerKm','invoiceDate','totalAmount','netAmount','vatAmount','lineItems','supplier','invoiceNumber'])if(value?.[field]){
    const raw=String(value.rawText||''),text=String(value[field]),offset=raw.indexOf(text);
    fields[field]={score:55,reason:'Αποτέλεσμα Workers AI · χρειάζεται επιβεβαίωση',source:'workers-ai',evidence:offset>=0?raw.slice(Math.max(0,offset-60),offset+text.length+80):''};
  }
  return {...value,analysisEngine:'workers-ai',analysisVersion:'ai-invoice-v2',analysisCacheHit:false,
    analysisDurationMs:(Number(local?.analysisDurationMs)||0)+Math.round(aiMs),analysisTimings:{...local?.analysisTimings,aiMs:Math.round(aiMs)},fieldEvidence:fields};
}

function normalizeInvoiceAnalysis(value,result) {
  for(const key of ['analysisEngine','analysisVersion']) if(value[key]) result[key]=cleanText(value[key],100);
  if(value.analysisCacheHit!=null)result.analysisCacheHit=value.analysisCacheHit===true||value.analysisCacheHit==='true';
  if(value.analysisDurationMs!=null)result.analysisDurationMs=cleanInteger(value.analysisDurationMs,0,600000,0);
  if(value.analysisTimings&&typeof value.analysisTimings==='object') {
    result.analysisTimings={};for(const key of ['textMs','pdfboxMs','ocrWaitMs','ocrMs','qrPdfMs','uploadMs','aiMs'])if(value.analysisTimings[key]!=null)result.analysisTimings[key]=cleanInteger(value.analysisTimings[key],0,600000,0);
  }
  if(value.fieldEvidence&&typeof value.fieldEvidence==='object') {
    result.fieldEvidence={};for(const field of ['plate','odometerKm','invoiceDate','totalAmount','netAmount','vatAmount','lineItems','supplier','invoiceNumber']){
      const item=value.fieldEvidence[field];if(!item||typeof item!=='object')continue;
      result.fieldEvidence[field]={score:cleanInteger(item.score,0,100,0),reason:cleanText(item.reason,180),source:cleanText(item.source,60),evidence:cleanText(item.evidence,500)};
    }
  }
}

function normalizeServiceDocumentOcr(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of ["rawText", "supplier", "invoiceNumber", "invoiceDate", "mark", "plate", "odometerKm", "workPerformed", "comments", "laborAmount", "netAmount", "vatAmount", "totalAmount", "notes", "source", "qrUrl", "confirmedAt", "reviewedBy", "reviewStatus", "ocrReprocessedAt", "ocrSource", "ocrFallbackUsed", "ocrFallbackReason", "ocrFallbackError", "localReadStatus", "localReadAt", "ocrConfidence", "qrJobId", "qrProcessingStatus", "qrProcessingStartedAt", "qrProcessingUpdatedAt", "qrProcessingError", "qrProcessingAttempts", "qrProcessingProgress", "qrProcessingStage", "reviewSeenAt", "plateResolution", "plateResolutionBikeId", "plateResolutionPlate", "plateResolutionRead", "correctedByUserAt", "serviceKmBeforeCorrection", "serviceKmAfterCorrection", "mileageResolution", "mileageResolutionEntryId", "mileageResolutionRead", "mileageResolutionServiceKm", "plateAutoCorrectedFrom", "confirmationMethod", "confirmationRuleVersion", "confirmationReason", "lastReadFingerprint", "acknowledgedReadFingerprint", "lastReadCanonicalFingerprint", "acknowledgedReadCanonicalFingerprint", "lastReadFields", "acknowledgedReadFields", "reviewDocumentKey"]) {
    if (value[field] == null) continue;
    if (field === "qrProcessingProgress") {
      result[field] = String(cleanInteger(value[field], 0, 100, 5));
      continue;
    }
    if (field === "workPerformed") {
      const work = normalizeInvoiceWorkPerformed(value[field],MAX_INVOICE_TEXT,Boolean(value.lineItems?.length));
      if (work) result[field] = work;
      continue;
    }
    if (field === "ocrConfidence") {
      result[field] = String(cleanInteger(value[field], 0, 100, 0));
      continue;
    }
    if (["ocrFallbackUsed"].includes(field)) {
      result[field] = value[field] === true || String(value[field]).toLowerCase() === "true" ? "true" : "false";
      continue;
    }
    const cleaned = cleanText(String(value[field]), field === "rawText" ? MAX_INVOICE_TEXT : 2000);
    if (cleaned) result[field] = cleaned;
  }
  if (Array.isArray(value.parts)) result.parts = value.parts.map((part) => cleanInvoiceWorkText(invoiceLineText(part, 500))).filter(Boolean).slice(0, MAX_INVOICE_ITEMS);
  if (Array.isArray(value.lineItems)) result.lineItems = value.lineItems.map((part) => cleanInvoiceWorkText(invoiceLineText(part, 500))).filter(Boolean).slice(0, MAX_INVOICE_ITEMS);
  if (result.plate && !result.confirmedAt) {
    const plate = strictInvoicePlate(result.plate);
    const textEvidence = result.rawText && !/^\s*[{[]/.test(result.rawText);
    if (plate && (!textEvidence || hasInvoicePlateContext(result.rawText, invoicePlateKey(plate)))) result.plate = plate;
    else delete result.plate;
  }
  normalizeInvoiceAnalysis(value,result);
  normalizeInvoiceDecision(value,result);
  if(String(value.rawText||'').length>MAX_INVOICE_TEXT)result.textTruncated=true;
  return Object.keys(result).length ? result : null;
}

function normalizeServiceAttachments(value) {
  if (!Array.isArray(value)) return [];
  return ServiceModel.preserveInvoiceFiles(value,[]).slice(0, 10).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const key = cleanText(item.key, 500);
    const id = cleanText(item.id, 160);
    if (!id || !isServiceDocumentKey(key)) return [];
    return [{
      id,
      key,
      name: cleanText(item.name || "τιμολόγιο", 120),
      originalName: cleanText(item.originalName, 120),
      uploadId: cleanText(item.uploadId, 100),
      contentType: cleanText(item.contentType || "application/octet-stream", 80).toLowerCase(),
      size: cleanInteger(item.size, 0, 15 * 1024 * 1024, 0),
      uploadedAt: isoDateTime(item.uploadedAt, ""),
      qrValue: normalizeQrValue(item.qrValue || item.qrUrl),
      qrUrl: qrUrlFromValue(item.qrUrl || item.qrValue),
      renderJobId: cleanText(item.renderJobId, 100),
      sourcePhoto: ServiceModel.sourcePhoto(item.sourcePhoto),
      ocrError: cleanText(item.ocrError, 500),
      reviewSeenAt: isoDateTime(item.reviewSeenAt, ""),
      ocr: normalizeServiceDocumentOcr(item.ocr)
    }];
  });
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_HISTORY).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = cleanText(item.id, 100);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    let tasks = Array.isArray(item.tasks)
      ? item.tasks.map((task) => invoiceLineText(task, 500)).filter(Boolean).slice(0, 5120)
      : [];
    const notes = cleanText(item.notes, MAX_INVOICE_TEXT);
    if (!tasks.length && item.type !== "check" && notes) {
      tasks = notes.split(/\r?\n|,|•/).map((task) => invoiceLineText(task, 500)).filter(Boolean).slice(0, 5120);
    }
    const type = item.type === "check" ? "check" : "service";
    const majorService = type === "service" && (typeof item.majorService === "boolean"
      ? item.majorService
      : tasks.some((task) => /μεγάλ(?:ο|ου)\s+(?:σέρβις|service)/i.test(task)));
    if (majorService && !tasks.includes("Μεγάλο service")) tasks = ["Μεγάλο service", ...tasks].slice(0, 5120);
    if (type === "service") tasks = mergeInvoiceTasks(tasks, []);
    const legacyOil = type === "service" && (notes === "Αρχική καταχώρηση" || /λάδι/i.test(notes));
    return [{
      id,
      type,
      km: cleanInteger(item.km, 0, 2_000_000_000, 0),
      date: calendarDate(item.date),
      notes,
      tasks,
      workshop: cleanText(item.workshop, 120),
      cost: cleanText(item.cost ?? item.serviceCost, 60),
      oilChanged: typeof item.oilChanged === "boolean" ? item.oilChanged : legacyOil,
      majorService,
      // Legacy snapshots credited a rounded ten-thousand milestone. The
      // actual recorded odometer is now the only baseline for the next cycle.
      majorServiceMilestoneKm: majorService ? cleanInteger(item.km, 0, 2_000_000_000, 0) : 0,
      reviewJournal: ServiceModel.journal(item.reviewJournal),
      invoiceExpectation: ServiceModel.expectation(item.invoiceExpectation),
      kmAcknowledgments: ServiceModel.kmAcknowledgments(item.kmAcknowledgments),
      attachments: type === "service" ? normalizeServiceAttachments(item.attachments) : [],
      invoiceData: type === "service" ? normalizeServiceInvoiceData(item.invoiceData) : null,
      appointmentId: cleanText(item.appointmentId,100),
      createdAt: isoDateTime(item.createdAt, ""),
      updatedAt: isoDateTime(item.updatedAt, isoDateTime(item.createdAt, ""))
    }];
  });
}

function majorEntryMilestone(entry) {
  if (!entry || entry.type !== "service" || !entry.majorService) return 0;
  return cleanInteger(entry.km, 0, 2_000_000_000, 0);
}

function deriveMajorTracking(history) {
  const completed = (Array.isArray(history) ? history : []).reduce((result, entry) => {
    if (!entry || entry.type !== "service" || !entry.majorService) return result;
    const actualKm = cleanInteger(entry.km, 0, 2_000_000_000, 0);
    const stamp = historyEntryStamp(entry);
    return !result.recorded || actualKm > result.actualKm || (actualKm === result.actualKm && stamp >= result.stamp)
      ? { recorded: true, actualKm, stamp }
      : result;
  }, { recorded: false, actualKm: 0 });
  const nextMajorServiceKm = completed.recorded ? completed.actualKm + MAJOR_SERVICE_INTERVAL_KM : 0;
  return {
    hasMajorService: completed.recorded,
    lastMajorServiceKm: completed.actualKm,
    lastMajorServiceMilestoneKm: completed.actualKm,
    // Kept for compatibility with older snapshots; it is never used as the
    // source of a reminder.
    pendingMajorServiceKm: 0,
    nextMajorServiceKm,
    majorServiceTargetKm: nextMajorServiceKm
  };
}

function historyEntryStamp(entry) {
  return String(entry?.updatedAt || entry?.createdAt || (entry?.date ? `${entry.date}T00:00:00.000Z` : ""));
}

function correctedMetrics(history, odometerFloorKm = 0) {
  const live = Array.isArray(history) ? history : [];
  const lastServiceKm = live.reduce((highest, entry) => {
    return entry.type === "service" && entry.oilChanged ? Math.max(highest, Number(entry.km) || 0) : highest;
  }, 0);
  const currentKm = live.reduce((highest, entry) => Math.max(highest, Number(entry.km) || 0), Math.max(lastServiceKm, Number(odometerFloorKm) || 0));
  const lastCheckedAt = live.filter((entry) => entry.type === "check").map((entry) => String(entry.date || "")).sort().at(-1) || "";
  return { lastServiceKm, currentKm, lastCheckedAt };
}

function normalizeBike(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanText(value.id, 100);
  const name = cleanText(value.name, 40);
  if (!id || !name) return null;
  const now = new Date().toISOString();
  const intervalKm = cleanInteger(value.intervalKm, 1, 10_000_000, 1);
  const historyRestores=OperationsModel.lifecycle(value.historyRestores), historyDeletes=OperationsModel.lifecycle(value.historyDeletes);
  const historyDeletedIds = OperationsModel.deletedIds(normalizeDeletedHistoryIds(value.historyDeletedIds),historyRestores,historyDeletes);
  const deleted = new Set(historyDeletedIds);
  const history = normalizeHistory(value.history).filter((entry) => !deleted.has(entry.id));
  const historyCorrectedAt = isoDateTime(value.historyCorrectedAt, "");
  const odometerFloorKm = cleanInteger(value.odometerFloorKm, 0, 2_000_000_000, 0);
  const historyServiceKm = history.reduce((highest, entry) => entry.type === "service" && entry.oilChanged ? Math.max(highest, entry.km) : highest, 0);
  const derived = correctedMetrics(history, odometerFloorKm);
  const lastServiceKm = historyCorrectedAt
    ? derived.lastServiceKm
    : Math.max(cleanInteger(value.lastServiceKm, 0, 2_000_000_000, 0), historyServiceKm);
  const currentKm = historyCorrectedAt
    ? Math.max(lastServiceKm, derived.currentKm)
    : Math.max(lastServiceKm, cleanInteger(value.currentKm, 0, 2_000_000_000, lastServiceKm));
  const majorTracking = deriveMajorTracking(history);
  return {
    id,
    name,
    intervalKm,
    lastServiceKm,
    currentKm,
    nextServiceKm: lastServiceKm + intervalKm,
    lastCheckedAt: historyCorrectedAt ? derived.lastCheckedAt : cleanText(value.lastCheckedAt, 10),
    createdAt: isoDateTime(value.createdAt, now),
    maintenancePlans: ServiceModel.plans(value.maintenancePlans),
    serviceAppointments: OperationsModel.appointments(value.serviceAppointments),
    nextServiceNotes: OperationsModel.nextServiceNotes(value.nextServiceNotes),
    historyRestores, historyDeletes,
    updatedAt: isoDateTime(value.updatedAt, now),
    history,
    historyDeletedIds,
    historyCorrectedAt,
    odometerFloorKm,
    ...majorTracking
  };
}

function normalizeFleet(value) {
  const requested = value && Array.isArray(value.bikes) ? value.bikes : [];
  if (requested.length > MAX_BIKES) throw new Error("Έχει συμπληρωθεί το όριο των 40 μηχανών.");
  const bikes = requested.map(normalizeBike).filter(Boolean);
  if (bikes.length !== requested.length || new Set(bikes.map((bike) => bike.id)).size !== bikes.length) {
    throw new Error("Τα δεδομένα του στόλου δεν είναι έγκυρα.");
  }
  return { bikes };
}

function mergeBike(first, second) {
  const latest = String(second.updatedAt) >= String(first.updatedAt) ? second : first;
  const historyRestores=OperationsModel.mergeLifecycle(first.historyRestores,second.historyRestores),historyDeletes=OperationsModel.mergeLifecycle(first.historyDeletes,second.historyDeletes);
  const historyDeletedIds = OperationsModel.deletedIds([...(first.historyDeletedIds||[]),...(second.historyDeletedIds||[])],historyRestores,historyDeletes);
  const deleted = new Set(historyDeletedIds);
  const historyMap = new Map();
  [...first.history, ...second.history].forEach((entry) => {
    const existing = historyMap.get(entry.id);
    if (!existing) historyMap.set(entry.id, entry);
    else if (historyEntryStamp(entry) >= historyEntryStamp(existing)) historyMap.set(entry.id, {
      ...entry,
      attachments: ServiceModel.preserveInvoiceFiles(entry.attachments,existing.attachments),
      appointmentId:entry.appointmentId||existing.appointmentId,
      invoiceExpectation: entry.invoiceExpectation || existing.invoiceExpectation,
      kmAcknowledgments: ServiceModel.kmAcknowledgments([...(existing.kmAcknowledgments||[]),...(entry.kmAcknowledgments||[])].filter((v,i,a)=>a.findLastIndex(x=>x.signature===v.signature)===i)),
      reviewJournal: entry.reviewJournal?.length ? entry.reviewJournal : existing.reviewJournal
    });
  });
  const history = [...historyMap.values()]
    .filter((entry) => !deleted.has(entry.id))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)))
    .slice(0, MAX_HISTORY);
  const historyCorrectedAt = [first.historyCorrectedAt || "", second.historyCorrectedAt || ""].sort().at(-1);
  const odometerFloorKm = Math.max(Number(first.odometerFloorKm) || 0, Number(second.odometerFloorKm) || 0);
  const derived = correctedMetrics(history, odometerFloorKm);
  const lastServiceKm = historyCorrectedAt
    ? derived.lastServiceKm
    : Math.max(first.lastServiceKm, second.lastServiceKm, ...history.filter((entry) => entry.type === "service" && entry.oilChanged).map((entry) => entry.km), 0);
  return normalizeBike({
    ...latest,
    historyRestores,historyDeletes,
    serviceAppointments:OperationsModel.appointments([...(first.serviceAppointments||[]),...(second.serviceAppointments||[])]),
    nextServiceNotes:OperationsModel.nextServiceNotes([...(first.nextServiceNotes||[]),...(second.nextServiceNotes||[])]),
    lastServiceKm,
    currentKm: historyCorrectedAt ? derived.currentKm : Math.max(first.currentKm, second.currentKm, lastServiceKm),
    nextServiceKm: lastServiceKm + latest.intervalKm,
    lastCheckedAt: historyCorrectedAt ? derived.lastCheckedAt : [first.lastCheckedAt || "", second.lastCheckedAt || ""].sort().at(-1),
    createdAt: [first.createdAt, second.createdAt].filter(Boolean).sort()[0],
    updatedAt: [first.updatedAt, second.updatedAt].filter(Boolean).sort().at(-1),
    history,
    historyDeletedIds,
    historyCorrectedAt,
    odometerFloorKm
  });
}

function mergeFleets(first, second) {
  const map = new Map();
  first.bikes.forEach((bike) => map.set(bike.id, bike));
  second.bikes.forEach((bike) => map.set(bike.id, map.has(bike.id) ? mergeBike(map.get(bike.id), bike) : bike));
  if (map.size > MAX_BIKES) throw new Error("Έχει συμπληρωθεί το όριο των 40 μηχανών.");
  return { bikes: [...map.values()] };
}

async function activeArchivedBikeIds(env) {
  try {
    const result = await env.DB.prepare("SELECT bike_id FROM vehicle_archives WHERE active=1").all();
    return new Set((result.results || []).map((row) => String(row.bike_id)));
  } catch {
    // A first request against an older database can arrive while the additive
    // workforce schema is being initialized. Treat it as an empty archive.
    return new Set();
  }
}

async function hideArchivedBikes(env, fleet) {
  const archived = await activeArchivedBikeIds(env);
  if (!archived.size) return fleet;
  return { bikes: (fleet?.bikes || []).filter((bike) => !archived.has(String(bike.id))) };
}

async function readSnapshot(env) {
  const row = await env.DB.prepare("SELECT version, data, source, updated_at FROM fleet_snapshot WHERE id = 1").first();
  let data = { bikes: [] };
  data = JSON.parse(row?.data || '{"bikes":[]}');
  if (!Array.isArray(data.bikes)) throw new Error("Invalid canonical fleet snapshot");
  data = await hideArchivedBikes(env, data);
  return {
    version: Number(row?.version || 0),
    source: row?.source || "canonical",
    updatedAt: row?.updated_at || "",
    data
  };
}

async function writeSnapshot(env, fleet, source, requestedVersion) {
  if (source === "backup-restore") fleet = normalizeFleet(fleet);
  const current = await env.DB.prepare("SELECT version FROM fleet_snapshot WHERE id = 1").first();
  const version = Math.max(Number(current?.version || 0) + 1, cleanInteger(requestedVersion, 0, Number.MAX_SAFE_INTEGER, 0));
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE fleet_snapshot SET version = ?, data = ?, source = ?, updated_at = ? WHERE id = 1")
    .bind(version, JSON.stringify(fleet), source, now).run();
  return { version, source, updatedAt: now, data: fleet };
}

async function writeServiceReviewSnapshot(env, fleet, source, expectedVersion) {
  const version = expectedVersion + 1;
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE fleet_snapshot SET version = ?, data = ?, source = ?, updated_at = ? WHERE id = 1 AND version = ?")
    .bind(version, JSON.stringify(fleet), source, now, expectedVersion).run();
  return Number(result.meta?.changes || 0) > 0 ? { version, source, updatedAt: now, data: fleet } : null;
}

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM fleet_settings WHERE key = ?").bind(key).first();
  return row?.value ?? "";
}

async function setSetting(env, key, value) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO fleet_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE fleet_settings.value <> excluded.value")
    .bind(key, String(value), now).run();
}

async function sha256(value) {
  return digestHex(new TextEncoder().encode(value));
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([sha256(String(left)), sha256(String(right))]);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return mismatch === 0;
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pinHash(env, pin, salt) {
  return sha256(`${env.PIN_PEPPER || ""}:${salt}:${pin}`);
}

async function serverAuthorized(request, env) {
  const supplied = request.headers.get("x-fleet-server-key") || "";
  return Boolean(supplied && env.SERVER_KEY && await secureEqual(supplied, env.SERVER_KEY));
}

async function clientAuthorized(request, env) {
  const supplied = request.headers.get("x-fleet-client-key") || "";
  return Boolean(supplied && env.CLIENT_KEY && await secureEqual(supplied, env.CLIENT_KEY));
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const item of cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return "";
}

async function sessionAuthorized(request, env) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const token = bearer || cookieValue(request, "fc_session");
  if (!token) return false;
  const hash = await sha256(`${env.PIN_PEPPER || ""}:session:${token}`);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT expires_at FROM fleet_sessions WHERE token_hash = ?").bind(hash).first();
  return Boolean(row && Number(row.expires_at) > now);
}

async function canEdit(request, env) {
  return await serverAuthorized(request, env) || await authorizedFor(request, env, "fleet.manage");
}

function isManagementActor(actor) {
  return Boolean(actor && ["owner", "manager", "fleet_manager", "payroll_manager"].includes(String(actor.role || "")));
}

async function requestFingerprint(request, env) {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  return sha256(`${env.PIN_PEPPER || ""}:ip:${address}`);
}

async function verifyPin(request, env, suppliedPin) {
  const pin = cleanText(suppliedPin, 8);
  if (!/^\d{4,6}$/.test(pin)) return { ok: false, blocked: false };
  const fingerprint = await requestFingerprint(request, env);
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare("SELECT attempts, window_started, blocked_until FROM fleet_pin_attempts WHERE fingerprint = ?")
    .bind(fingerprint).first();
  if (attempt && Number(attempt.blocked_until) > now) return { ok: false, blocked: true };
  const salt = await getSetting(env, "pin_salt");
  const expected = await getSetting(env, "pin_hash");
  if (salt && expected && await secureEqual(await pinHash(env, pin, salt), expected)) {
    await env.DB.prepare("DELETE FROM fleet_pin_attempts WHERE fingerprint = ?").bind(fingerprint).run();
    return { ok: true, blocked: false };
  }
  const inWindow = attempt && now - Number(attempt.window_started) <= PIN_WINDOW_SECONDS;
  const attempts = inWindow ? Number(attempt.attempts) + 1 : 1;
  const windowStarted = inWindow ? Number(attempt.window_started) : now;
  const blockedUntil = attempts >= PIN_MAX_ATTEMPTS ? now + PIN_WINDOW_SECONDS : 0;
  await env.DB.prepare("INSERT INTO fleet_pin_attempts (fingerprint, attempts, window_started, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET attempts = excluded.attempts, window_started = excluded.window_started, blocked_until = excluded.blocked_until")
    .bind(fingerprint, attempts, windowStarted, blockedUntil).run();
  return { ok: false, blocked: blockedUntil > now };
}

async function changePin(env, pin) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("Το PIN πρέπει να έχει 4 έως 6 αριθμούς.");
  const salt = randomToken(18);
  const hash = await pinHash(env, pin, salt);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fleet_settings (key, value, updated_at) VALUES ('pin_salt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(salt, now),
    env.DB.prepare("INSERT INTO fleet_settings (key, value, updated_at) VALUES ('pin_hash', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(hash, now),
    env.DB.prepare("DELETE FROM fleet_pin_attempts"),
    env.DB.prepare("DELETE FROM fleet_sessions")
  ]);
}

async function statusResponse(env) {
  const now = Date.now();
  if (statusResponseCache.db === env.DB && statusResponseCache.value && statusResponseCache.expiresAt > now) {
    return json(statusResponseCache.value);
  }
  const [lastSeen, pinHashValue, snapshot, latestClient, activeWeb, users, activeShifts, openAlerts, pwaSeen, lastBackup] = await Promise.all([
    getSetting(env, "server_last_seen"),
    getSetting(env, "pin_hash"),
    snapshotSummary(env),
    env.DB.prepare("SELECT version, created_at, size_bytes FROM fleet_releases WHERE kind = 'client' AND active = 1 LIMIT 1").first(),
    env.DB.prepare("SELECT version, created_at FROM fleet_releases WHERE kind = 'web' AND active = 1 LIMIT 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE active=1").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM shifts WHERE status='active'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM system_alerts WHERE resolved=0").first(),
    env.DB.prepare("SELECT MAX(last_seen_at) AS value FROM registered_devices WHERE platform IN ('ios','web')").first(),
    getSetting(env, "server_last_backup")
  ]);
  const ageMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Number.POSITIVE_INFINITY;
  const pwaAgeMs = pwaSeen?.value ? Date.now() - new Date(pwaSeen.value).getTime() : Number.POSITIVE_INFINITY;
  const payload = {
    serverOnline: ageMs >= 0 && ageMs < SERVER_HEARTBEAT_GRACE_MS,
    lastSeen: lastSeen || null,
    pinConfigured: Boolean(pinHashValue),
    snapshotVersion: snapshot.version,
    snapshotUpdatedAt: snapshot.updatedAt || null,
    snapshotSource: snapshot.source,
    bikes: snapshot.bikes,
    databaseOk: true,
    storageOk: Boolean(env.RELEASES),
    fleetControlOk: true,
    watchdogActive: ageMs >= 0 && ageMs < SERVER_HEARTBEAT_GRACE_MS,
    users: Number(users?.count || 0),
    activeShifts: Number(activeShifts?.count || 0),
    pendingAlerts: Number(openAlerts?.count || 0),
    pwaConnected: pwaAgeMs >= 0 && pwaAgeMs < 5 * 60_000,
    pwaLastSeen: pwaSeen?.value || null,
    lastBackup: lastBackup || null,
    clientRelease: latestClient || null,
    webRelease: activeWeb || null
  };
  // This endpoint is polled by the portal every 30 seconds. A five-second
  // isolate-local cache removes duplicate dashboard/status bursts while the
  // values remain effectively real-time for monitoring.
  statusResponseCache = { value: payload, expiresAt: now + STATUS_RESPONSE_CACHE_MS, db: env.DB };
  return json(payload);
}

async function mayViewFleet(request, env) {
  return await serverAuthorized(request, env) || await authorizedFor(request, env, "fleet.view");
}

async function snapshotResponse(request, env) {
  if (!await mayViewFleet(request, env)) return json({ error: "Χρειάζεται σύνδεση για την προβολή του στόλου." }, 401);
  const sinceVersion = new URL(request.url).searchParams.get("sinceVersion");
  if (sinceVersion !== null) {
    const summary = await snapshotSummary(env);
    if (String(summary.version) === sinceVersion) return json({ unchanged: true, version: summary.version });
  }
  const row = await visibleSnapshotRow(env);
  return snapshotJsonResponse(row, { updatedAt: row?.updated_at || "", archivedBikeIds: [...await activeArchivedBikeIds(env)] });
}

function snapshotJsonResponse(row, extra = {}) {
  const metadata = JSON.stringify({ version: Number(row?.version || 0), source: row?.source || "canonical", ...extra });
  return new Response('{"bikes":' + (row?.bikes_json || '[]') + ',' + metadata.slice(1), {
    headers: baseHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" })
  });
}

async function legacySyncGet(request, env) {
  if (!await mayViewFleet(request, env)) return json({ error: "Χρειάζεται σύνδεση για την προβολή του στόλου." }, 401);
  const sinceVersion = new URL(request.url).searchParams.get("sinceVersion");
  if (sinceVersion !== null) {
    const summary = await snapshotSummary(env);
    if (String(summary.version) === sinceVersion) return json({unchanged:true,version:summary.version});
  }
  const row = await visibleSnapshotRow(env);
  const archivedBikeIds = [...await activeArchivedBikeIds(env)];
  return snapshotJsonResponse(row, { archivedBikeIds, serverTime: new Date().toISOString() });
}

async function syncSingleBike(request, env, serverOnly) {
  const fromServer = await serverAuthorized(request, env);
  if (serverOnly && !fromServer) return json({ error: "Μη έγκυρος server." }, 401);
  let actor = null, pinUsed = false;
  if (!fromServer) {
    try { actor = await authenticateExternal(request, env, "fleet.manage"); }
    catch { return json({ error: "Δεν επιτρέπεται. Συνδέσου με λογαριασμό διαχείρισης." }, 401); }
    if (!isManagementActor(actor)) {
      const pin = await verifyPin(request, env, cleanText(request.headers.get("x-admin-pin"), 8));
      if (!pin.ok) return json({ error: pin.blocked ? "Πολλές προσπάθειες PIN. Δοκίμασε αργότερα." : "Το δεύτερο Admin PIN δεν είναι σωστό." }, pin.blocked ? 429 : 403);
      pinUsed = true;
    }
  }
  const body = await request.json();
  const incoming = normalizeBike(body?.bike);
  if (!incoming) return json({ error: "Μη έγκυρα στοιχεία μηχανής." }, 400);
  if ((await activeArchivedBikeIds(env)).has(incoming.id)) return json({ error: "Η μηχανή έχει αρχειοθετηθεί.", code: "bike_archived" }, 409);
  for (let attempt=0; attempt<5; attempt++) {
    const located = await readSnapshotBike(env, incoming.id);
    const bike = located ? mergeBike(located.bike, incoming) : incoming;
    const corrected = incoming.historyCorrectedAt && incoming.historyCorrectedAt > String(located?.bike.historyCorrectedAt || "");
    if (corrected) {
      bike.odometerFloorKm = await workforceOdometerFloor(env, incoming.id);
      Object.assign(bike, normalizeBike(bike));
    }
    if (located && JSON.stringify(bike) === located.json) {
      if (fromServer) await touchServer(env);
      return json({ saved: true, unchanged: true, bike, version: located.version });
    }
    if (!located && (await snapshotSummary(env)).bikes >= MAX_BIKES) return json({ error: "Έχει συμπληρωθεί το όριο των 40 μηχανών." }, 409);
    const now = new Date().toISOString();
    const version = await writeSnapshotBike(env, located, bike, fromServer ? "canonical" : "provisional", now);
    if (!version) continue;
    if (fromServer) await touchServer(env);
    else {
      const operationId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO fleet_operations (id, source, type, payload, status, created_at) VALUES (?, 'authenticated-client', 'snapshot_merge', ?, 'pending', ?)")
        .bind(operationId, JSON.stringify({ bikes: [bike] }), now).run();
      if (corrected) await env.DB.prepare(`INSERT INTO vehicle_registry (bike_id,name,odometer,status,version,updated_at)
        VALUES (?,?,?,'available',1,?) ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,
        odometer=excluded.odometer,version=vehicle_registry.version+1,updated_at=excluded.updated_at`).bind(bike.id,bike.name,bike.currentKm,now).run();
      await recordExternalAudit(env, request, actor, "fleet_snapshot_merged", "fleet", bike.id,
        { version: located?.version || 0 }, { version, changed: [{ id: bike.id, name: bike.name, odometer: bike.currentKm, lastServiceKm: bike.lastServiceKm }] },
        "Επιβεβαιωμένη αλλαγή από Fleet Control", pinUsed);
    }
    return json({ saved: true, bike, version, updatedAt: now });
  }
  return json({ error: "Η μηχανή ενημερώθηκε ταυτόχρονα. Δοκίμασε ξανά.", code: "snapshot_conflict" }, 409);
}

async function legacySyncPost(request, env) {
  const fromServer = await serverAuthorized(request, env);
  let actor = null;
  let pinUsed = false;
  if (!fromServer) {
    try {
      actor = await authenticateExternal(request, env, "fleet.manage");
    } catch {
      return json({ error: "Δεν επιτρέπεται. Συνδέσου με λογαριασμό διαχείρισης." }, 401);
    }
    if (!isManagementActor(actor)) {
      const pinResult = await verifyPin(request, env, cleanText(request.headers.get("x-admin-pin"), 8));
      if (!pinResult.ok) {
        return json({
          error: pinResult.blocked ? "Πολλές προσπάθειες PIN. Δοκίμασε αργότερα." : "Το δεύτερο Admin PIN δεν είναι σωστό."
        }, pinResult.blocked ? 429 : 403);
      }
      pinUsed = true;
    }
  }
  const incoming = await hideArchivedBikes(env, normalizeFleet(await request.json()));
  const current = await readSnapshot(env);
  const provisional = mergeFleets(current.data, incoming);
  const correctedBikes = [];
  for (const incomingBike of incoming.bikes) {
    const currentBike = current.data.bikes.find((bike) => bike.id === incomingBike.id);
    if (!incomingBike.historyCorrectedAt || incomingBike.historyCorrectedAt <= String(currentBike?.historyCorrectedAt || "")) continue;
    const index = provisional.bikes.findIndex((bike) => bike.id === incomingBike.id);
    if (index < 0) continue;
    provisional.bikes[index].odometerFloorKm = await workforceOdometerFloor(env, incomingBike.id);
    provisional.bikes[index] = normalizeBike(provisional.bikes[index]);
    correctedBikes.push(provisional.bikes[index]);
  }
  if (JSON.stringify(provisional) === JSON.stringify(current.data)) {
    return json({ bikes: current.data.bikes, archivedBikeIds: [...await activeArchivedBikeIds(env)], queued: false, unchanged: true, version: current.version, serverTime: new Date().toISOString() });
  }
  const stored = await writeSnapshot(env, provisional, "provisional");
  const operationId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fleet_operations (id, source, type, payload, status, created_at) VALUES (?, ?, 'snapshot_merge', ?, 'pending', ?)")
    .bind(operationId, fromServer ? "android-server" : "authenticated-client", JSON.stringify(incoming), new Date().toISOString()).run();
  if (correctedBikes.length) {
    const correctedAt = new Date().toISOString();
    await env.DB.batch(correctedBikes.map((bike) => env.DB.prepare(`INSERT INTO vehicle_registry
      (bike_id,name,odometer,status,version,updated_at) VALUES (?,?,?,'available',1,?)
      ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,odometer=excluded.odometer,
      version=vehicle_registry.version+1,updated_at=excluded.updated_at`)
      .bind(bike.id, bike.name, bike.currentKm, correctedAt)));
  }
  if (actor) {
    const before = new Map((current.data.bikes || []).map((bike) => [String(bike.id), bike]));
    const changed = (provisional.bikes || []).filter((bike) => JSON.stringify(before.get(String(bike.id)) || null) !== JSON.stringify(bike))
      .map((bike) => ({ id: bike.id, name: bike.name, odometer: bike.currentKm, lastServiceKm: bike.lastServiceKm })).slice(0, MAX_BIKES);
    await recordExternalAudit(env, request, actor, "fleet_snapshot_merged", "fleet", "main",
      { version: current.version, bikes: current.data.bikes.length }, { version: stored.version, bikes: provisional.bikes.length, changed },
      "Επιβεβαιωμένη αλλαγή από Fleet Control", pinUsed);
  }
  return json({ bikes: provisional.bikes, archivedBikeIds: [...await activeArchivedBikeIds(env)], queued: true, operationId, version: stored.version, serverTime: new Date().toISOString() });
}

function ensureLegacyOilHistory(bike, now) {
  const history = Array.isArray(bike.history) ? bike.history : [];
  if (history.some((entry) => entry.type === "service" && entry.oilChanged)) return;
  const previousKm = cleanInteger(bike.lastServiceKm, 0, 2_000_000_000, 0);
  if (!previousKm) return;
  const createdDate = strictCalendarDate(String(bike.createdAt || "").slice(0, 10)) || new Date().toISOString().slice(0, 10);
  history.push({
    id: crypto.randomUUID(),
    type: "service",
    km: previousKm,
    date: createdDate,
    notes: "Ιστορικό τελευταίας αλλαγής λαδιών",
    tasks: ["Ιστορικό τελευταίας αλλαγής λαδιών"],
    workshop: "",
    oilChanged: true,
    createdAt: now,
    updatedAt: now
  });
  bike.history = history;
}

async function workforceOdometerFloor(env, bikeId) {
  const row = await env.DB.prepare(`SELECT MAX(km) AS km FROM (
    SELECT initial_km AS km FROM vehicle_segments WHERE vehicle_id=?
    UNION ALL
    SELECT final_km AS km FROM vehicle_segments WHERE vehicle_id=? AND final_km IS NOT NULL
  )`).bind(bikeId, bikeId).first();
  return cleanInteger(row?.km, 0, 2_000_000_000, 0);
}

async function fleetHistoryAction(request, env, rawBikeId, rawEntryId, action) {
  let actor;
  try {
    actor = await authenticateExternal(request, env, "fleet.manage");
  } catch (error) {
    return json({ error: error?.message || "Δεν επιτρέπεται.", code: error?.code || "forbidden" }, Number(error?.status) || 401);
  }
  if (!isManagementActor(actor)) return json({ error: "Η διόρθωση ιστορικού επιτρέπεται μόνο σε λογαριασμό διαχείρισης." }, 403);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: "Τα δεδομένα της αλλαγής δεν είναι έγκυρα." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Τα δεδομένα της αλλαγής δεν είναι έγκυρα." }, 400);
  const bikeId = cleanText(rawBikeId, 100);
  const entryId = cleanText(rawEntryId, 100);
  if (!bikeId || !entryId) return json({ error: "Η καταχώρηση δεν είναι έγκυρη." }, 400);
  if (entryId.startsWith("shift-")) {
    return json({ error: "Η καταχώρηση προέρχεται από βάρδια. Διόρθωσέ την από τη Διαχείριση Βαρδιών.", code: "shift_history_managed" }, 409);
  }

  const located=await readSnapshotBike(env,bikeId);
  if(!located||(await activeArchivedBikeIds(env)).has(bikeId))return json({error:'Το ενεργό μηχανάκι δεν βρέθηκε.'},404);
  const bike=JSON.parse(JSON.stringify(located.bike));
  bike.history = Array.isArray(bike.history) ? bike.history : [];
  bike.historyDeletedIds = normalizeDeletedHistoryIds(bike.historyDeletedIds);
  const entryIndex = bike.history.findIndex((entry) => String(entry.id) === entryId);
  if (entryIndex < 0) {
    if (action === "delete" && bike.historyDeletedIds.includes(entryId)) {
      return json({ deleted: true, unchanged: true, bike: normalizeBike(bike), version: located.version });
    }
    return json({ error: "Η καταχώρηση δεν βρέθηκε ή έχει ήδη διαγραφεί." }, 404);
  }
  const oldEntry = JSON.parse(JSON.stringify(bike.history[entryIndex]));
  if(body.expectedEntryUpdatedAt!==undefined&&String(body.expectedEntryUpdatedAt)!==String(oldEntry.updatedAt||''))return json({error:'Η καταχώρηση άλλαξε. Άνοιξε ξανά τον έλεγχο.'},409);
  if(body.impactToken){const floor=await workforceOdometerFloor(env,bikeId);if(!located||body.impactToken!==await impactToken(located.json,action,entryId,body,floor))return json({error:'Το ιστορικό άλλαξε. Άνοιξε ξανά την προεπισκόπηση.'},409);}

  const now = new Date(Math.max(Date.now(),Date.parse(bike.updatedAt||'')+1||0)).toISOString();
  const recycleId = action === "delete" ? crypto.randomUUID() : null;
  ensureLegacyOilHistory(bike, now);

  if (action === "edit") {
    const parsedKm = Math.round(Number(body.km));
    const km = Number.isFinite(parsedKm) && parsedKm >= 0 && parsedKm <= 2_000_000_000 ? parsedKm : -1;
    const date = strictCalendarDate(body.date);
    if (km < 0 || body.km === "" || body.km == null) return json({ error: "Γράψε σωστά τα χιλιόμετρα." }, 400);
    if (!date) return json({ error: "Διάλεξε σωστή ημερομηνία." }, 400);
    const updated = {
      ...oldEntry,
      id: entryId,
      type: oldEntry.type === "check" ? "check" : "service",
      km,
      date,
      createdAt: isoDateTime(oldEntry.createdAt, now),
      updatedAt: now
    };
    if (updated.type === "service") {
      let tasks = Array.isArray(body.tasks)
        ? [...new Set(body.tasks.map((task) => cleanText(task, 500)).filter(Boolean))].slice(0, 5120)
        : [];
      tasks = body.oilChanged === true
        ? ["Αλλαγή λαδιών", ...tasks.filter((task) => task !== "Αλλαγή λαδιών")].slice(0, 5120)
        : tasks.filter((task) => task !== "Αλλαγή λαδιών");
      const majorService = body.majorService === true || tasks.some((task) => /μεγάλ(?:ο|ου)\s+(?:σέρβις|service)/i.test(task));
      tasks = majorService
        ? ["Μεγάλο service", ...tasks.filter((task) => task !== "Μεγάλο service")].slice(0, 5120)
        : tasks.filter((task) => task !== "Μεγάλο service");
      if (!tasks.length) return json({ error: "Διάλεξε ή γράψε τουλάχιστον μία εργασία." }, 400);
      updated.tasks = tasks;
      updated.notes = tasks.join("\n");
      updated.workshop = cleanText(body.workshop, 120);
      updated.cost = cleanText(body.cost, 60);
      updated.oilChanged = body.oilChanged === true;
      updated.majorService = majorService;
      updated.majorServiceMilestoneKm = majorService ? km : 0;
    } else {
      updated.tasks = [];
      updated.notes = "";
      updated.workshop = "";
      updated.oilChanged = false;
      updated.majorService = false;
      updated.majorServiceMilestoneKm = 0;
    }
    bike.history[entryIndex] = updated;
  } else {
    if (body.confirmDelete !== true) return json({ error: "Χρειάζεται επιβεβαίωση διαγραφής." }, 400);
    bike.historyDeletes=OperationsModel.mergeLifecycle(bike.historyDeletes,[{id:entryId,at:now}]);
    bike.history.splice(entryIndex, 1);
    bike.historyDeletedIds = [...new Set([entryId, ...bike.historyDeletedIds])].slice(0, MAX_HISTORY);
  }

  bike.historyCorrectedAt = now;
  bike.updatedAt = now;
  bike.odometerFloorKm = await workforceOdometerFloor(env, bikeId);
  const normalizedBike = normalizeBike(bike);
  const reason = cleanText(body.reason, 500) || (action === "delete" ? "Διαγραφή λανθασμένης καταχώρησης" : "Διόρθωση καταχώρησης ιστορικού");
  let version;
  if(action==='delete'){
    const path=`$.bikes[${located.index}]`;
    const archive=env.DB.prepare(`INSERT INTO deleted_records
      (id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name,reason)
      SELECT ?,'fleet_history',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM fleet_snapshot WHERE id=1 AND json_extract(data,?)=?)
      AND NOT EXISTS(SELECT 1 FROM vehicle_archives WHERE active=1 AND bike_id=?)`)
      .bind(recycleId,`${bikeId}:${entryId}`,`${bike.name} • ${oldEntry.type==='service'?'Service':'Έλεγχος χιλιομέτρων'}`,JSON.stringify({bikeId,bikeName:bike.name,entry:oldEntry}),now,String(actor.user_id||actor.id||''),cleanText(actor.full_name||actor.fullName||'',120),reason,path,located.json,bikeId);
    const update=env.DB.prepare(`UPDATE fleet_snapshot SET data=json_set(data,?,json(?)),version=version+1,source=?,updated_at=? WHERE id=1 AND json_extract(data,?)=? AND EXISTS(SELECT 1 FROM deleted_records WHERE id=?) AND NOT EXISTS(SELECT 1 FROM vehicle_archives WHERE active=1 AND bike_id=?)`)
      .bind(path,JSON.stringify(normalizedBike),'admin-history-delete',now,path,located.json,recycleId,bikeId);
    const results=await env.DB.batch([archive,update]);
    version=Number(results[1]?.meta?.changes)?Number((await env.DB.prepare('SELECT version FROM fleet_snapshot WHERE id=1').first()).version):0;
  }else version=await writeSnapshotBike(env,located,normalizedBike,'admin-history-edit',now);
  if(!version)return json({error:'Έγινε άλλη αλλαγή ταυτόχρονα. Άνοιξε ξανά την καταχώρηση.'},409);
  const operationId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(`INSERT INTO vehicle_registry (bike_id,name,odometer,status,version,updated_at)
      VALUES (?,?,?,'available',1,?) ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,
      odometer=excluded.odometer,version=vehicle_registry.version+1,updated_at=excluded.updated_at`)
      .bind(normalizedBike.id, normalizedBike.name, normalizedBike.currentKm, now),
    env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) VALUES (?,'authenticated-client','snapshot_replace_bike',?,'pending',?)")
      .bind(operationId, JSON.stringify({ bike: normalizedBike }), now)
  ];
  await env.DB.batch(statements);
  await recordExternalAudit(env, request, actor, action === "delete" ? "fleet_history_entry_deleted" : "fleet_history_entry_edited",
    "fleet_history", `${bikeId}:${entryId}`, oldEntry, action === "delete" ? { recycleId } : normalizedBike.history.find((entry) => entry.id === entryId), reason, false);
  return json({
    updated: action === "edit",
    deleted: action === "delete",
    recycleId,
    bike: normalizedBike,
    version,
    operationId
  });
}

async function restoreFleetHistoryEntries(env, requestedEntries) {
  const records=Array.isArray(requestedEntries)?requestedEntries.slice(0,MAX_HISTORY):[];const changed=[];let restored=0,version=0;
  const archived=await activeArchivedBikeIds(env);
  for(const record of records){
    const bikeId=cleanText(record?.bikeId,100),entry=record?.entry&&normalizeHistory([record.entry])[0];if(!entry||archived.has(bikeId))continue;
    const located=await readSnapshotBike(env,bikeId);if(!located)continue;const bike=located.bike;
    const existing=(bike.history||[]).find(e=>String(e.id)===entry.id);
    if(existing){if(OperationsModel.lifecycle(bike.historyRestores).some(r=>r.id===entry.id)){restored++;changed.push(normalizeBike(bike));}continue;}
    if(record.expectedBikeUpdatedAt!==undefined&&record.expectedBikeUpdatedAt!==bike.updatedAt)throw Object.assign(new Error('Το ιστορικό άλλαξε. Άνοιξε ξανά την προεπισκόπηση.'),{status:409});
    if((bike.history||[]).length>=MAX_HISTORY)throw Object.assign(new Error('Το ιστορικό έχει 500 καταχωρήσεις. Η ανάκτηση δεν αφαίρεσε παλιές εγγραφές.'),{status:409});
    const now=new Date(Math.max(Date.now(),Date.parse(bike.updatedAt||'')+1||0)).toISOString();
    ensureLegacyOilHistory(bike,now);
    bike.historyRestores=OperationsModel.mergeLifecycle(bike.historyRestores,[{id:entry.id,at:now}]);bike.historyDeletedIds=normalizeDeletedHistoryIds(bike.historyDeletedIds).filter(id=>id!==entry.id);
    bike.history=[{...entry,updatedAt:now},...(bike.history||[])];bike.historyCorrectedAt=now;bike.updatedAt=now;bike.odometerFloorKm=await workforceOdometerFloor(env,bikeId);
    const normalized=normalizeBike(bike);version=await writeSnapshotBike(env,located,normalized,'service-trash-restore',now);
    if(!version)throw Object.assign(new Error('Έγινε άλλη αλλαγή ταυτόχρονα. Ανανέωσε την προεπισκόπηση.'),{status:409});
    await env.DB.prepare(`INSERT INTO vehicle_registry (bike_id,name,odometer,status,version,updated_at) VALUES (?,?,?,'available',1,?) ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,odometer=MAX(vehicle_registry.odometer,excluded.odometer),version=vehicle_registry.version+1,updated_at=excluded.updated_at`).bind(normalized.id,normalized.name,normalized.currentKm,now).run();
    await queueBike(env,normalized,now);changed.push(normalized);restored++;
  }
  return {restored,bikes:changed,version};
}

async function login(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const pin = cleanText(request.headers.get("x-fleet-pin") || body.pin, 8);
  const result = await verifyPin(request, env, pin);
  if (!result.ok) return json({ error: result.blocked ? "Πολλές προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά." : "Το PIN δεν είναι σωστό.", blocked: result.blocked }, result.blocked ? 429 : 401);
  const token = randomToken();
  const hash = await sha256(`${env.PIN_PEPPER || ""}:session:${token}`);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO fleet_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(hash, now, now + SESSION_SECONDS).run();
  return json({ unlocked: true, token, expiresAt: now + SESSION_SECONDS }, 200, {
    "Set-Cookie": `fc_session=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
  });
}

async function logout(request, env) {
  const token = cookieValue(request, "fc_session") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token) {
    const hash = await sha256(`${env.PIN_PEPPER || ""}:session:${token}`);
    await env.DB.prepare("DELETE FROM fleet_sessions WHERE token_hash = ?").bind(hash).run();
  }
  return json({ loggedOut: true }, 200, { "Set-Cookie": "fc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" });
}

async function updatePin(request, env) {
  const fromServer = await serverAuthorized(request, env);
  let actor = null;
  if (!fromServer) {
    try {
      actor = await authenticateExternal(request, env, "security.manage");
    } catch {
      return json({ error: "Δεν επιτρέπεται." }, 401);
    }
  }
  const body = await request.json();
  const pin = cleanText(body.pin, 8);
  if (!fromServer && !isManagementActor(actor)) {
    const verification = await verifyPin(request, env, request.headers.get("x-admin-pin") || body.currentPin);
    if (!verification.ok) {
      return json({ error: verification.blocked ? "Πολλές προσπάθειες PIN. Δοκίμασε αργότερα." : "Το τρέχον Admin PIN δεν είναι σωστό." }, verification.blocked ? 429 : 403);
    }
  }
  await changePin(env, pin);
  return json({ changed: true });
}

async function submitOperation(request, env) {
  if (!await canEdit(request, env)) return json({ error: "Δεν επιτρέπεται." }, 401);
  const body = await request.json();
  const type = cleanText(body.type, 40);
  if (!type) return json({ error: "Λείπει ο τύπος ενέργειας." }, 400);
  const id = cleanText(body.id, 100) || crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO fleet_operations (id, source, type, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(id, await clientAuthorized(request, env) ? "android-client" : "web", type, JSON.stringify(body.payload || {}), new Date().toISOString()).run();
  return json({ queued: true, id }, 202);
}

async function requestBackup(request, env) {
  if (!await serverAuthorized(request, env) && !await authorizedFor(request, env, "backup.manage") && !await authorizedFor(request, env, "fleet.manage")) {
    return json({ error: "Δεν επιτρέπεται." }, 401);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fleet_operations (id, source, type, payload, status, created_at) VALUES (?, 'android-client', 'backup_request', '{}', 'pending', ?)")
    .bind(id, new Date().toISOString()).run();
  return json({ queued: true, id }, 202);
}

async function touchServer(env) {
  // SQL CAS coalesces pulse, exchange and action touches across all isolates.
  // One persisted timestamp per minute stays safely inside the seven-minute grace.
  const at=new Date().toISOString();
  await env.DB.prepare("INSERT INTO fleet_settings(key,value,updated_at) VALUES('server_last_seen',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE julianday(fleet_settings.value)<julianday(excluded.value,'-60 seconds')").bind(at,at).run();
}

// Lightweight connection checks avoid parsing the complete fleet snapshot
// and counting workforce tables while a bulk invoice read is running.
async function serverConnectionCheck(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const seen = await getSetting(env, "server_last_seen");
  const age = seen ? Date.now() - Date.parse(seen) : Infinity;
  return json({ ok: true, databaseOk: true, storageOk: Boolean(env.RELEASES), serverOnline: age >= 0 && age < SERVER_HEARTBEAT_GRACE_MS, serverTime: new Date().toISOString() });
}

async function serverPulse(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  await touchServer(env);
  return json({ online: true, serverTime: new Date().toISOString() });
}

async function serverPreparedReport(request,env){
 if(!await authorizedFor(request,env,'fleet.view'))return json({error:'Χρειάζεται πρόσβαση στον στόλο.'},401);
 const summary=await snapshotSummary(env),raw=await getSetting(env,'server_prepared_report');let report=null;try{report=raw?JSON.parse(raw):null;}catch{}
 const stale=!report||Number(report.snapshotVersion)!==Number(summary.version);
 return json({ok:true,ready:Boolean(report)&&!stale,stale,snapshotVersion:summary.version,report:stale?null:report,message:stale?'Ο Server ετοιμάζει τον έλεγχο της τρέχουσας έκδοσης. Δοκίμασε Ανανέωση σε λίγο.':''});
}
// One network round trip, with raw snapshot JSON and bounded queues.
async function serverExchange(request,env){
 if(!await serverAuthorized(request,env))return json({error:'Μη έγκυρος Server.'},401);
 const body=await request.json(),internal=(path,method='GET',data)=>new Request(new URL(path,request.url),{method,headers:request.headers,...(data?{body:JSON.stringify(data)}:{})});
 await serverHeartbeat(internal('/api/server/heartbeat','POST',body),env);await setSetting(env,'server_offload_protocol','1');
 const ids=Array.isArray(body.acknowledgements)?body.acknowledgements.map(id=>cleanText(id,100)).filter(Boolean).slice(0,100):[];
 if(ids.length)await serverAck(internal('/api/server/ack','POST',{ids}),env);
 if(body.progress?.jobId)await serverOperationProgress(internal('/api/server/operation-progress','POST',{...body.progress,lightweight:true}),env);
 const knownIds=Array.isArray(body.knownJobs)?body.knownJobs.map(id=>cleanText(id,100)).filter(Boolean).slice(0,100):[];let known=[];
 if(knownIds.length){const result=await env.DB.prepare(`SELECT id,status FROM fleet_operations WHERE id IN (${knownIds.map(()=>'?').join(',')})`).bind(...knownIds).all();const map=new Map((result.results||[]).map(r=>[r.id,r.status]));known=knownIds.map(id=>({id,status:map.get(id)||'missing'}));}
 const snapshot=await snapshotResponse(internal('/api/snapshot?sinceVersion='+encodeURIComponent(String(body.sinceVersion??''))),env);
 const sync=await (await serverPending(internal('/api/server/pending?limit=50&queue=sync&combined=1'),env)).json();
 const invoices=await (await serverPending(internal('/api/server/pending?limit=10&queue=invoices&local=1&combined=1'),env)).json();
 const batch=await readInvoiceReprocessBatch(env),status=body.includeStatus?await statusPayload(env):null;
 let reportAccepted=false;
 if(body.preparedReport?.schema===1&&Array.isArray(body.preparedReport.bikes)&&body.preparedReport.bikes.length<=40&&Array.isArray(body.preparedReport.issues)&&body.preparedReport.issues.length<=500){
  const raw=JSON.stringify(body.preparedReport);if(raw.length<=240000){const saved=await env.DB.prepare("INSERT INTO fleet_settings(key,value,updated_at) SELECT 'server_prepared_report',?,? WHERE EXISTS(SELECT 1 FROM fleet_snapshot WHERE id=1 AND version=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(raw,new Date().toISOString(),Number(body.preparedReport.snapshotVersion)).run();reportAccepted=Boolean(saved.meta?.changes);}
 }
 const meta={ok:true,protocol:1,mirrorHead:await mirrorHead(env),reportAccepted,operations:sync.operations,invoices:invoices.operations,knownJobs:known,acknowledged:ids,batch:batch?{...batch,items:undefined}:null,status};
 return new Response('{"snapshot":'+await snapshot.text()+','+JSON.stringify(meta).slice(1),{headers:baseHeaders({'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Fleet-Changed':body.progress?.jobId?'invoices':''})});
}

async function serverPending(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  if(new URL(request.url).searchParams.get("combined")!=="1")await touchServer(env);
  const limit = cleanInteger(new URL(request.url).searchParams.get("limit"), 1, MAX_PENDING, 50);
  const queue = new URL(request.url).searchParams.get("queue");
  const compatibility=new URL(request.url).searchParams.get("local")==="1"?"":" AND json_extract(payload,'$.documentKey') IS NULL";
  const filter = queue === "invoices" ? " AND type IN ('service_document_render','service_document_reprocess_batch') AND NOT (type='service_document_reprocess_batch' AND COALESCE((SELECT json_extract(value,'$.status') FROM fleet_settings WHERE key='service_invoice_reprocess_batch'),'')='paused')"
    : queue === "sync" ? " AND type NOT IN ('service_document_render','service_document_reprocess_batch')" : "";
  const result = await env.DB.prepare("SELECT id, source, type, payload, created_at FROM fleet_operations WHERE status = 'pending'" + filter + compatibility + " AND (json_extract(payload, '$.nextAttemptAt') IS NULL OR json_extract(payload, '$.nextAttemptAt') <= ?) ORDER BY CASE WHEN type='service_document_render' THEN 0 WHEN type='service_document_reprocess_batch' THEN 2 ELSE 1 END,created_at,rowid LIMIT ?")
    .bind(new Date().toISOString(), limit).all();
  const operations = (result.results || []).map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch {}
    return { id: row.id, source: row.source, type: row.type, payload, createdAt: row.created_at };
  });
  return json({ operations, serverTime: new Date().toISOString() });
}

async function serverAck(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json();
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanText(id, 100)).filter(Boolean).slice(0, MAX_PENDING) : [];
  const now = new Date().toISOString();
  if (ids.length) await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE fleet_operations SET status = 'applied', applied_at = ? WHERE id = ? AND status != 'cancelled'").bind(now, id)));
  await env.DB.prepare("DELETE FROM fleet_operations WHERE status = 'applied' AND applied_at < datetime('now', '-30 days')").run();
  await touchServer(env);
  return json({ acknowledged: ids.length });
}

async function serverOperationProgress(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json().catch(() => ({}));
  const jobId = cleanText(body.jobId, 120);
  if (!jobId) return json({ error: "Λείπει η εργασία τιμολογίου." }, 400);
  const row = await env.DB.prepare("SELECT id, type, payload, status FROM fleet_operations WHERE id = ? LIMIT 1").bind(jobId).first();
  if (!row || row.type !== "service_document_render") return json({ error: "Η εργασία τιμολογίου δεν βρέθηκε." }, 404);
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}
  if (row.status === "cancelled") return json({ ok: true, jobId, status: "cancelled", ignored: true });
  const draft=payload.draftId?await readImportDraftForJob(env,jobId):null;
  const located = draft?null:await readServiceEntry(env, payload.bikeId, payload.entryId);
  const completed = draft?.status==='ready' || (located?.entry.attachments || []).some(item => jobAttachmentMatches(item,payload,jobId));
  if (completed) return json({ ok: true, jobId, status: "completed", progress: 100 });
  if (row.status === "applied") {
    const failure=missingServiceDocumentState(payload);
    await notifyServiceDocumentFailure(env,payload,jobId,failure.error,failure.code);
    return json({ok:true,jobId,...failure});
  }
  const progress = cleanInteger(body.progress, 0, 99, 0);
  payload.progress = progress;
  payload.progressStage = cleanText(body.stage, 160) || payload.progressStage || "Σε επεξεργασία από τον Server";
  payload.lastAttemptAt = new Date().toISOString();
  await env.DB.prepare("UPDATE fleet_operations SET payload = ? WHERE id = ? AND status = 'pending'")
    .bind(JSON.stringify(payload), jobId).run();
  if(!draft&&!body.lightweight)await updateServiceDocumentProcessingSnapshot(env, payload, {
    jobId,
    status: "processing",
    progress,
    stage: payload.progressStage,
    error: "",
    attempts: Number(payload.attemptCount || 0)
  });
  await touchServer(env);
  return json({ ok: true, jobId, status: "processing", progress, stage: payload.progressStage });
}

async function serverOperationError(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json().catch(() => ({}));
  const jobId = cleanText(body.jobId, 120);
  const errorMessage = cleanText(body.error, 500) || "Αποτυχία δημιουργίας PDF τιμολογίου.";
  if (!jobId) return json({ error: "Λείπει η εργασία τιμολογίου." }, 400);
  const row = await env.DB.prepare("SELECT id, type, payload, status FROM fleet_operations WHERE id = ? LIMIT 1").bind(jobId).first();
  if (!row || row.type !== "service_document_render") return json({ error: "Η εργασία τιμολογίου δεν βρέθηκε." }, 404);
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}
  if (row.status === "cancelled") return json({ ok: true, jobId, status: "cancelled", ignored: true });
  const draft=payload.draftId?await readImportDraftForJob(env,jobId):null;
  const located = draft?null:await readServiceEntry(env, payload.bikeId, payload.entryId);
  const completed = draft?.status==='ready' || (located?.entry.attachments || []).some(item => jobAttachmentMatches(item,payload,jobId));
  if (completed) return json({ ok: true, jobId, status: "completed", progress: 100 });
  if (row.status === "applied") {
    const failure=missingServiceDocumentState(payload);
    await notifyServiceDocumentFailure(env,payload,jobId,failure.error,failure.code);
    return json({ok:true,jobId,...failure});
  }
  const transient = body.retryable === true;
  const attempts = Math.max(0, Number(payload.attemptCount || 0)) + (transient ? 0 : 1);
  const status = attempts >= SERVICE_RENDER_MAX_ATTEMPTS ? "error" : "pending";
  payload.attemptCount = attempts;
  if (transient) {
    payload.transientAttemptCount = Math.max(0, Number(payload.transientAttemptCount || 0)) + 1;
    payload.nextAttemptAt = new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(payload.transientAttemptCount, 6))).toISOString();
  } else delete payload.nextAttemptAt;
  payload.lastError = errorMessage;
  payload.lastAttemptAt = new Date().toISOString();
  payload.progressStage = status === "error" ? "Αποτυχία · χρειάζεται επανάληψη" : "Προσωρινό σφάλμα · θα ξαναδοκιμάσει";
  await env.DB.prepare("UPDATE fleet_operations SET payload = ?, status = ?, applied_at = NULL WHERE id = ?")
    .bind(JSON.stringify(payload), status, jobId).run();
  if(!draft)await updateServiceDocumentProcessingSnapshot(env, payload, {
    jobId,
    status: status === "error" ? "error" : "delayed",
    progress: Math.max(5, Math.min(95, Number(payload.progress || 5))),
    stage: payload.progressStage,
    error: errorMessage,
    attempts
  });
  if(status === "error")await notifyServiceDocumentFailure(env,payload,jobId,errorMessage);
  await touchServer(env);
  return json({ ok: true, jobId, status: status === "error" ? "error" : "delayed", attempts, canRetry: true, error: errorMessage });
}

async function serverSnapshot(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json();
  const incoming = await hideArchivedBikes(env, normalizeFleet(body));
  const current = await readSnapshot(env);
  // Merge with the online snapshot so that an older Android Server cannot
  // resurrect an admin-deleted record or overwrite a newer correction.
  const fleet = mergeFleets(current.data, incoming);
  if (current.source === "canonical" && JSON.stringify(fleet) === JSON.stringify(current.data)) {
    await touchServer(env);
    return json({ saved: true, unchanged: true, version: current.version, updatedAt: current.updatedAt });
  }
  const result = await writeSnapshot(env, fleet, "canonical", body.version);
  await touchServer(env);
  return json({ saved: true, version: result.version, updatedAt: result.updatedAt });
}

async function uploadServerRenderedServiceDocument(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16 * 1024 * 1024) return json({ error: "Το τιμολόγιο δεν μπορεί να ξεπερνά τα 16 MB." }, 413);
  const url = new URL(request.url);
  const bikeId = cleanText(url.searchParams.get("bikeId"), 80);
  const entryId = cleanText(url.searchParams.get("entryId"), 120);
  const jobId = cleanText(url.searchParams.get("jobId"), 120);
  const qrValue = normalizeQrValue(url.searchParams.get("qrValue"));
  const qrUrl = qrUrlFromValue(url.searchParams.get("qrUrl") || qrValue);
  const requestedName = cleanText(url.searchParams.get("name") || "invoice-qr.pdf", 120);
  const originalName = (requestedName.toLowerCase().endsWith(".pdf") ? requestedName : requestedName + ".pdf")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-120) || "invoice-qr.pdf";
  if (!bikeId || !entryId || !jobId || !qrValue || !qrUrl || !isPublicExternalQrUrl(qrUrl)) {
    return json({ error: "Λείπουν ή δεν είναι έγκυρα τα στοιχεία του τιμολογίου." }, 400);
  }
  if (await renderJobCancelled(env, jobId)) return json({ error: "Η παλιά προσπάθεια διακόπηκε.", cancelled: true }, 410);
  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);
  let bytes, bodyAnalysis = null;
  if (/^multipart\/form-data\b/i.test(request.headers.get('content-type') || '')) {
    const form = await request.formData(), file = form.get('file'), analysis = form.get('analysis');
    if (!file || typeof file.arrayBuffer !== 'function' || typeof analysis !== 'string' || new TextEncoder().encode(analysis).length > 1024*1024) return json({error:'Μη έγκυρη ή πολύ μεγάλη ανάλυση τιμολογίου.'},400);
    try { bodyAnalysis=JSON.parse(analysis); } catch { return json({error:'Μη έγκυρη ανάλυση τιμολογίου.'},400); }
    bytes=new Uint8Array(await file.arrayBuffer());
  } else bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024) return json({ error: "Το τιμολόγιο δεν μπορεί να ξεπερνά τα 15 MB." }, 413);
  if (detectDocumentContentType(bytes) !== "application/pdf") return json({ error: "Ο Server δεν δημιούργησε έγκυρο PDF." }, 415);

  const draft=await readImportDraftForJob(env,jobId);
  const located = draft ? {version:0,bike:{id:bikeId,name:"Προσχέδιο"},entry:{id:entryId,type:"service",date:"",attachments:draft.data.attachment?[draft.data.attachment]:[]}} : await readServiceEntry(env, bikeId, entryId);
  const bike = located?.bike;
  const entry = located?.entry;
  if (!bike || !entry || entry.type === "check") return json({ error: "Το service δεν βρέθηκε ή διαγράφηκε." }, 404);
  const jobRow=await env.DB.prepare("SELECT payload FROM fleet_operations WHERE id=? AND type='service_document_render'").bind(jobId).first();
  let renderPayload={};try{renderPayload=JSON.parse(jobRow?.payload||'{}');}catch{}
  const photo=renderPayload.sourcePhotoKey?(entry.attachments||[]).find(file=>file.key===renderPayload.sourcePhotoKey):null;
  if(renderPayload.sourcePhotoKey&&!photo&&!entry.attachments?.some(file=>file.sourcePhoto?.key===renderPayload.sourcePhotoKey))return json({error:"Η αρχική φωτογραφία αφαιρέθηκε. Η παλιά προσπάθεια σταμάτησε.",cancelled:true},410);
  const existing = (Array.isArray(entry.attachments) ? entry.attachments : []).find((item) =>
    item.key!==renderPayload.sourcePhotoKey && (String(item.renderJobId) === jobId || String(item.qrUrl || item.qrValue) === qrUrl)
  );
  if (existing) return json({ ok: true, duplicate: true, attachment: existing, version: located.version });
  if (!photo && (entry.attachments || []).length >= MAX_SERVICE_ATTACHMENTS) return json({ error: "Μπορείς να κρατήσεις έως 10 τιμολόγια σε ένα service. Τα υπάρχοντα αρχεία διατηρούνται." }, 409);

  const localHeader = bodyAnalysis || decodeJsonHeader(request.headers.get("x-fleet-local-ocr"));
  const localOcr = normalizeServiceDocumentOcr(localHeader);
  const localStatus = String(localOcr?.localReadStatus || "").toLowerCase();
  const localConfidence = cleanInteger(localOcr?.ocrConfidence, 0, 100, 0);
  const localConfident = Boolean(localOcr && (localStatus === "confident" || (!localStatus && localConfidence >= 70 && invoiceWorkItems(localOcr).length > 0)));
  let extracted = localConfident ? normalizeServiceDocumentOcr({
    ...localOcr,
    source: "server-local",
    ocrSource: "server-local",
    ocrFallbackUsed: false,
    ocrFallbackReason: "",
    ocrFallbackError: ""
  }) : null;
  let ocrError = "";
  let fallbackUsed = false;
  let fallbackReason = localOcr?.ocrFallbackReason || (localHeader ? "Η τοπική ανάγνωση βρήκε αμφίβολα στοιχεία." : "Ο Server δεν έστειλε αποτέλεσμα τοπικής ανάγνωσης.");
  if (!extracted) {
    await env.DB.prepare("UPDATE fleet_operations SET payload=json_set(payload,'$.progress',85,'$.progressStage','Workers AI · ανάγνωση αποθηκευμένου PDF') WHERE id=? AND status='pending'").bind(jobId).run();
    fallbackUsed = true;
    if (env.AI?.toMarkdown) {
      try {
        const aiStarted=performanceNow();
        const converted = await env.AI.toMarkdown({ name: originalName, blob: new Blob([bytes], { type: "application/pdf" }) });
        const result = Array.isArray(converted) ? converted[0] : converted;
        if (result && result.format !== "error" && result.data) {
          extracted = aiInvoiceAnalysis(await extractInvoiceFromText(env, String(result.data), "cloudflare-ai-fallback"),localOcr,performanceNow()-aiStarted);
          extracted = normalizeServiceDocumentOcr({
            ...extracted,
            ocrSource: "cloudflare-ai",
            ocrFallbackUsed: true,
            ocrFallbackReason: fallbackReason,
            ocrFallbackError: "",
            localReadStatus: localStatus || "failed"
          });
        } else {
          ocrError = "Δεν ολοκληρώθηκε η ανάγνωση του PDF από το Workers AI.";
        }
      } catch (error) {
        ocrError = "Δεν ολοκληρώθηκε η ανάγνωση του PDF από το Workers AI.";
      }
    } else {
      ocrError = "Το Workers AI δεν είναι διαθέσιμο για fallback.";
    }
    if (!extracted && localOcr) {
      extracted = normalizeServiceDocumentOcr({
        ...localOcr,
        ocrSource: "server-local",
        ocrFallbackUsed: true,
        ocrFallbackReason: fallbackReason,
        ocrFallbackError: ocrError
      });
    }
  }

  if (await renderJobCancelled(env, jobId)) return json({ error: "Η παλιά προσπάθεια διακόπηκε.", cancelled: true }, 410);
  // Drafts need the same complete deterministic fields in their preview.
  // Confirmation still waits for the manager's explicit service selection.
  if(draft&&extracted)extracted=normalizeServiceDocumentOcr(enrichInvoiceExtraction(extracted));
  const displayName = buildInvoiceDisplayName(bike.name, extracted?.invoiceDate || "", entry.date, originalName);
  const key = `service-documents/${encodeURIComponent(bikeId)}/${encodeURIComponent(entryId)}/${crypto.randomUUID()}-${originalName}`;
  await bucket.put(key, new Blob([bytes], { type: "application/pdf" }), {
    httpMetadata: { contentType: "application/pdf", contentDisposition: contentDispositionForFilename(displayName) },
    customMetadata: { bikeId, entryId, uploadedBy: "android-server", qrUrl, renderJobId: jobId, displayName }
  });
  const attachment = {
    id: key.split("/").pop(),
    key,
    name: displayName,
    originalName,
    contentType: "application/pdf",
    size: bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    qrValue,
    qrUrl,
    renderJobId: jobId,
    sourcePhoto: ServiceModel.sourcePhoto(photo),
    uploadId: cleanText(photo?.uploadId,100),
    ocrError,
    ocr: extracted || null
  };
  const stored = draft ? await finishImportDraft(env,draft,attachment) : await attachServiceDocumentMetadata(env, bikeId, entryId, attachment);
  if (!stored.attached) {
    await bucket.delete(key);
    return json({ error: stored.error || "Το service δεν βρέθηκε ή διαγράφηκε." }, stored.status || 404);
  }
  if (stored.duplicate && stored.attachment?.key !== key) {
    await bucket.delete(key);
    return json({ ok: true, duplicate: true, attachment: stored.attachment, version: stored.version });
  }
  const savedAttachment=stored.attachment||attachment;
  return json({ ok: true, attachment:savedAttachment, extracted:savedAttachment.ocr||extracted, extractionError: ocrError, fallbackUsed, ocrSource: extracted?.ocrSource || "", version: stored.version, requiresConfirmation: Boolean((savedAttachment.ocr||extracted)&&!savedAttachment.ocr?.confirmedAt) }, 201);
}

async function restoreServerServiceDocument(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 15 * 1024 * 1024) return json({ error: "Το τιμολόγιο backup δεν μπορεί να ξεπερνά τα 15 MB." }, 413);
  const url = new URL(request.url);
  const key = cleanText(url.searchParams.get("key"), 500);
  const bikeId = cleanText(url.searchParams.get("bikeId"), 100);
  const entryId = cleanText(url.searchParams.get("entryId"), 120);
  const name = cleanText(url.searchParams.get("name") || "τιμολόγιο.pdf", 160).replace(/[\r\n"\\]/g, "_");
  const qrValue = normalizeQrValue(url.searchParams.get("qrValue"));
  const qrUrl = qrUrlFromValue(url.searchParams.get("qrUrl") || qrValue);
  if (!key || !bikeId || !entryId || !isServiceDocumentKey(key)) return json({ error: "Μη έγκυρη σύνδεση τιμολογίου backup." }, 400);
  const expectedPrefix = `service-documents/${encodeURIComponent(bikeId)}/${encodeURIComponent(entryId)}/`;

  const bucket = env.SERVICE_DOCS || env.RELEASES;
  if (!bucket) return json({ error: "Δεν έχει συνδεθεί χώρος αποθήκευσης τιμολογίων." }, 503);
  const located=await readServiceEntry(env,bikeId,entryId);
  const entry=located?.entry;
  if(entry&&entry.type!=='check'&&!(entry.attachments||[]).some(file=>file.key===key||file.sourcePhoto?.key===key))return json({error:'Το αρχείο δεν είναι συνδεδεμένο με το service.'},key.startsWith(expectedPrefix)?404:400);
  if(!entry||entry.type==='check'){
    const archived=await env.DB.prepare(`SELECT 1 AS found FROM deleted_records r,json_each(r.payload,'$.entry.attachments') a WHERE r.record_type='fleet_history' AND r.restored_at IS NULL AND json_extract(r.payload,'$.bikeId')=? AND json_extract(r.payload,'$.entry.id')=? AND (json_extract(a.value,'$.key')=? OR json_extract(a.value,'$.sourcePhoto.key')=?) LIMIT 1`).bind(bikeId,entryId,key,key).first();
    if(!archived)return json({error:'Το service ή το συνδεδεμένο αρχείο στον κάδο δεν βρέθηκε.'},404);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024) return json({ error: "Το τιμολόγιο backup δεν έχει έγκυρο μέγεθος." }, 400);
  const detected = detectDocumentContentType(bytes);
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(detected)) return json({ error: "Το αρχείο backup δεν είναι υποστηριζόμενο PDF ή εικόνα." }, 415);
  const existing = await bucket.head(key);
  if (!existing) {
    await bucket.put(key, new Blob([bytes], { type: detected }), {
      httpMetadata: { contentType: detected, contentDisposition: contentDispositionForFilename(name) },
      customMetadata: { bikeId, entryId, restoredBy: "android-server", qrValue, qrUrl, displayName: name }
    });
  }
  return json({ ok: true, restored: !existing, key, contentType: detected, size: bytes.byteLength });
}

async function serverHeartbeat(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  await touchServer(env);
  let body = {};
  try { body = await request.json(); } catch {}
  if (body.lastBackup) await setSetting(env, "server_last_backup", cleanText(body.lastBackup, 60));
  if (body.backupResult) await setSetting(env, "server_backup_result", cleanText(body.backupResult, 240));
  if(body.serverVersion){await setSetting(env,"server_version",cleanText(body.serverVersion,40));const [major,minor,patch]=String(body.serverVersion).split('.').map(Number);if(!(major>2||major===2&&(minor>2||minor===2&&patch>=3)))await setSetting(env,"server_offload_protocol","0");}
  if (body.health && typeof body.health === "object" && !Array.isArray(body.health)) {
    const source = body.health;
    const finite = (value, min, max) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null;
    };
    const health = {
      batteryPercent: finite(source.batteryPercent, 0, 100),
      batteryCharging: Boolean(source.batteryCharging),
      batteryTemperatureC: finite(source.batteryTemperatureC, -20, 100),
      storageFreeBytes: finite(source.storageFreeBytes, 0, Number.MAX_SAFE_INTEGER),
      storageTotalBytes: finite(source.storageTotalBytes, 0, Number.MAX_SAFE_INTEGER),
      powerSaveMode: Boolean(source.powerSaveMode),
      ignoringBatteryOptimizations: source.ignoringBatteryOptimizations !== false,
      networkConnected: Boolean(source.networkConnected),
      networkType: cleanText(source.networkType, 80),
      thermalStatus: cleanText(source.thermalStatus, 40),
      androidVersion: cleanText(source.androidVersion, 40),
      deviceModel: cleanText(source.deviceModel, 100),
      uptimeSeconds: finite(source.uptimeSeconds, 0, Number.MAX_SAFE_INTEGER),
      measuredAt: isoDateTime(source.measuredAt, new Date().toISOString()),
      serverVersion: cleanText(body.serverVersion, 40)
    };
    await setSetting(env, "server_health_json", JSON.stringify(health));
    const resolveHealthAlert = async (type) => env.DB.prepare(`UPDATE system_alerts SET resolved=1,resolved_at=?
      WHERE type=? AND object_type='server' AND object_id='android-server' AND resolved=0`)
      .bind(new Date().toISOString(), type).run();
    if (health.batteryTemperatureC != null && health.batteryTemperatureC >= 42) {
      await createExternalAlert(env, "server_temperature", "critical", "Υψηλή θερμοκρασία Server",
        `Η μπαταρία του Server έφτασε τους ${health.batteryTemperatureC.toFixed(1)} °C.`, "server", "android-server", "server-temperature");
    } else await resolveHealthAlert("server_temperature");
    const freePercent = health.storageTotalBytes > 0 ? health.storageFreeBytes / health.storageTotalBytes * 100 : null;
    if (freePercent != null && freePercent <= 10) {
      await createExternalAlert(env, "server_storage", "critical", "Χαμηλός χώρος στον Server",
        `Απομένει ${freePercent.toFixed(1)}% ελεύθερος χώρος στη συσκευή Server.`, "server", "android-server", "server-storage");
    } else await resolveHealthAlert("server_storage");
    if (health.batteryPercent != null && health.batteryPercent <= 15 && !health.batteryCharging) {
      await createExternalAlert(env, "server_battery", "warning", "Χαμηλή μπαταρία Server",
        `Η μπαταρία είναι στο ${Math.round(health.batteryPercent)}% και δεν φορτίζει.`, "server", "android-server", "server-battery");
    } else await resolveHealthAlert("server_battery");
    if (!health.ignoringBatteryOptimizations || health.powerSaveMode) {
      await createExternalAlert(env, "server_restriction", "warning", "Πιθανός περιορισμός από Android",
        !health.ignoringBatteryOptimizations
          ? "Ο Fleet Control Server δεν έχει εξαίρεση από τη βελτιστοποίηση μπαταρίας."
          : "Η εξοικονόμηση ενέργειας είναι ενεργή στη συσκευή Server.",
        "server", "android-server", "server-restriction");
    } else await resolveHealthAlert("server_restriction");
  }
  if (body.unexpectedRestart) {
    const stamp = cleanText(body.restartAt, 60) || new Date().toISOString();
    await createExternalAlert(env, "server_restart", "warning", "Απρόσμενη επανεκκίνηση Server",
      `Η υπηρεσία Server επανεκκινήθηκε στις ${stamp}.`, "server", "android-server", `server-restart:${stamp}`);
  }
  return json({ online: true, healthStored: Boolean(body.health), serverTime: new Date().toISOString() });
}

async function uploadClientApk(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  if (!env.RELEASES) return json({ error: "Δεν έχει συνδεθεί ο χώρος αρχείων R2." }, 503);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) {
    return json({ error: "Το Client APK δεν έχει έγκυρο μέγεθος." }, 400);
  }
  const version = cleanText(request.headers.get("x-release-version"), 40) || new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const notes = cleanText(request.headers.get("x-release-notes"), 500);
  const id = crypto.randomUUID();
  const key = `client/${id}/Fleet_Control.apk`;
  const checksum = await digestHex(bytes);
  const object = await env.RELEASES.put(key, bytes, { httpMetadata: { contentType: "application/vnd.android.package-archive", contentDisposition: "attachment; filename=Fleet_Control.apk" } });
  if (!object) return json({ error: "Η μεταφόρτωση απέτυχε." }, 500);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE fleet_releases SET active = 0 WHERE kind = 'client'"),
    env.DB.prepare("INSERT INTO fleet_releases (id, kind, version, object_key, notes, size_bytes, sha256, active, created_at) VALUES (?, 'client', ?, ?, ?, ?, ?, 1, ?)")
      .bind(id, version, key, notes, Number(object.size || bytes.byteLength), checksum, now)
  ]);
  return json({ uploaded: true, id, version, sizeBytes: object.size || bytes.byteLength, sha256: checksum });
}

function safeAssetPath(value) {
  try {
    const decoded = decodeURIComponent(value || "").replace(/^\/+/, "");
    if (!decoded || decoded.includes("..") || decoded.includes("\\") || decoded.length > 220) return "";
    return decoded;
  } catch {
    // A malformed percent escape must be treated as an invalid path, not as a
    // Worker exception that turns a public asset request into a 500 response.
    return "";
  }
}

function contentTypeFor(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", wasm: "application/wasm", json: "application/json; charset=utf-8", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" })[extension] || "application/octet-stream";
}

export { mergeBike, normalizeBike, normalizeFleet, normalizeServiceDocumentOcr, serviceDocumentWarnings, refineInvoicePlateForFleet, cleanInvoiceWorkText };

async function uploadWebAsset(request, env, path) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  if (!env.RELEASES) return json({ error: "Δεν έχει συνδεθεί ο χώρος αρχείων R2." }, 503);
  const rest = path.slice("/api/admin/web-assets/".length);
  const separator = rest.indexOf("/");
  const release = cleanText(separator >= 0 ? rest.slice(0, separator) : "", 80);
  const assetPath = safeAssetPath(separator >= 0 ? rest.slice(separator + 1) : "");
  if (!release || !assetPath) return json({ error: "Μη έγκυρη διαδρομή αρχείου." }, 400);
  const key = `web/${release}/${assetPath}`;
  const object = await env.RELEASES.put(key, request.body, { httpMetadata: { contentType: contentTypeFor(assetPath) } });
  return json({ uploaded: true, path: assetPath, sizeBytes: object?.size || 0 });
}

async function activateWebRelease(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json();
  const release = cleanText(body.release, 80);
  const version = cleanText(body.version, 40) || release;
  const notes = cleanText(body.notes, 500);
  const files = Array.isArray(body.files) ? [...new Set(body.files.map(safeAssetPath).filter(Boolean))].slice(0, 250) : [];
  if (!release || !files.includes("index.html")) return json({ error: "Το πακέτο web πρέπει να περιέχει index.html." }, 400);
  const indexObject = await env.RELEASES.head(`web/${release}/index.html`);
  if (!indexObject) return json({ error: "Δεν βρέθηκε το index.html της έκδοσης." }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const manifest = JSON.stringify({ release, files });
  await env.DB.batch([
    env.DB.prepare("UPDATE fleet_releases SET active = 0 WHERE kind = 'web'"),
    env.DB.prepare("INSERT INTO fleet_releases (id, kind, version, object_key, notes, manifest, size_bytes, active, created_at) VALUES (?, 'web', ?, ?, ?, ?, ?, 1, ?)")
      .bind(id, version, `web/${release}/`, notes, manifest, files.length, now)
  ]);
  activeWebReleaseCache = { value: { object_key: `web/${release}/`, manifest }, expiresAt: Date.now() + WEB_RELEASE_METADATA_CACHE_MS, db: env.DB };
  return json({ activated: true, id, version, files: files.length });
}

async function listReleases(request, env) {
  if (!await sessionAuthorized(request, env) && !await serverAuthorized(request, env) && !await authorizedFor(request, env, "server.manage")) return json({ error: "Δεν επιτρέπεται." }, 401);
  const result = await env.DB.prepare("SELECT id, kind, version, notes, size_bytes, active, created_at FROM fleet_releases ORDER BY created_at DESC LIMIT 30").all();
  return json({ releases: result.results || [] });
}

async function activateRelease(request, env) {
  if (!await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  const body = await request.json();
  const id = cleanText(body.id, 100);
  const release = await env.DB.prepare("SELECT id, kind FROM fleet_releases WHERE id = ?").bind(id).first();
  if (!release) return json({ error: "Η έκδοση δεν βρέθηκε." }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE fleet_releases SET active = 0 WHERE kind = ?").bind(release.kind),
    env.DB.prepare("UPDATE fleet_releases SET active = 1 WHERE id = ?").bind(id)
  ]);
  if (release.kind === "web") activeWebReleaseCache = { value: null, expiresAt: 0, db: null };
  return json({ activated: true, id, kind: release.kind });
}

async function clientUpdateResponse(request, env) {
  const release = await env.DB.prepare("SELECT version, size_bytes, sha256, notes, created_at FROM fleet_releases WHERE kind = 'client' AND active = 1 LIMIT 1").first();
  if (!release) return json({ available: false });
  const url = new URL(request.url);
  return json({
    available: true,
    version: String(release.version || ""),
    sizeBytes: Number(release.size_bytes || 0),
    sha256: String(release.sha256 || ""),
    notes: String(release.notes || ""),
    createdAt: release.created_at || null,
    downloadUrl: `${url.origin}/download/client.apk`
  });
}

async function downloadClientApk(request, env) {
  const release = await env.DB.prepare("SELECT version, object_key FROM fleet_releases WHERE kind = 'client' AND active = 1 LIMIT 1").first();
  if (!release) return json({ error: "Δεν έχει ανέβει ακόμη Client APK." }, 404);
  const object = await env.RELEASES.get(release.object_key);
  if (!object) return json({ error: "Το αρχείο APK δεν βρέθηκε." }, 404);
  const headers = new Headers(baseHeaders({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="Fleet_Control_${release.version}.apk"`,
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store"
  }));
  return new Response(object.body, { headers });
}

async function activeWebRelease(env) {
  if (activeWebReleaseCache.db === env.DB && Date.now() < activeWebReleaseCache.expiresAt) return activeWebReleaseCache.value;
  const value = await env.DB.prepare("SELECT object_key, manifest FROM fleet_releases WHERE kind = 'web' AND active = 1 LIMIT 1").first();
  activeWebReleaseCache = { value: value || null, expiresAt: Date.now() + WEB_RELEASE_METADATA_CACHE_MS, db: env.DB };
  return activeWebReleaseCache.value;
}

async function serveWeb(request, env) {
  const url = new URL(request.url);
  const fleetPage = ["/fleet", "/fleet/", "/index.html"].includes(url.pathname);
  if (fleetPage && !await authorizedFor(request, env, "fleet.view")) {
    const loginUrl = new URL("/", url);
    loginUrl.searchParams.set("next", "fleet");
    return Response.redirect(loginUrl.toString(), 302);
  }
  let path;
  if (["/", "/portal", "/portal/", "/portal.html"].includes(url.pathname)) path = "portal.html";
  else if (fleetPage) path = "index.html";
  else path = safeAssetPath(url.pathname);

  const active = await activeWebRelease(env);
  if (active && env.RELEASES) {
    let object = path ? await env.RELEASES.get(`${active.object_key}${path}`) : null;
    if (!object && !path.includes(".")) {
      path = "portal.html";
      object = await env.RELEASES.get(`${active.object_key}portal.html`);
    }
    if (object) {
      const headers = new Headers(baseHeaders({
        "Content-Type": object.httpMetadata?.contentType || contentTypeFor(path),
        "Cache-Control": ["index.html", "portal.html", "service-worker.js"].includes(path) ? "no-cache" : "public, max-age=3600",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
      }));
      return new Response(object.body, { headers });
    }
  }
  if (!path || !path.includes(".")) path = "portal.html";
  const assetUrl = new URL(request.url);
  assetUrl.pathname = `/${path}`;
  const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function updateServiceFollowup(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, 'fleet.manage'); }
  catch(error) { return json({error:error.message},Number(error.status)||401); }
  if(!isManagementActor(actor))return json({error:'Χρειάζεται λογαριασμός διαχείρισης.'},403);
  const body=await request.json().catch(()=>({}));
  if(!['invoice-expectation','acknowledge-km'].includes(body.action))return json({error:'Μη έγκυρη ενέργεια.'},400);
  const located=await readSnapshotBike(env,cleanText(body.bikeId,100));
  const bike=located?.bike,entry=bike?.history?.find(e=>String(e.id)===String(body.entryId));
  if(!entry)return json({error:'Η καταχώρηση δεν βρέθηκε.'},404);
  if((await activeArchivedBikeIds(env)).has(bike.id))return json({error:'Η μηχανή βρίσκεται στον κάδο. Επαναφέρετέ τη πριν αλλάξετε την καταχώρηση.'},409);
  if(typeof body.expectedEntryUpdatedAt!=='string'||body.expectedEntryUpdatedAt!==String(entry.updatedAt||''))return json({error:'Η καταχώρηση άλλαξε. Ανανέωσε τη λίστα πριν αποθηκεύσεις.'},409);
  const reason=cleanText(body.reason,500),now=new Date().toISOString(),name=String(actor.full_name||actor.username||actor.id||'admin').slice(0,120);
  const before={invoiceExpectation:entry.invoiceExpectation,kmAcknowledgments:entry.kmAcknowledgments};
  if(body.action==='invoice-expectation') {
    if(entry.type==='check'||!['expected','not_expected'].includes(body.status))return json({error:'Μη έγκυρη επιλογή τιμολογίου.'},400);
    if(body.status==='not_expected'&&((entry.attachments||[]).some(f=>f.key)||ServiceModel.pendingInvoice(entry)))return json({error:'Υπάρχει ήδη τιμολόγιο ή ανάγνωση σε εξέλιξη για αυτό το service.'},409);
    if(body.status==='not_expected'&&reason.length<3)return json({error:'Γράψε μια σύντομη εξήγηση.'},400);
    entry.invoiceExpectation={status:body.status,reason,at:now,actor:name};
  } else {
    const mismatch=ServiceModel.chronology(bike).find(r=>String(r.entry.id)===String(entry.id)&&r.signature===body.signature);
    if(!mismatch)return json({error:'Οι ημερομηνίες ή οι ενδείξεις άλλαξαν. Ανανέωσε τον έλεγχο.'},409);
    if(reason.length<3)return json({error:'Γράψε γιατί η μικρότερη ένδειξη είναι σωστή, π.χ. αλλαγή κοντέρ.'},400);
    entry.kmAcknowledgments=ServiceModel.kmAcknowledgments([...(entry.kmAcknowledgments||[]).filter(a=>a.signature!==mismatch.signature),{signature:mismatch.signature,reason,at:now,actor:name}]);
  }
  entry.updatedAt=now;bike.updatedAt=now;const normalized=normalizeBike(bike);
  const version=await writeSnapshotBike(env,located,normalized,'admin-service-followup',now);
  if(!version)return json({error:'Τα δεδομένα άλλαξαν ταυτόχρονα. Ανανέωσε τη λίστα.'},409);
  const operationId=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) VALUES (?,'authenticated-client','snapshot_replace_bike',?,'pending',?)").bind(operationId,JSON.stringify({bike:normalized}),now).run();
  await recordExternalAudit(env,request,actor,'service_followup_'+body.action,'fleet_history',entry.id,before,{invoiceExpectation:entry.invoiceExpectation,kmAcknowledgments:entry.kmAcknowledgments},reason,false);
  return json({ok:true,bike:normalized,version,operationId});
}

async function undoServiceReview(request, env) {
  let actor;
  try { actor = await authenticateExternal(request, env, "fleet.manage"); }
  catch(error) { return json({ error: error.message }, Number(error.status) || 401); }
  if (!isManagementActor(actor)) return json({ error: "Χρειάζεται λογαριασμός διαχείρισης." },403);
  const body=await request.json().catch(()=>({})), snapshot=await readSnapshot(env);
  const fleet=JSON.parse(JSON.stringify(snapshot.data)),bike=fleet.bikes.find(b=>String(b.id)===String(body.bikeId));
  const entry=bike?.history?.find(e=>String(e.id)===String(body.entryId));
  const revision=entry?.reviewJournal?.find(r=>String(r.id)===String(body.revisionId));
  const file=entry?.attachments?.find(f=>f.key===revision?.key);
  if(!entry||!file||!revision)return json({error:"Η απόφαση ή το τιμολόγιο δεν βρέθηκε."},404);
  const current=invoiceDataForServiceDocument(entry,file),before=ServiceModel.state(entry,current);
  const data=ServiceModel.undo(entry,current,revision);
  if(!data)return json({error:"Έχουν μεσολαβήσει αλλαγές ή η απόφαση έχει ήδη αναιρεθεί. Δεν άλλαξε κανένα δεδομένο."},409);
  const now=new Date().toISOString();revision.undoneAt=now;revision.undoneBy=String(actor.full_name||actor.username||actor.id||'admin');
  file.ocr=data;file.qrData=data;entry.invoiceData=data;entry.updatedAt=now;bike.updatedAt=now;
  bike.historyCorrectedAt=now;bike.odometerFloorKm=await workforceOdometerFloor(env,bike.id);
  const normalized=normalizeBike(bike);fleet.bikes[fleet.bikes.indexOf(bike)]=normalized;
  const stored=await writeServiceReviewSnapshot(env,normalizeFleet(fleet),'admin-service-review-undo',snapshot.version);
  if(!stored)return json({error:"Τα δεδομένα άλλαξαν ταυτόχρονα. Άνοιξε ξανά τον έλεγχο."},409);
  const operationId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) VALUES (?,'authenticated-client','snapshot_replace_bike',?,'pending',?)").bind(operationId,JSON.stringify({bike:normalized}),now),
    env.DB.prepare("UPDATE vehicle_registry SET odometer=?,version=version+1,updated_at=? WHERE bike_id=?").bind(normalized.currentKm,now,bike.id)
  ]);
  await recordExternalAudit(env,request,actor,'service_review_undone','service_document',file.key,before,ServiceModel.state(entry,data),'Αναίρεση απόφασης τιμολογίου',false);
  return json({ok:true,bike:normalized,document:adminServiceDocumentRecord(normalized,entry,file),version:stored.version,operationId});
}

async function statusPayload(env){const response=await statusResponse(env);return response.json();}
async function queueBike(env,bike,now){await env.DB.prepare("INSERT INTO fleet_operations (id,source,type,payload,status,created_at) VALUES (?,'authenticated-client','snapshot_replace_bike',?,'pending',?)").bind(crypto.randomUUID(),JSON.stringify({bike}),now).run();}
function historyChanges(body,entry){
 const km=Number(body.km),date=strictCalendarDate(body.date);
 if(body.km==null||body.km===''||!Number.isSafeInteger(km)||km<0||km>2000000000||!date)throw Object.assign(new Error('Συμπλήρωσε σωστά χιλιόμετρα και ημερομηνία.'),{status:400});
 if(entry.type==='check')return {km,date};
 let tasks=(Array.isArray(body.tasks)?body.tasks:[]).map(t=>cleanText(t,500)).filter(Boolean).slice(0,5120);tasks=tasks.filter(t=>!['Αλλαγή λαδιών','Μεγάλο service'].includes(t));if(body.oilChanged===true)tasks.unshift('Αλλαγή λαδιών');if(body.majorService===true)tasks.unshift('Μεγάλο service');if(!tasks.length)throw Object.assign(new Error('Διάλεξε τουλάχιστον μία εργασία.'),{status:400});
 return {km,date,tasks:[...new Set(tasks)].slice(0,5120),oilChanged:body.oilChanged===true,majorService:body.majorService===true,cost:cleanText(body.cost,60),workshop:cleanText(body.workshop,120)};
}
async function impactToken(bikeJson,action,entryId,body,floor){const fields={};for(const k of ['km','date','tasks','oilChanged','majorService','cost','workshop'])if(body[k]!==undefined)fields[k]=body[k];return digestHex(new TextEncoder().encode(JSON.stringify([bikeJson,action,entryId,fields,floor])));}
