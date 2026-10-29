const CACHE_NAME = "fleet-control-v5-57-0";
const ASSET_BASE="./assets/v5.57.0/";
const APP_SHELL = ["shared-requests.js","live-changes.js","fleet-motion.js","fleet-motion.css"].map(f=>ASSET_BASE+f).concat([
  "./ui-system.css", "./service-model.js", "./fleet-operations-model.js", "./fleet-operations.js", "./service-tools.js", "./fleet-navigation.js", "./service-tools.css", "./service-storage.js", "./service-export.js",
  "./store-billing.js", "./store-billing.css", "./ordexa-server-ui.js", "./ordexa-server-ui.css", "./ordexa-pay-core.js", "./ordexa-pay-ui.js", "./ordexa-ui.js", "./ordexa-ui.css", "./local-view-cache.js", "./invoice-import-ui.js", "./invoice-retry.js",
  "./service-followup.js", "./service-followup.css", "./sequential-review.js",
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./client-ota.js",
  "./client-ota.css",
  "./scroll-stability.css",
  "./scroll-stability.js",
  "./vendor/jsQR.js",
  "./vendor/qrcode-generator.js",
  "./portal.html",
  "./portal.css",
  "./portal.js",
  "./fleet-config.js",
  "./manifest.webmanifest",
  "./templates/Fleet_Control_Schedule_Import_Template.xlsx",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
].map(p=>/^\.\/[^/]+\.(?:js|css)$/.test(p)&&!p.endsWith("fleet-config.js")&&!p.endsWith("service-worker.js")?ASSET_BASE+p.slice(2):p));

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (key) {
          return key !== CACHE_NAME;
        }).map(function (key) {
          return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/download/")) return;
  const isDocument = event.request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname === "/fleet" || url.pathname === "/portal";
  if (!isDocument) {
    event.respondWith(caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      });
    }));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (cached) {
          if (cached) return cached;
          const path = new URL(event.request.url).pathname;
          return caches.match(path === "/fleet" || path.endsWith("/index.html") ? "./index.html" : "./portal.html");
        });
      })
  );
});
