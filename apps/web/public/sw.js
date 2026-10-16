// Wheelhouse service worker. Hand-written on purpose: the policy is small and security-sensitive.
//
// The app is a single-page app: every address is the same index.html, and every piece of user data arrives from /api, which this
// worker never touches. So the only things worth caching are the built, content-hashed files under /assets/ (shared by all
// users) and one static offline page. It never caches /api/*, /mcp, non-GET requests (anything that changes data) or
// cross-origin requests, and it never caches a page, so nothing about a person can be left behind in it.
const VERSION = "v2";
const STATIC = `wh-static-${VERSION}`;
const PAGES = `wh-pages-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(PAGES).then((c) => c.add(OFFLINE_URL)));
  // No skipWaiting here: the page prompts "Reload to update" and sends SKIP_WAITING.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (![STATIC, PAGES].includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
  if (e.data === "CLEAR_CACHES") e.waitUntil(clearUserData());
});

// Called before signing out. Nothing per-user is cached any more, but a cache that is wiped on sign-out is a promise worth keeping.
async function clearUserData() {
  await caches.delete(PAGES);
  await caches.open(PAGES).then((c) => c.add(OFFLINE_URL)).catch(() => {});
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp")) return;

  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(staleWhileRevalidate(req));
  } else if (req.mode === "navigate") {
    e.respondWith(networkOrOffline(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  const fetched = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  return hit || fetched;
}

// Pages always come from the network. If there is none, show the static offline page (a single-page app has nothing else to show).
async function networkOrOffline(req) {
  try {
    return await fetch(req);
  } catch {
    const cache = await caches.open(PAGES);
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }
}
