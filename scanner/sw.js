const CACHE = 'pengimbas-v5';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'ocr.js', 'drive.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ---- Terima fail yang dikongsi dari app lain (WhatsApp, Galeri, dll.) ---- */
function shareDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pengimbas-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function receiveShare(request) {
  try {
    const fd = await request.formData();
    const files = fd.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    if (files.length) {
      const db = await shareDb();
      await new Promise((res, rej) => {
        const t = db.transaction('files', 'readwrite');
        const st = t.objectStore('files');
        // simpan sebagai Blob + nama (File tidak selalu boleh disimpan di semua pelayar)
        files.forEach((f) => st.add({ name: f.name || 'kongsi.jpg', type: f.type, blob: new Blob([f], { type: f.type }) }));
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
    }
    return Response.redirect('./?share=' + files.length, 303);
  } catch (err) {
    return Response.redirect('./?share=error', 303);
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // rangkaian dahulu (supaya kemas kini cepat sampai), cache jika luar talian
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
