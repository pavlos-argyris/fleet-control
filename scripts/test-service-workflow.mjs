import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeBike, mergeBike } from "../cloudflare-worker/src/worker.js";

// Execute the shipped functions with controlled form fields and deferred APIs.
// This tests state and timing; it does not replace a real Android/browser test.
const app = fs.readFileSync(new URL("../cloudflare-worker/public/app.js", import.meta.url), "utf8");
function extract(source, name, indent = "  ") {
  const match = source.match(new RegExp("^" + indent + "(?:async )?function " + name + "\\([^]*?^" + indent + "\\}", "m"));
  assert.ok(match, "Missing shipped function: " + name);
  return match[0];
}
const names = ["selectedInvoiceFiles", "invoiceSelectionError", "normalizeQrValue", "normalizeQrUrl",
  "normalizeInvoiceData", "mergeInvoiceData", "invoiceDataFromAttachment", "ensureAttachmentQr",
  "invoicePlateKey", "invoiceWarnings", "applyInvoiceReviewToEntry", "getHistoryEntry",
  "attachInvoiceToEntry", "attachInvoicesToEntry", "invoiceBatchMessage", "mergeBackgroundBike",
  "backgroundHistorySaveMarkup", "enqueueHistoryEntrySave", "runBackgroundHistorySave",
  "handleHistoryEntrySubmit", "handleServiceSubmit", "updateServicePreview",
  "hasVisibleQrProcessing", "refreshVisibleQrProgress"];
const shipped = names.map((name) => extract(app, name)).join("\n");
const noop = () => {};
const plain = (value) => JSON.parse(JSON.stringify(value));
const event = { preventDefault: noop };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const bike = () => ({ id: "bike", name: "ΒΤΟ 756", intervalKm: 3000, lastServiceKm: 10000,
  currentKm: 12000, nextServiceKm: 13000, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
  history: [{ id: "entry-1", type: "service", km: 9000, date: "2026-10-01", tasks: ["Γενικός έλεγχος"], oilChanged: false, attachments: [] },
    { id: "entry-2", type: "service", km: 9100, date: "2026-10-02", tasks: ["Γενικός έλεγχος"], oilChanged: false, attachments: [] }] });
function fixture() {
  const trace = [];
  const field = (value = "") => ({ value, checked: false, focus: () => trace.push("focus"), textContent: "",
    classList: { toggle(name, hidden) { this[name] = hidden; } } });
  const elements = { serviceForm: { dataset: {} } };
  for (const key of ["serviceBikeId", "serviceKm", "serviceDate", "serviceOilChanged", "serviceMajorService",
    "serviceNotes", "serviceWorkshop", "serviceCost", "serviceFormError", "serviceMileageWarning", "serviceNextPreview",
    "historyEntryBikeId", "historyEntryId", "historyEntryKm", "historyEntryDate", "historyEntryNotes", "historyEntryWorkshop",
    "historyEntryCost", "historyEntryOilChanged", "historyEntryMajorService", "historyEntryReason", "historyEntryError"]) elements[key] = field();
  Object.assign(elements, {
    serviceInvoiceFile: { files: [] }, historyEntryInvoiceFile: { files: [] },
    serviceInvoiceQrValue: field(), historyEntryInvoiceQrValue: field(),
    serviceTaskInputs: [{ value: "Γενικός έλεγχος", checked: true }],
    historyEntryTaskInputs: [{ value: "Γενικός έλεγχος", checked: true }],
    serviceDialog: { close: () => trace.push("close-service") },
    historyEntryDialog: { close: () => trace.push("close-history") }
  });
  elements.serviceBikeId.value = elements.historyEntryBikeId.value = "bike";
  elements.serviceKm.value = elements.historyEntryKm.value = "9000";
  elements.serviceDate.value = elements.historyEntryDate.value = "2026-10-01";
  elements.historyEntryId.value = "entry-1";
  let counter = 0;
  const ctx = vm.createContext({ URL, console, navigator: { onLine: true }, elements, bikes: [bike()],
    window: { confirm: () => true }, MAX_SERVICE_ATTACHMENTS: 10, activeBikeId: "bike",
    backgroundHistorySaves: new Map(), historyEntrySaveQueue: Promise.resolve(), qrProgressRefreshRunning: false,
    uid: () => "job-" + (++counter), formatKm: String, formatDate: String, parseInvoiceKm: Number,
    escapeHtml: String, invoiceLineText: String, refreshMajorTracking: noop,
    invoiceDisplayName: (_bike, _data, _entry, file) => file.name,
    appendInvoiceWork: (entry, data) => { if (data.workPerformed) entry.tasks.push(data.workPerformed); },
    renderHome: noop, renderDetail: noop, persistBikes: noop, saveBikes: () => trace.push("local-save"),
    showToast: (value) => trace.push(value), canManageHistory: () => true,
    normalizeBike, mergeBikeRecords: mergeBike,
    updateQrProcessingLocal: noop, localHistoryEdit: () => trace.push("offline-edit"),
    syncNow: async () => {}, requestHeaders: () => ({}), document: { hidden: false }, webToken: "test", apiBase: "https://test.invalid"
  });
  ctx.getBike = (id) => ctx.bikes.find((item) => item.id === id);
  vm.runInContext(shipped, ctx);
  return { ctx, elements, trace };
}

