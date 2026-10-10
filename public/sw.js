const CACHE_NAME = "sepehr-pwa-shell-v1";
const APP_SHELL = [
  "/",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/app-icon-maskable-512.png",
];
const APP_PATHS = new Set(APP_SHELL.filter((path) => path !== "/"));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = APP_SHELL.map((path) => new Request(new URL(path, self.location.origin)));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("sepehr-pwa-shell-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache proxied destinations, authentication, session state, or API calls.
  if (url.pathname === "/proxy" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  const isAppNavigation = request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html");
  const assetPath = url.pathname === "/index.html" ? "/" : url.pathname;
  if (!isAppNavigation && !APP_PATHS.has(assetPath)) return;

  if (isAppNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(new Request(new URL("/", self.location.origin)), response.clone());
        }
        return response;
      } catch {
        return (await caches.match(new Request(new URL("/", self.location.origin)))) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return cached || Response.error();
    }
  })());
});
