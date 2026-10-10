import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import worker, { normalizeFleet } from "../cloudflare-worker/src/worker.js";
import {
  readServiceEntry,
  writeServiceEntry,
} from "../cloudflare-worker/src/snapshot-store.js";

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.args) || null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return {
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
      },
    };
  }
}
const sqlite = new DatabaseSync(":memory:");
const db = {
  exec: async (sql) => sqlite.exec(sql),
  prepare: (sql) => new Statement(sqlite, sql),
  batch: async (stmts) => {
    sqlite.exec("BEGIN");
    try {
      const r = [];
      for (const s of stmts) {const value=s.db.prepare(s.sql).run(...s.args);r.push({meta:{changes:Number(value.changes),last_row_id:Number(value.lastInsertRowid)}});}
      sqlite.exec("COMMIT");
      return r;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  },
};
const env = {
  DB: db,
  SERVER_KEY: "large-fixture-server-key",
  PIN_PEPPER: "fixture-pepper",
  RELEASES: { get: async () => null },
};
const base = "https://load-test.invalid";
async function call(path, body, token = null, method = null) {
  const headers = token ? {} : { "X-Fleet-Server-Key": env.SERVER_KEY };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(base + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}
assert.equal((await call("/api/status")).status, 200);
const bootstrap = await call("/api/auth/bootstrap", {
  fullName: "Load Fixture",
  username: "load-owner",
  password: "Fixture-Password-123",
  deviceId: "load-fixture",
});
assert.equal(bootstrap.status, 200);
const token = (await bootstrap.json()).token;
const stamp = new Date().toISOString();
const fleet = normalizeFleet({
  bikes: [
    {
      id: "bike",
      name: "BTO-756",
      currentKm: 10000,
      lastServiceKm: 9000,
      intervalKm: 3000,
      history: [
        {
          id: "service",
          type: "service",
          km: 9000,
          date: "2026-10-01",
          oilChanged: true,
          tasks: ["Αλλαγή λαδιών"],
          attachments: [],
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
});
sqlite
  .prepare(
    "UPDATE fleet_snapshot SET data=?,source='canonical',version=10,updated_at=? WHERE id=1",
  )
  .run(JSON.stringify(fleet), stamp);
const before = sqlite.prepare("SELECT data FROM fleet_snapshot").get().data;
const endpoint = "/api/admin/invoice-imports",
  qr = "https://einvoice.impact.gr/p/EL099902715/DRAFT";
const denied = await worker.fetch(
  new Request(base + endpoint, {
    method: "POST",
    body: JSON.stringify({ action: "scan", value: qr }),
  }),
  env,
);
assert.equal(denied.status, 401);
assert.equal(
  (
    await call(
      endpoint,
      { action: "scan", value: "http://127.0.0.1/private" },
      token,
    )
  ).status,
  422,
);
let res = await call(endpoint, { action: "scan", value: qr }, token);
assert.equal(res.status, 202);
const draft = await res.json();
assert.equal(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
  before,
  "scan must not mutate service history",
);
const duplicate = await (
  await call(endpoint, { action: "scan", value: qr }, token)
).json();
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.draftId, draft.draftId);
assert.equal(
  sqlite
    .prepare("SELECT count(*) n FROM fleet_operations WHERE status='pending'")
    .get().n,
  1,
);
assert.equal(
  (
    await call("/api/server/operation-progress", {
      jobId: draft.jobId,
      progress: 55,
      stage: "Local OCR",
    })
  ).status,
  200,
);
assert.equal(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
  before,
);
assert.equal(
  (
    await (
      await call(
        "/api/server/service-documents/job-active?jobId=" + draft.jobId,
      )
    ).json()
  ).active,
  true,
);
const retry = await (
  await call(endpoint, { action: "retry", id: draft.draftId }, token)
).json();
assert.ok(retry.jobId);
assert.notEqual(retry.jobId, draft.jobId);
assert.equal(
  sqlite
    .prepare("SELECT status FROM fleet_operations WHERE id=?")
    .get(draft.jobId).status,
  "cancelled",
);
const objects = new Map(),
  bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF");
env.RELEASES = {
  put: async (key, value, options) => {
    objects.set(key, { bytes: new Uint8Array(value), options });
  },
  delete: async (key) => objects.delete(key),
  get: async (key) =>
    objects.has(key)
      ? {
          arrayBuffer: async () => objects.get(key).bytes.buffer,
          httpMetadata: { contentType: "application/pdf" },
        }
      : null,
};
const local = {
  plate: "BTO-756",
  odometerKm: "11000",
  invoiceDate: "2026-10-02",
  totalAmount: "59,00",
  supplier: "Fixture Supplier",
  invoiceNumber: "INV-123",
  lineItems: ["Λάδι"],
  localReadStatus: "confident",
  ocrConfidence: 100,
  analysisEngine: "tesseract-ell-eng",
  analysisVersion: "fixture-v1",
  analysisTimings: { ocrMs: 150 },
  fieldEvidence: {
    plate: {
      score: 85,
      reason: "Label",
      source: "tesseract-ell-eng",
      evidence: "Πινακίδα: BTO-756",
    },
  },
};
async function upload(jobId, localRead = local) {
  const url =
    base +
    "/api/server/service-documents/rendered?jobId=" +
    jobId +
    "&bikeId=draft-" +
    draft.draftId +
    "&entryId=draft&qrUrl=" +
    encodeURIComponent(qr) +
    "&qrValue=" +
    encodeURIComponent(qr);
  return worker.fetch(
    new Request(url, {
      method: "PUT",
      headers: {
        "X-Fleet-Server-Key": env.SERVER_KEY,
        "X-Fleet-Local-Ocr": Buffer.from(JSON.stringify(localRead)).toString(
          "base64url",
        ),
      },
      body: bytes,
    }),
    env,
  );
}
assert.equal(
  (await upload(draft.jobId)).status,
  410,
  "late cancelled upload must not restore draft",
);
res = await upload(retry.jobId);
assert.equal(res.status, 201);
const uploaded = await res.json();
assert.ok(uploaded.attachment.key);
assert.equal(objects.size, 1);
assert.equal(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
  before,
  "reading a draft must not change service",
);
let listing = await (await call(endpoint, undefined, token)).json();
assert.equal(listing.drafts[0].status, "ready");
assert.equal(listing.drafts[0].invoiceData.analysisEngine, "tesseract-ell-eng");
let commit = {
  action: "commit",
  id: draft.draftId,
  bikeId: "bike",
  date: "2026-09-01",
  km: 11000,
  oilChanged: true,
  tasks: "Αλλαγή λαδιών",
};
res = await call(endpoint, commit, token);
assert.equal(res.status, 409);
assert.equal((await res.json()).code, "service_impact");
assert.equal(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
  before,
);
res = await call(endpoint, { ...commit, date: "2026-02-30" }, token);
assert.equal(res.status, 400);
assert.equal(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
  before,
);
res = await call(endpoint, { ...commit, confirmImpact: true }, token);
assert.equal(res.status, 200);
const saved = await res.json();
let stored = JSON.parse(
  sqlite.prepare("SELECT data FROM fleet_snapshot").get().data,
).bikes[0];
assert.equal(stored.history.length, 2);
assert.equal(stored.currentKm, 11000);
assert.equal(stored.nextServiceKm, 14000);
assert.equal(
  stored.history.find((e) => e.id === saved.entryId).attachments.length,
  1,
);
assert.equal(
  stored.history.find((e) => e.id === saved.entryId).date,
  "2026-09-01",
);
assert.equal(
  stored.history.find((e) => e.id === saved.entryId).attachments[0].ocr
    .invoiceDate,
  "2026-10-02",
);
const repeated = await (
  await call(
    endpoint,
    { ...commit, bikeId: "other", confirmImpact: true },
    token,
  )
).json();
assert.equal(repeated.alreadyCommitted, true);
assert.equal(repeated.bikeId, "bike");
assert.equal(
  JSON.parse(sqlite.prepare("SELECT data FROM fleet_snapshot").get().data)
    .bikes[0].history.length,
  2,
);
assert.equal(
  (await call(endpoint, { action: "discard", id: draft.draftId }, token))
    .status,
  409,
);
res = await call(endpoint, { action: "scan", value: qr }, token);
assert.equal(res.status, 200);
const existing = await res.json();
assert.equal(existing.duplicate, true);
assert.equal(existing.matches[0].bikeId, "bike");
const matches = await (
  await call(
    "/api/admin/service-documents/duplicates",
    { supplier: "Fixture Supplier", invoiceNumber: "inv-123" },
    token,
  )
).json();
assert.equal(matches.matches.length, 1);
assert.equal(
  (
    await call(
      "/api/service-documents/import-qr",
      { bikeId: "bike", entryId: "service", value: qr },
      token,
    )
  ).status,
  409,
);
const targets = await (
  await call(endpoint + "/targets?bikeId=bike", undefined, token)
).json();
assert.equal(targets.services.length, 2);
const second = await (
  await call(endpoint, { action: "scan", value: qr + "-2" }, token)
).json();
assert.ok(second.jobId);
assert.equal(
  (
    await call("/api/server/operation-error", {
      jobId: second.jobId,
      error: "HTTP 503",
      retryable: true,
    })
  ).status,
  200,
);
assert.equal(
  (await call(endpoint, { action: "discard", id: second.draftId }, token))
    .status,
  200,
);
assert.equal(
  sqlite
    .prepare("SELECT status FROM fleet_operations WHERE id=?")
    .get(second.jobId).status,
  "cancelled",
);
const rulesPath = "/api/admin/invoice-reader-rules";
assert.equal(
  (
    await call(
      rulesPath,
      { supplier: "Fixture Supplier", label: "Plate X", field: "plate" },
      token,
    )
  ).status,
  200,
);
const rules = await (await call("/api/server/invoice-reader-rules")).json();
assert.equal(rules.rules.length, 1);
assert.equal(rules.rules[0].field, "plate");
assert.equal(
  (
    await call(
      rulesPath,
      {
        supplier: "Fixture Supplier",
        label: "constant",
        field: "replacePlateWith",
      },
      token,
    )
  ).status,
  400,
);
await call(rulesPath, { action: "delete", id: rules.rules[0].id }, token);
assert.equal(
  (await (await call("/api/server/invoice-reader-rules")).json()).rules.length,
  0,
);
// Pausing prevents bulk work but leaves new QR eligible; resume replaces the op identity.
const item = { id: "one", key: uploaded.attachment.key, name: "invoice.pdf" };
const batch = (
  await (
    await call(
      "/api/admin/service-documents/reprocess-batch",
      { action: "start", items: [item], mode: "server-first", forceRead: true },
      token,
    )
  ).json()
).batch;
assert.equal(batch.items[0].forceRead, true);
await call(
  "/api/admin/service-documents/reprocess-batch",
  { action: "pause", batchId: batch.id },
  token,
);
const paused = (await (await call("/api/server/pending?queue=invoices")).json())
  .operations;
assert.ok(!paused.some((o) => o.type === "service_document_reprocess_batch"));
const old = sqlite
  .prepare(
    "SELECT id FROM fleet_operations WHERE type='service_document_reprocess_batch' AND status='pending'",
  )
  .get().id;
await call(
  "/api/admin/service-documents/reprocess-batch",
  { action: "resume", batchId: batch.id },
  token,
);
assert.equal(
  sqlite.prepare("SELECT status FROM fleet_operations WHERE id=?").get(old)
    .status,
  "cancelled",
);
const bulk = (
  await (await call("/api/server/pending?queue=invoices&limit=10")).json()
).operations;
assert.ok(
  bulk.some(
    (o) => o.type === "service_document_reprocess_batch" && o.id !== old,
  ),
  JSON.stringify({
    bulk,
    settings: sqlite
      .prepare(
        "SELECT * FROM fleet_settings WHERE key='service_invoice_reprocess_batch'",
      )
      .get(),
    ops: sqlite
      .prepare(
        "SELECT id,status,payload FROM fleet_operations WHERE type='service_document_reprocess_batch'",
      )
      .all(),
  }),
);
// A local result explicitly marked ambiguous must call AI even with score 100.
let aiCalls = 0;
env.AI = {
  toMarkdown: async () => ({
    format: "markdown",
    data: "Πινακίδα: BTO-756\nΣύνολο 59,00\nΛάδι",
  }),
  run: async () => {
    aiCalls++;
    return {
      response: JSON.stringify({ ...local, rawText: "Πινακίδα: BTO-756" }),
    };
  },
};
const fallback = await call("/api/server/service-documents/reprocess-batch", {
  action: "result",
  batchId: batch.id,
  key: item.key,
  localOcr: { ...local, localReadStatus: "ambiguous" },
});
assert.equal(fallback.status, 200);
assert.equal(aiCalls, 1);
assert.equal((await fallback.json()).aiUsed, true);
console.log(
  "OK invoice drafts: auth, unsafe URLs, duplicate QR/identity, retry fencing, isolated preview, impact/date validation, idempotent commit, separate invoice date, rules, pause/resume and ambiguous AI fallback.",
);

// Restoring an older active draft must not make an otherwise valid merged
// backup fail because another draft of that QR exists after the backup.
const restoreQr=qr+'-restore',restoreId='restored-draft',owner=sqlite.prepare("SELECT owner_id FROM invoice_import_drafts LIMIT 1").get().owner_id;
sqlite.prepare("INSERT INTO invoice_import_drafts(id,owner_id,data,status,created_at,updated_at) VALUES(?,?,?,'ready',?,?)").run(restoreId,owner,JSON.stringify({qrUrl:restoreQr}),stamp,stamp);
sqlite.prepare("INSERT INTO invoice_import_drafts(id,owner_id,data,status,created_at,updated_at) VALUES(?,?,?,'ready',?,?)").run('post-backup-draft',owner,JSON.stringify({qrUrl:restoreQr}),stamp,stamp);
const beforeOps=sqlite.prepare('SELECT count(*) n FROM fleet_operations').get().n;
assert.equal((await (await call(endpoint,{action:'scan',value:restoreQr},token)).json()).duplicate,true);
assert.equal(sqlite.prepare('SELECT count(*) n FROM fleet_operations').get().n,beforeOps);
// A recovered old draft cannot silently attach the same R2 object elsewhere.
sqlite.prepare("UPDATE invoice_import_drafts SET status='ready' WHERE id=?").run(draft.draftId);
const recovered=await call(endpoint,{...commit,entryId:'service',confirmImpact:true},token);assert.equal(recovered.status,409);assert.equal((await recovered.json()).code,'duplicate_invoice');
console.log('OK draft recovery guards: merge-compatible restored rows, no new duplicate scan job and explicit duplicate confirmation for an already-linked recovered PDF.');

const concurrentQr=qr+'-concurrent';const concurrent=await Promise.all([call(endpoint,{action:'scan',value:concurrentQr},token),call(endpoint,{action:'scan',value:concurrentQr},token)]);
assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,202]);assert.equal(sqlite.prepare("SELECT count(*) n FROM invoice_import_drafts WHERE json_extract(data,'$.qrUrl')=? AND status='processing'").get(concurrentQr).n,1);
assert.equal(sqlite.prepare("SELECT count(*) n FROM fleet_operations WHERE json_extract(payload,'$.qrUrl')=? AND status='pending'").get(concurrentQr).n,1);
let active=sqlite.prepare("SELECT count(*) n FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing')").get(owner).n;
for(let i=active;i<199;i++)sqlite.prepare("INSERT INTO invoice_import_drafts(id,owner_id,data,status,created_at,updated_at) VALUES(?,?,?,'ready',?,?)").run('limit-'+i,owner,JSON.stringify({qrUrl:qr+'-limit-'+i}),stamp,stamp);
const limited=await Promise.all(Array.from({length:3},(_,i)=>call(endpoint,{action:'scan',value:qr+'-racing-limit-'+i},token)));
assert.equal(limited.filter(r=>r.status===202).length,1);assert.equal(limited.filter(r=>r.status===409).length,2);assert.equal(sqlite.prepare("SELECT count(*) n FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing')").get(owner).n,200);
console.log('OK concurrent QR scans: exactly one draft/job for a duplicate race and exactly 200 active drafts at a racing limit.');
