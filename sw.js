const CACHE = "khoiluong-v2.5";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  // Không cache CDN Tesseract / model OCR
  if (url.hostname.includes("jsdelivr") || url.hostname.includes("tesseract")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  const isNav = e.request.mode === "navigate" ||
    (e.request.headers.get("accept") || "").includes("text/html") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/sw.js");

  if (isNav || url.pathname.endsWith("sw.js")) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => caches.match(e.request).then(c => c || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
