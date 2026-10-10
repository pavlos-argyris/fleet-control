import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../cloudflare-worker/package.json", import.meta.url),
);
const { JSDOM } = require("jsdom");
const html = fs.readFileSync("cloudflare-worker/public/portal.html", "utf8");
const dom = new JSDOM(html, {
    url: "https://fixture.invalid/portal.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  }),
  w = dom.window;
Object.defineProperty(w.document, "hidden", { value: false });
w.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
w.HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new w.Event("close"));
};
let poll,
  posts = [],
  confirmations = 0,
  opened = 0;
w.setInterval = (fn) => {
  poll = fn;
  return 1;
};
w.clearInterval = () => {};
w.confirm = () => {
  confirmations++;
  return true;
};
const draft = {
    id: "draft-test-1",
    status: "processing",
    stage: "Αναμονή Server",
  },
  bikes = [{ id: "bike", name: "ΒΤΟ 756" }];
let rules = [];
let saved = false;
w.FleetInvoiceApi = {
  can: () => true,
  toast() {},
  openPdf() {
    opened++;
  },
  refresh() {},
  getDocuments: () => [],
  getBatch: () => ({}),
  batchAction() {},
  reprocess() {},
  async api(path, options = {}) {
    if (path.startsWith("/api/admin/invoice-imports/targets"))
      return {
        bike: { id: "bike" },
        services: [{ id: "existing", date: "2026-10-01", km: 9000 }],
      };
    if (path === "/api/admin/invoice-imports" && !options.body)
      return { drafts: JSON.parse(JSON.stringify([draft])), bikes };
    if (path === "/api/admin/invoice-imports") {
      const body = options.body;
      posts.push(body);
      if (body.action === "scan")
        return {
          duplicate: true,
          matches: [
            {
              bikeName: "ΒΤΟ 756",
              serviceDate: "2026-10-01",
              key: "service-documents/existing.pdf",
            },
          ],
        };
      if (body.action === "commit") {
        if (!body.confirmImpact) {
          const e = new Error("Impact");
          e.code = "service_impact";
          e.details = {
            before: { currentKm: 10000, nextServiceKm: 12000 },
            after: { currentKm: 11000, nextServiceKm: 14000 },
          };
          throw e;
        }
        draft.status = "committed";
        saved = true;
        return { ok: true };
      }
      return { ok: true };
    }
    if (path === "/api/admin/invoice-reader-rules") {
      if (options.body) {
        rules.push(options.body);
        return { ok: true };
      }
      return { rules };
    }
    return {};
  },
};
w.eval(
  fs.readFileSync("cloudflare-worker/public/invoice-import-ui.js", "utf8"),
);
const $ = (id) => w.document.getElementById(id),
  flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
await w.FleetInvoiceImports.open();
assert.equal($("invoiceImportDialog").open, true);
assert.match($("invoiceImportList").textContent, /Αναμονή/);
draft.status = "ready";
draft.invoiceData = {
  plate: "BTO-756",
  invoiceDate: "02/10/2026",
  odometerKm: "11000",
  totalAmount: "59,00",
  workPerformed: ["Αλλαγή λαδιών"],
};
draft.attachment = { key: "service-documents/draft.pdf" };
poll();
await flush();
assert.equal(
  w.document.querySelector('[data-field="bikeId"]').value,
  "bike",
  "ready transition must fill the exact fleet plate",
);
assert.equal(w.document.querySelector('[data-field="km"]').value, "11000");
assert.equal(
  w.document.querySelector('[data-field="date"]').value,
  "2026-10-02",
);
assert.equal(
  w.document.querySelector('[data-field="entryId"]').options.length,
  2,
);
const tasks = w.document.querySelector('[data-field="tasks"]');
tasks.value = "Δική μου εργασία";
tasks.dispatchEvent(new w.Event("input", { bubbles: true }));
tasks.focus();
poll();
await flush();
assert.equal(
  w.document.querySelector('[data-field="tasks"]').value,
  "Δική μου εργασία",
  "poll must preserve manual edits",
);
tasks.blur();
const checked = w.document.querySelector('[data-field="checked"]');
checked.checked = true;
checked.dispatchEvent(new w.Event("input", { bubbles: true }));
await w.document.querySelector('[data-action="commit"]').click();
await flush();
assert.equal(saved, true);
assert.equal(confirmations, 1);
assert.equal(posts.filter((p) => p.action === "commit").length, 2);
assert.equal(
  posts.filter((p) => p.action === "commit")[1].tasks,
  "Δική μου εργασία",
);
assert.match($("invoiceImportList").textContent, /Δεν υπάρχουν ενεργά/);
$("invoiceImportQr").value =
  "https://invoice.invalid/qr\nhttps://invoice.invalid/qr";
$("invoiceImportAdd").click();
await flush();
assert.equal(
  posts.filter((p) => p.action === "scan").length,
  1,
  "same-session duplicate scan must not create two requests",
);
const duplicateOpen = $("invoiceImportStatus").querySelector("button");
assert.ok(duplicateOpen);
duplicateOpen.click();
assert.equal(opened, 1);
w.FleetInvoiceImports.showEvidence({
  analysisEngine: "tesseract-ell-eng",
  fieldEvidence: {
    plate: {
      score: 85,
      reason: "Label",
      source: "tesseract",
      evidence: "<script>bad</script>",
    },
  },
});
assert.equal($("invoiceFieldEvidence").querySelector("script"), null);
assert.match($("invoiceFieldEvidence").textContent, /<script>bad<\/script>/);
w.dispatchEvent(new w.PopStateEvent("popstate"));
assert.equal($("invoiceImportDialog").open, false, "Back must close imports");
$("invoiceReaderRules").click();
await flush();
assert.equal($("invoiceRulesDialog").open, true);
const form = $("invoiceRulesDialog").querySelector("form");
form.elements.supplier.value = "Fixture Supplier";
form.elements.label.value = "Αρ. κυκλοφορίας";
form.elements.field.value = "plate";
form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await flush();
assert.equal(rules.length, 1);
assert.equal(rules[0].field, "plate");
assert.equal($("invoiceRulesDialog").open, false);
dom.window.close();
console.log(
  "OK actual invoice import UI: processing→ready defaults, exact Greek/Latin plate, service targets, polling preserves edits, explicit impact confirmation, session scan deduplication, previous-PDF link, evidence escaping, Back and approved label rules.",
);