for (const accepted of [true, false]) {
  const { ctx, trace } = fixture();
  let warnings = 0;
  ctx.window.confirm = (message) => { warnings++; assert.match(message, /9000.*10000/); return accepted; };
  const before = plain(ctx.bikes);
  await ctx.handleServiceSubmit(event);
  assert.equal(warnings, 1);
  if (accepted) {
    assert.equal(ctx.bikes[0].history[0].km, 9000);
    assert.equal(ctx.bikes[0].lastServiceKm, 10000);
    assert.equal(ctx.bikes[0].currentKm, 12000);
    assert.equal(ctx.bikes[0].nextServiceKm, 13000);
    assert.ok(trace.includes("close-service"));
  } else {
    assert.deepEqual(plain(ctx.bikes), before);
    assert.equal(trace.includes("close-service"), false);
    assert.equal(trace.includes("local-save"), false);
  }
}
{
  const { ctx, elements } = fixture();
  elements.serviceOilChanged.checked = true;
  ctx.updateServicePreview();
  assert.equal(elements.serviceMileageWarning.classList["is-hidden"], false);
  assert.equal(elements.serviceNextPreview.textContent, "Δεν αλλάζει — 13000");
  await ctx.handleServiceSubmit(event);
  assert.equal(ctx.bikes[0].history[0].oilChanged, true);
  assert.equal(ctx.bikes[0].lastServiceKm, 10000, "Historical oil must not replace the active cycle.");
  elements.serviceKm.value = "12100";
  ctx.updateServicePreview();
  assert.equal(elements.serviceMileageWarning.classList["is-hidden"], true);
  await ctx.handleServiceSubmit(event);
  assert.equal(ctx.bikes[0].lastServiceKm, 12100);
  assert.equal(ctx.bikes[0].nextServiceKm, 15100);
}
console.log("OK service form: warning/confirmation, cancellation and preserved current km/oil cycle");

for (const source of [app, fs.readFileSync(new URL("../cloudflare-worker/public/portal.js", import.meta.url), "utf8"),
  fs.readFileSync(new URL("../cloudflare-worker/src/worker.js", import.meta.url), "utf8")]) {
  const ctx = vm.createContext({});
  vm.runInContext(extract(source, "invoicePlateKey", source === app || source.includes("function renderInvoiceQueue") ? "  " : ""), ctx);
  for (const equivalent of ["ΒΤΟ 756", "BTO-756", "bto756", "βτο–756", " B Τ O ‑ 756 ", "ＢＴＯ－７５６"]) {
    assert.equal(ctx.invoicePlateKey(equivalent), "BTO756");
  }
  assert.notEqual(ctx.invoicePlateKey("BTO-757"), ctx.invoicePlateKey("ΒΤΟ 756"));
  assert.notEqual(ctx.invoicePlateKey("BT0-756"), ctx.invoicePlateKey("ΒΤΟ 756"));
  assert.notEqual(ctx.invoicePlateKey("ΣΟ 756"), ctx.invoicePlateKey("CO-756"));
}
{
  const { ctx } = fixture();
  assert.equal(ctx.invoiceWarnings(ctx.bikes[0], { km: 9000 }, { plate: "BTO-756", odometerKm: "9000" }).length, 0);
  assert.equal(ctx.invoiceWarnings(ctx.bikes[0], { km: 9000 }, { plate: "BTO-757", odometerKm: "9100" }).length, 2);
}
console.log("OK plate comparison across Worker, Web and Client: spaces/dashes, Greek/Latin, real differences");

