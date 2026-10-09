// The publishing credential is separate from the Android Server credential.
// Uploads are immutable; one D1 transaction switches all three active releases.
const PACKAGES = { client: "gr.argyrismitsos.fleetcontrol", server: "gr.argyrismitsos.fleetserver" };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const APK_LIMIT = 50 * 1024 * 1024;
function assetPath(value) {
  if (!value || value.length > 220 || value.includes("\\") || value.includes("%") || value.split("/").some(p => !p || p === "." || p === "..")) return "";
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : "";
}
function metadata(row) { try { return JSON.parse(row.manifest || "{}"); } catch { return {}; } }
function contentType(path) {
  return ({ apk: "application/vnd.android.package-archive", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", webmanifest: "application/manifest+json", png: "image/png", svg: "image/svg+xml" })[path.split(".").pop()] || "application/octet-stream";
}
export async function routeReleases(request, env, helpers) {
  const { json, secureEqual, serverAuthorized, digestHex, invalidateWeb } = helpers;
  const url = new URL(request.url), path = url.pathname;
  if (path.startsWith("/api/deploy/releases/")) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    if (!env.RELEASE_TOKEN || !token || !await secureEqual(token, env.RELEASE_TOKEN)) return json({ error: "Δεν επιτρέπεται η δημοσίευση." }, 401);
    if (!env.RELEASES) return json({ error: "Λείπει ο χώρος εκδόσεων." }, 503);
    if (path === "/api/deploy/releases/activate" && request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 128 * 1024) return json({ error: "Μεγάλο manifest." }, 413);
      const text = await request.text();
      if (text.length > 128 * 1024) return json({ error: "Μεγάλο manifest." }, 413);
      let body; try { body = JSON.parse(text); } catch { return json({ error: "Μη έγκυρο JSON." }, 400); }
      const releaseId = String(body.releaseId || ""), sourceCommit = String(body.sourceCommit || "");
      if (!ID.test(releaseId) || !/^[a-f0-9]{40}$/.test(sourceCommit)) return json({ error: "Λείπει έγκυρη ταυτότητα έκδοσης/κώδικα." }, 400);
      const records = [], now = new Date().toISOString(), notes = String(body.notes || "").slice(0, 500);
      for (const kind of ["client", "server"]) {
        const value = body[kind];
        if (!value || value.packageName !== PACKAGES[kind] || !Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || !/^\d+(\.\d+){1,3}$/.test(value.version || "") || !SHA.test(value.sha256 || "") || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > APK_LIMIT) return json({ error: `Μη έγκυρο ${kind} manifest.` }, 400);
        const key = `ota/${releaseId}/${kind}.apk`, object = await env.RELEASES.head(key);
        if (!object || object.size !== value.sizeBytes || object.customMetadata?.sha256 !== value.sha256) return json({ error: `Το ${kind} δεν ανέβηκε πλήρως.` }, 409);
        const current = await env.DB.prepare("SELECT manifest, sha256 FROM fleet_releases WHERE kind = ? AND active = 1 LIMIT 1").bind(kind).first();
        const currentCode = Number(metadata(current || {}).versionCode || 0);
        if (currentCode > value.versionCode || (currentCode === value.versionCode && current?.sha256 !== value.sha256)) return json({ error: `Χρειάζεται μεγαλύτερο versionCode για το ${kind}.` }, 409);
        records.push({ id: `${kind}-${releaseId}`, kind, version: value.version, key, size: value.sizeBytes, sha: value.sha256, manifest: JSON.stringify({ ...value, releaseId, sourceCommit }) });
      }
      const web = body.web;
      if (!web || typeof web.version !== "string" || !web.version || web.version.length > 40 || !Array.isArray(web.files) || web.files.length < 1 || web.files.length > 250) return json({ error: "Μη έγκυρο web manifest." }, 400);
      const paths = new Set(); let total = 0;
      for (const file of web.files) {
        const filePath = assetPath(file.path);
        if (!filePath || paths.has(filePath) || !SHA.test(file.sha256 || "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 10 * 1024 * 1024) return json({ error: "Μη έγκυρο αρχείο web." }, 400);
        paths.add(filePath); total += file.sizeBytes;
        const object = await env.RELEASES.head(`ota/${releaseId}/web/${filePath}`);
        if (!object || object.size !== file.sizeBytes || object.customMetadata?.sha256 !== file.sha256) return json({ error: `Δεν επαληθεύτηκε το ${filePath}.` }, 409);
      }
      if (!paths.has("index.html") || !paths.has("portal.html") || total > 60 * 1024 * 1024) return json({ error: "Το web πακέτο δεν είναι πλήρες." }, 400);
      records.push({ id: `web-${releaseId}`, kind: "web", version: web.version, key: `ota/${releaseId}/web/`, size: total, sha: "", manifest: JSON.stringify({ release: releaseId, releaseId, sourceCommit, files: [...paths], checksums: web.files }) });
      for (const record of records) {
        const old = await env.DB.prepare("SELECT manifest FROM fleet_releases WHERE id = ?").bind(record.id).first();
        if (old && old.manifest !== record.manifest) return json({ error: "Η ταυτότητα έκδοσης χρησιμοποιείται ήδη." }, 409);
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE fleet_releases SET active = 0 WHERE kind IN ('client', 'server', 'web')"),
        ...records.map(r => env.DB.prepare("INSERT INTO fleet_releases (id, kind, version, object_key, notes, manifest, size_bytes, sha256, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET active = 1").bind(r.id, r.kind, r.version, r.key, notes, r.manifest, r.size, r.sha, now))
      ]);
      invalidateWeb();
      return json({ activated: true, releaseId, sourceCommit, versions: records.map(r => ({ kind: r.kind, version: r.version })) });
    }
    const match = path.match(/^\/api\/deploy\/releases\/([^/]+)\/(client\.apk|server\.apk|web\/.+)$/);
    if (!match || request.method !== "PUT" || !ID.test(match[1]) || !assetPath(match[2])) return json({ error: "Μη έγκυρη διαδρομή δημοσίευσης." }, 400);
    const limit = match[2].endsWith(".apk") && !match[2].startsWith("web/") ? APK_LIMIT : 10 * 1024 * 1024;
    if (Number(request.headers.get("content-length") || 0) > limit) return json({ error: "Μεγάλο αρχείο." }, 413);
    // Read with a hard bound, including requests without Content-Length.
    const chunks = []; let length = 0; const reader = request.body?.getReader();
    if (!reader) return json({ error: "Κενό αρχείο." }, 400);
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); return json({ error: "Μεγάλο αρχείο." }, 413); } chunks.push(value); }
    if (!length) return json({ error: "Κενό αρχείο." }, 400);
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const sha256 = await digestHex(bytes), key = `ota/${match[1]}/${match[2]}`, old = await env.RELEASES.head(key);
    if (old && (old.customMetadata?.sha256 !== sha256 || old.size !== length)) return json({ error: "Τα αρχεία μιας έκδοσης δεν αντικαθίστανται." }, 409);
    if (!old) await env.RELEASES.put(key, bytes, { httpMetadata: { contentType: contentType(match[2]) }, customMetadata: { sha256 } });
    return json({ uploaded: true, sha256, sizeBytes: length });
  }
  const updateKind = path === "/api/client-update" ? "client" : path === "/api/server-update" ? "server" : null;
  const downloadKind = path === "/download/client.apk" ? "client" : path === "/download/server.apk" ? "server" : null;
  const kind = updateKind || downloadKind;
  if (!kind || request.method !== "GET") return null;
  if (kind === "server" && !await serverAuthorized(request, env)) return json({ error: "Μη έγκυρος server." }, 401);
  let row;
  if (downloadKind && url.searchParams.has("release")) row = await env.DB.prepare("SELECT * FROM fleet_releases WHERE id = ? AND kind = ?").bind(url.searchParams.get("release"), kind).first();
  else row = await env.DB.prepare("SELECT * FROM fleet_releases WHERE kind = ? AND active = 1 LIMIT 1").bind(kind).first();
  if (updateKind) {
    if (!row) return json({ available: false });
    const info = metadata(row);
    return json({ available: true, releaseId: row.id, version: row.version, versionCode: info.versionCode || 0, packageName: PACKAGES[kind], sizeBytes: row.size_bytes, sha256: row.sha256, notes: row.notes, sourceCommit: info.sourceCommit || "", createdAt: row.created_at, downloadUrl: `${url.origin}/download/${kind}.apk?release=${encodeURIComponent(row.id)}` });
  }
  if (!row) return json({ error: "Δεν βρέθηκε η έκδοση." }, 404);
  const object = await env.RELEASES.get(row.object_key);
  if (!object) return json({ error: "Δεν βρέθηκε το APK." }, 404);
  return new Response(object.body, { headers: { "Content-Type": contentType("app.apk"), "Content-Length": String(object.size), "Content-Disposition": `attachment; filename="Fleet_Control_${kind}_${row.version}.apk"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
