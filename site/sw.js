/* Restaurant Diary service worker: the diary opens instantly and works offline.

   The app's own files come from a cache stamped with the published version
   (BUILD is replaced by the publish workflow), so a new version installs itself
   in the background and the page switches over on its next quiet moment.
   The shared diary, Google and OpenStreetMap are never cached here. */

const BUILD = "__BUILD__";
const APP_CACHE = "diary-app-" + BUILD;
const RUNTIME_CACHE = "diary-runtime";
const PHOTO_CACHE = "diary-photos";

const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/config.js", "js/store.js", "js/cloud.js", "js/google.js", "js/osm.js", "js/map.js",
  "vendor/supabase.js",
  "icons/favicon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("diary-app-") && key !== APP_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function fromCacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit || fresh;
}

// A photo gets a freshly signed link now and then, so it's kept under its path
// without the signature: once seen, it shows offline and never downloads twice.
async function photo(request, url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(key, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Sharing a reel to the diary lands here (see share_target in the manifest);
  // hand the link to the page itself.
  if (url.origin === self.location.origin && url.pathname.endsWith("/share")) {
    const target = new URL("./", self.registration.scope);
    target.search = url.search;
    event.respondWith(Response.redirect(target.href, 303));
    return;
  }

  if (url.origin === self.location.origin) {
    // The restaurant index is big and changes rarely: cached the first time it's used.
    if (url.pathname.endsWith("/data/il-places.json")) event.respondWith(staleWhileRevalidate(request));
    else event.respondWith(fromCacheFirst(request));
    return;
  }
  if (url.hostname.endsWith(".supabase.co") && url.pathname.includes("/storage/v1/object/sign/")) {
    event.respondWith(photo(request, url));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