{
  const { ctx } = fixture();
  const entry = ctx.bikes[0].history[0];
  entry.invoiceData = { invoiceNumber: "OLD", totalAmount: "99", supplier: "Previous supplier" };
  entry.attachments.push({ key: "old", name: "old.pdf", ocr: { invoiceNumber: "OLD", totalAmount: "99" } });
  let qrImports = 0;
  ctx.importQrDocument = async () => { qrImports++; throw new Error("Selected files should be uploaded."); };
  ctx.uploadServiceDocument = async (_bikeId, _entryId, file) => {
    if (file.name === "bad.pdf") throw new Error("Temporary failure");
    return { key: "uploaded/" + file.name, name: file.name, ocr: { invoiceNumber: file.name } };
  };
  const result = await ctx.attachInvoicesToEntry("bike", "entry-1", [{ name: "one.pdf" }, { name: "bad.pdf" }, { name: "two.pdf" }],
    "https://einvoice.example/first", { background: true, deferQrCompletion: true });
  assert.equal(qrImports, 0);
  assert.equal(result.attachments.length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, "bad.pdf");
  assert.deepEqual(entry.attachments.map((file) => file.key), ["old", "uploaded/one.pdf", "uploaded/two.pdf"]);
  assert.equal(entry.attachments[1].ocr.totalAmount, undefined);
  assert.equal(entry.attachments[2].ocr.supplier, undefined);
  assert.equal(entry.attachments[0].ocr.totalAmount, "99");
  assert.ok(ctx.invoiceSelectionError({ attachments: Array(10).fill({ key: "existing" }) }, [{ name: "new.pdf" }], ""));
}
console.log("OK invoice batch: all files, QR belongs to first file, partial failure and separate invoice fields");

{
  const { ctx, elements, trace } = fixture();
  const first = deferred();
  const requests = [];
  const imported = [];
  ctx.remoteHistoryAction = async (bikeId, entryId, _action, payload) => {
    requests.push({ bikeId, entryId, payload: plain(payload) });
    if (requests.length === 1) await first.promise;
    const result = plain(ctx.getBike(bikeId));
    Object.assign(result.history.find((entry) => entry.id === entryId), payload, { updatedAt: new Date().toISOString() });
    return { bike: result };
  };
  ctx.importQrDocument = async (bikeId, entryId, value) => {
    imported.push({ bikeId, entryId, value });
    return { queued: true, jobId: "qr-" + entryId, progress: 5 };
  };
  ctx.waitForQrDocumentJob = () => { throw new Error("Form saves must not wait for Server rendering."); };
  elements.historyEntryInvoiceQrValue.value = "https://einvoice.example/first";
  const submit = ctx.handleHistoryEntrySubmit(event);
  assert.equal(trace.includes("close-history"), true, "Dialog closes before an API request completes.");
  await submit;
  assert.equal(requests.length, 1);
  elements.historyEntryId.value = "entry-2";
  elements.historyEntryKm.value = "9100";
  elements.historyEntryInvoiceQrValue.value = "https://einvoice.example/second";
  await ctx.handleHistoryEntrySubmit(event);
  assert.equal(trace.filter((item) => item === "close-history").length, 2);
  assert.equal(requests.length, 1, "Second save stays queued while the first save is awaiting its API.");
  elements.historyEntryInvoiceQrValue.value = "https://einvoice.example/changed-form";
  assert.equal(ctx.backgroundHistorySaves.size, 2);
  first.resolve();
  await ctx.historyEntrySaveQueue;
  assert.deepEqual(requests.map((item) => item.entryId), ["entry-1", "entry-2"]);
  assert.equal(requests[0].payload.km, 9000);
  assert.equal(requests[1].payload.km, 9100);
  assert.deepEqual(imported.map((item) => [item.entryId, item.value]), [
    ["entry-1", "https://einvoice.example/first"], ["entry-2", "https://einvoice.example/second"]]);
  assert.equal(ctx.backgroundHistorySaves.size, 0);
}
{
  const { ctx } = fixture();
  let edits = 0;
  let rejectFile = true;
  const attempts = [];
  ctx.remoteHistoryAction = async () => { edits++; return { bike: plain(ctx.bikes[0]) }; };
  ctx.uploadServiceDocument = async (_bikeId, _entryId, file) => {
    attempts.push(file.name);
    if (file.name === "retry.pdf" && rejectFile) throw new Error("Try later");
    return { key: file.name, name: file.name };
  };
  const job = { id: "retry-job", bikeId: "bike", entryId: "entry-1", payload: {}, saved: false, label: "Test",
    files: [{ name: "ok.pdf" }, { name: "retry.pdf" }], qrValue: "" };
  ctx.enqueueHistoryEntrySave(job);
  await ctx.historyEntrySaveQueue;
  assert.equal(job.status, "error");
  assert.equal(job.files.length, 1);
  assert.equal(job.files[0].name, "retry.pdf");
  assert.match(ctx.backgroundHistorySaveMarkup("bike", "entry-1"), /Επανάληψη/);
  rejectFile = false;
  ctx.enqueueHistoryEntrySave(job);
  await ctx.historyEntrySaveQueue;
  assert.equal(edits, 1, "Retry only failed invoices after a successful service edit.");
  assert.deepEqual(attempts, ["ok.pdf", "retry.pdf", "retry.pdf"]);
  assert.equal(ctx.backgroundHistorySaves.size, 0);
  assert.equal(ctx.getHistoryEntry(ctx.getBike("bike"), "entry-1").attachments.length, 2);
}
{
  const { ctx, elements, trace } = fixture();
  ctx.navigator.onLine = false;
  elements.historyEntryInvoiceFile.files = [{ name: "offline.pdf" }];
  await ctx.handleHistoryEntrySubmit(event);
  assert.equal(trace.includes("close-history"), false);
  assert.match(elements.historyEntryError.textContent, /σύνδεση/);
  elements.historyEntryInvoiceFile.files = [];
  await ctx.handleHistoryEntrySubmit(event);
  assert.ok(trace.includes("offline-edit") && trace.includes("close-history"));
}
console.log("OK background saves: immediate close, independent QR/form state, serial saves, failed-file retry and offline validation");

