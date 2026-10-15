/*
 * Service worker: lets the app be installed on a phone / PC and open again when the connection drops.
 *
 * It ALWAYS asks the network first (revalidating with the server), so a new version published on GitHub reaches every
 * worker the next time they open the app - the saved copy is only a fallback for when there is no connection.
 * It never touches the database: only files from this site are handled, and only GET requests.
 */
const CACHE = 'biomass-shell-v1';

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE)
            .then(function (c) { return c.addAll(['./', 'manifest.webmanifest', 'icons/icon-192.png']); })
            .catch(function () { /* first load while offline: nothing to save yet */ })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.filter(function (k) { return k.indexOf('biomass-shell-') === 0 && k !== CACHE; })
                    .map(function (k) { return caches.delete(k); }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;                                   // Supabase, CDNs: not ours
    // The ~8 MB offline reader engine keeps its own copy (see moisture-ocr.js): do not store it twice.
    if (/\/lib\/ocr\/(tess-core|tess-worker|eng-b64)\.js$/.test(url.pathname)) return;

    event.respondWith((async function () {
        try {
            const res = await fetch(req, { cache: 'no-cache' });
            if (res && res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(function (c) {
                    // keep only the newest ?v= version of each file
                    c.keys().then(function (keys) {
                        keys.forEach(function (k) {
                            const ku = new URL(k.url);
                            if (ku.pathname === url.pathname && k.url !== req.url) c.delete(k);
                        });
                    });
                    return c.put(req, copy);
                }).catch(function () { /* storage full: still fine, we just have no fallback copy */ });
            }
            return res;
        } catch (err) {
            const hit = await caches.match(req) || (req.mode === 'navigate' ? await caches.match('./') : undefined);
            if (hit) return hit;
            throw err;
        }
    })());
});
