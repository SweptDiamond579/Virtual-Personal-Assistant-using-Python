/* JARVIS OS service worker: offline shell only. API responses are never cached. */
const CACHE = "jarvis-shell-v1";
const SHELL = ["/command/", "/login/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Static build assets are content-hashed: cache first. Pages: network first, cached shell offline.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) => hit || fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        }),
      ),
    );
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/command/"))));
  }
});

/* Web Push: show notifications even when JARVIS is closed. Payloads are encrypted end to end. */
self.addEventListener("push", (event) => {
  let msg = { title: "JARVIS", body: "", link: "/command/", level: "info" };
  try {
    if (event.data) msg = { ...msg, ...event.data.json() };
  } catch {
    /* non-JSON payload */
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: msg.level === "approval" ? "jarvis-approval" : undefined,
      requireInteraction: msg.level === "approval",
      data: { link: msg.link || "/command/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.link) || "/command/";
  // Only same-origin, path-relative links may be opened.
  const target = raw.startsWith("/") && !raw.startsWith("//") ? raw.replace(/^\/([a-z]+)(\?|$)/, "/$1/$2") : "/command/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
