(function () {
  "use strict";
  const PREFIX = "fleet-view-cache-v1:",
    MAX = 1500000,
    AGE = 7 * 86400000;
  const allowed = (path) =>
    /^\/api\/(workforce\/(dashboard|vehicles|employees)(\?|$)|admin\/service-documents(\?|$))/.test(
      path,
    );
  function key(user, path) {
    return (
      PREFIX +
      String(user.id) +
      ":" +
      JSON.stringify(user.permissions || []) +
      ":" +
      path
    );
  }
  function read(user, path) {
    try {
      if (!user || !allowed(path)) return null;
      const item = JSON.parse(localStorage.getItem(key(user, path)) || "null");
      return item && Date.now() - item.at < AGE ? item : null;
    } catch (e) {
      return null;
    }
  }
  function save(user, path, data) {
    try {
      if (!user || !allowed(path)) return false;
      const text = JSON.stringify({ at: Date.now(), data });
      if (text.length > MAX) return false;
      const names = [];
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (name && name.startsWith(PREFIX)) names.push(name);
      }
      if (names.length > 12)
        names.forEach((name) => localStorage.removeItem(name));
      localStorage.setItem(key(user, path), text);
      return true;
    } catch (e) {
      return false;
    }
  }
  function invalidate() {
    try {
      const names = [];
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (name && name.startsWith(PREFIX)) names.push(name);
      }
      names.forEach((name) => localStorage.removeItem(name));
    } catch (e) {}
  }
  function clear(){invalidate();window.FleetPdfCache?.clear();window.FleetSharedReads?.clear();}
  window.FleetViewCache = { read, save, clear, invalidate };
})();
(function () {
  "use strict";
  const MAX_FILES = 10,
    MAX_BYTES = 40 * 1024 * 1024,
    AGE = 7 * 86400000;
  let database;
  function db() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (!database)
      database = new Promise((resolve) => {
        const req = indexedDB.open("fleet-recent-pdfs", 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore("pdfs", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
    return database;
  }
  function request(store, operation) {
    return new Promise((resolve) => {
      try {
        const r = operation(store);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  async function get(user, key) {
    try {
      const value = await db();
      if (!value || !user?.id) return null;
      const item = await request(
        value.transaction("pdfs").objectStore("pdfs"),
        (s) => s.get(user.id + ":" + key),
      );
      return item && Date.now() - item.at < AGE ? item.blob : null;
    } catch {
      return null;
    }
  }
  async function put(user, key, blob) {
    try {
      const value = await db();
      if (!value || !user?.id || blob.size > 15 * 1024 * 1024) return;
      const rows =
        (await request(value.transaction("pdfs").objectStore("pdfs"), (s) =>
          s.getAll(),
        )) || [];
      const tx = value.transaction("pdfs", "readwrite"),
        store = tx.objectStore("pdfs"),
        id = user.id + ":" + key,
        kept = rows.filter((r) => r.id !== id).sort((a, b) => b.at - a.at);
      let count = 1,
        bytes = blob.size;
      for (const row of kept) {
        count++;
        bytes += row.blob.size;
        if (count > MAX_FILES || bytes > MAX_BYTES || Date.now() - row.at > AGE)
          store.delete(row.id);
      }
      store.put({ id, blob, at: Date.now() });
    } catch {}
  }
  async function clear() {
    try {
      const value = await db();
      if (value)
        value.transaction("pdfs", "readwrite").objectStore("pdfs").clear();
    } catch {}
  }
  window.FleetPdfCache = { get, put, clear };
})();