{
  const { ctx } = fixture();
  ctx.bikes[0].history[0].invoiceData = { qrJobId: "pending", qrProcessingStatus: "processing" };
  const fetchResult = deferred();
  const updates = [];
  ctx.fetch = () => fetchResult.promise;
  ctx.updateQrProcessingLocal = (bikeId, entryId) => updates.push([bikeId, entryId]);
  const polling = ctx.refreshVisibleQrProgress();
  ctx.activeBikeId = "another-bike";
  fetchResult.resolve({ ok: true, json: async () => ({ status: "processing", progress: 20 }) });
  await polling;
  assert.deepEqual(updates, [["bike", "entry-1"]]);
}
console.log("OK QR progress remains associated with its original bike after navigation");

// Rejecting an old-date cycle advancement must leave the entire bike unchanged.
for (const accepted of [false, true]) {
  const {ctx,elements}=fixture();elements.serviceKm.value="11000";elements.serviceOilChanged.checked=true;
  const before=plain(ctx.bikes);let warnings=0;ctx.window.confirm=message=>{warnings++;assert.match(message,/παλαιότερη/);return accepted;};
  await ctx.handleServiceSubmit(event);assert.equal(warnings,1);
  if(!accepted)assert.deepEqual(plain(ctx.bikes),before);else assert.equal(ctx.bikes[0].lastServiceKm,11000);
}
console.log("OK historical service impact: confirmation occurs before odometer/oil-cycle mutations; rejection preserves the entire bike.");
{
 const {ctx}=fixture();ctx.remoteHistoryAction=async()=>{throw Object.assign(new Error('Το ιστορικό άλλαξε'),{status:409});};
 const job={id:'stale-preview',bikeId:'bike',entryId:'entry-1',payload:{impactToken:'old'},files:[],qrValue:'',saved:false,label:'Test'};ctx.enqueueHistoryEntrySave(job);await ctx.historyEntrySaveQueue;
 assert.equal(job.status,'error');assert.equal(job.requiresPreview,true);assert.match(ctx.backgroundHistorySaveMarkup('bike','entry-1'),/Επανέλεγχος αλλαγών/);
}
console.log('OK stale background edits retain their job and request a fresh consequence preview instead of replaying an old confirmation.');
