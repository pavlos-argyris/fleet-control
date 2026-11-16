import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const values = new Map();
const localStorage = {
  getItem: (k) => values.get(k) || null,
  setItem: (k, v) => values.set(k, v),
  removeItem: (k) => values.delete(k),
  key: (i) => [...values.keys()][i],
  get length() {
    return values.size;
  },
};
let now = 1000000000;
const context = vm.createContext({
  localStorage,
  window: {},
  Date: { now: () => now },
});
vm.runInContext(
  fs.readFileSync("cloudflare-worker/public/local-view-cache.js", "utf8"),
  context,
);
const cache = context.window.FleetViewCache,
  user = { id: "one", permissions: ["fleet.view"] },
  path = "/api/admin/service-documents";
assert.equal(cache.save(user, path, { documents: [{ id: "one" }] }), true);
assert.equal(cache.read(user, path).data.documents[0].id, "one");
assert.equal(
  cache.read({ ...user, id: "two" }, path),
  null,
  "another account must not read the cache",
);
assert.equal(
  cache.read({ ...user, permissions: [] }, path),
  null,
  "permission changes invalidate cache identity",
);
cache.save(user,path,{documents:[{id:"session-private"}]},"one-session");assert.equal(cache.read(user,path,"another-session"),null,"new login cannot reuse an earlier session snapshot");
assert.equal(cache.save(user, "/api/auth/me", { token: "never" }), false);
assert.equal(
  cache.save(user, "/api/workforce/payroll", { secret: "never" }),
  false,
);
assert.equal(values.size,0,"private snapshots never enter persistent browser storage");
now += 300001;
assert.equal(
  cache.read(user, path),
  null,
  "expired cache must not be displayed",
);
cache.clear();
assert.equal(values.size, 0);
const portal = fs.readFileSync("cloudflare-worker/public/portal.js", "utf8");
const apiSource = portal.slice(
  portal.indexOf("  async function api("),
  portal.indexOf("  function escapeHtml("),
);
let fetched = 0;
let resolve;
const response = new Promise((r) => (resolve = r)),
  state = { token: "fixture", user, previewSession: false };
const apiContext = vm.createContext({
  state,
  window: { FleetViewCache: cache },
  Headers,
  navigator: { onLine: true },
  apiBase: "https://fixture",
  recordApiTiming() {},
  renderCacheStatus() {},
  fetch: async () => {
    fetched++;
    return response;
  },
});
vm.runInContext(apiSource, apiContext);
const first = apiContext.api(path),
  second = apiContext.api(path);
assert.equal(fetched, 1, "identical concurrent reads must coalesce");
resolve(
  new Response(JSON.stringify({ documents: [{ id: "new" }] }), { status: 200 }),
);
assert.equal((await first).documents[0].id, "new");
assert.equal((await second).documents[0].id, "new");
state.previewSession = true;
assert.equal((await apiContext.api(path)).documents[0].id, "new");
assert.equal(fetched, 1);
await assert.rejects(
  apiContext.api("/api/workforce/vehicles", { body: {} }),
  /επιβεβαιωθεί/,
  "cached preview must not write",
);
console.log(
  "OK view cache: account/permission isolation, whitelist, expiry, clearing, coalesced reads and read-only cached preview.",
);
// Private PDF copies remain short-lived RAM, across roles and browser reloads.
const pdfRows = new Map();
function success(value) {
  const result = {};
  queueMicrotask(() => {
    result.result = value;
    result.onsuccess?.();
  });
  return result;
}
const store = {
  get: (id) => success(pdfRows.get(id)),
  getAll: () => success([...pdfRows.values()]),
  put: (row) => pdfRows.set(row.id, row),
  delete: (id) => pdfRows.delete(id),
  clear: () => pdfRows.clear(),
};
const fakeDb = {
  transaction: () => ({ objectStore: () => store }),
  createObjectStore() {},
};
let databaseOpens=0;const indexedDB = { open: () => {databaseOpens++;return success(fakeDb);} };
const pdfContext = vm.createContext({
  window: { indexedDB },
  indexedDB,
  localStorage,
  Date,
  Blob,
});
vm.runInContext(
  fs.readFileSync("cloudflare-worker/public/local-view-cache.js", "utf8"),
  pdfContext,
);
const pdfCache = pdfContext.window.FleetPdfCache;
for (let i = 0; i < 13; i++)
  await pdfCache.put(user, "key-" + i, new Blob(["%PDF-" + i]));
assert.equal(databaseOpens,0,"private PDFs never open persistent IndexedDB storage");
assert.equal(await pdfCache.get(user,"key-0"),null,"RAM cache evicts old PDFs beyond four files");
assert.equal(await pdfCache.get({...user,permissions:[]},"key-12"),null,"PDF permission partition");
assert.equal(await pdfCache.get({ ...user, id: "other" }, "key-12"), null);
assert.equal(await (await pdfCache.get(user, "key-12")).text(), "%PDF-12");
await pdfCache.clear();
assert.equal(pdfRows.size, 0);
console.log(
  "OK bounded recent PDF cache: at most 4 RAM files, no persistent browser storage, account isolation, real Blob preservation and logout clearing.",
);
