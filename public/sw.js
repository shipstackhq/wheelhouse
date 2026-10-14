// Wheelhouse service worker. Hand-written on purpose: the policy is small and security-sensitive.
// Never caches /mcp, /api/*, non-GET requests (server actions) or cross-origin requests.
const VERSION = "v1";
const STATIC = `wh-static-${VERSION}`;
const PAGES = `wh-pages-${VERSION}`;
const OFFLINE_URL = "/offline";

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

// Static assets are shared by all users; pages hold user data and are wiped on sign-out.
async function clearUserData() {
  await caches.delete(PAGES);
  await caches.open(PAGES).then((c) => c.add(OFFLINE_URL)).catch(() => {});
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp")) return;
  if (req.headers.has("RSC") || req.headers.has("Next-Action") || url.searchParams.has("_rsc")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(staleWhileRevalidate(req));
  } else if (req.mode === "navigate") {
    e.respondWith(networkFirst(req));
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

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    // Only cache real pages: not redirects (e.g. to /login) or errors.
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match(OFFLINE_URL)) || Response.error();
  }
}
