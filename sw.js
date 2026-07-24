// Offline-first app shell cache (Mark, 2026-07-12: "a tech must be able to
// open RoofOps on a dead-zone roof and have it work at all"). This is
// deliberately scoped to STATIC ASSETS ONLY (index.html, css/js files,
// manifest, icons) -- it never touches Firestore/Storage/Netlify Function
// traffic, which needs real network semantics (fresh auth tokens, live
// data, streaming) and would be actively wrong to serve from a cache.
//
// Cache-busting strategy: network-first, cache as fallback only. Every
// successful request while online re-populates the cache, so an online
// user always gets the current deploy -- the cache is purely insurance
// for when there's no network to ask at all, never a reason to see stale
// content while online. This avoids the classic "stuck on an old service-
// worker cache after a new deploy" trap without needing a build step to
// generate hashed filenames (this app has none).
const CACHE_NAME = "roofops-shell-v2";
const SHELL_PATHS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/app.css?v=20260724b",
  "/js/core.js?v=20260724b",
  "/js/companycam.js?v=20260724b",
  "/js/export.js?v=20260724b",
  "/js/history.js?v=20260724b",
  "/js/photos.js?v=20260724b",
  "/js/roofmapper.js?v=20260724b",
  "/js/workorders.js?v=20260724b"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      // skipWaiting: a tech reopening the app after a deploy shouldn't be
      // stuck on the OLD service worker until every tab closes -- combined
      // with clients.claim() in activate below, a fresh load picks up the
      // new worker (and, since fetch below is network-first, the new
      // deploy's actual files) right away.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function isAppApiRequest(url) {
  // Netlify Functions (admin/auth/photos/inspection-reports/companycam/
  // send-workorder/outlook/...) and every Firebase/Google endpoint the
  // Firestore/Storage/Auth SDKs talk to -- none of this is ever cached.
  if (url.pathname.startsWith("/.netlify/functions/")) return true;
  if (/(^|\.)googleapis\.com$/.test(url.hostname)) return true;
  if (/(^|\.)firebaseio\.com$/.test(url.hostname)) return true;
  if (/(^|\.)firebasestorage\.app$/.test(url.hostname)) return true;
  if (/(^|\.)gstatic\.com$/.test(url.hostname)) return true; // Firebase SDK script CDN -- let the browser's own HTTP cache handle it, not this worker
  if (/(^|\.)companycam\.com$/.test(url.hostname)) return true;
  if (/(^|\.)resend\.com$/.test(url.hostname)) return true;
  if (/openstreetmap\.org$/.test(url.hostname) || /arcgisonline\.com$/.test(url.hostname)) return true; // map tiles -- huge, not app-shell, browser HTTP cache is the right layer for these
  return false;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (isAppApiRequest(url)) return; // let the browser handle these completely normally, no interception at all

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Navigating to some other path (deep link) with no network and
          // no cached copy of that exact URL -- fall back to the shell so
          // the app at least loads instead of a browser error page. Static
          // asset requests (css/js) with no cached copy legitimately fail
          // here; there's nothing sensible to substitute for those.
          if (event.request.mode === "navigate") return caches.match("/index.html");
          return Response.error();
        })
      )
  );
});
