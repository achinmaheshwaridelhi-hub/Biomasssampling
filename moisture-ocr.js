/**
 * Moisture-meter display reader (offline OCR) - app-side loader.
 *
 * The reading logic itself (digit finding + Tesseract) is the trained reader from
 * "moisture-reader-ocr final.html", split out by build_moisture_ocr.py into lib/ocr/.
 * This file only: loads that engine on first use, keeps it in the browser's Cache Storage so the
 * ~8 MB is downloaded once per device (web.config sends no-cache for everything else), and exposes
 *
 *     MoistureOCR.preload()  -> Promise<boolean>   start loading the engine in the background
 *     MoistureOCR.read(file) -> Promise<{value, conf, meter, crop} | null>   null = nothing readable
 *
 * It never fills any form field by itself - app.js shows the result and the operator must confirm it.
 */
(function () {
    'use strict';

    // ---- Switches (edit here) -------------------------------------------------------------------
    // moisture: auto-read the moisture % from a photo of the moisture meter.
    // weight  : auto-read the two fineness weights (initial / final) from a photo of the weighing scale. Read by
    //           lib/ocr/led-weight-reader.js, which compares each digit with labelled example digits (lib/ocr/led-templates.js,
    //           rebuilt with build_led_templates.html). Set to false to go back to typing the weights.
    // weightDecimals: the scale shows this many decimals (3). Use '' to let the reader guess (it then fails more often).
    window.MeterAutoRead = window.MeterAutoRead || { moisture: true, weight: true, weightDecimals: 3 };

    // Cache key for the ~8 MB engine on each device. Bump ONLY if lib/ocr/tess-core.js, tess-worker.js or eng-b64.js change
    // (the reading logic in moisture-reader-core.js is not cached here - it is a normal script with its own ?v=).
    var OCR_VERSION = '20261012_v1';
    var BASE = 'lib/ocr/';
    var CACHE_NAME = 'moisture-ocr-' + OCR_VERSION;
    // Below this the reader's own confidence is too low to trust; app.js will not let it be accepted.
    var MIN_CONFIDENCE = 60;
    // Weights get a stricter bar: on the first fully unseen test set the one wrong weight that slipped through scored 72, while the
    // correct ones scored 77-96. A weight reading below this is shown as 'not sure' (retake) instead of being offered for acceptance.
    var WEIGHT_MIN_CONFIDENCE = 75;

    var enginePromise = null;

    function assetUrl(file) {
        return new URL(BASE + file, document.baseURI).href + '?v=' + OCR_VERSION;
    }

    function dropOldCaches() {
        if (!window.caches) return;
        caches.keys().then(function (keys) {
            keys.forEach(function (k) { if (k.indexOf('moisture-ocr-') === 0 && k !== CACHE_NAME) caches.delete(k); });
        }).catch(function () { /* best effort */ });
    }

    async function getText(file) {
        var url = assetUrl(file);
        var cache = null;
        try {
            if (window.caches) {
                cache = await caches.open(CACHE_NAME);
                var hit = await cache.match(url);
                if (hit) return await hit.text();
            }
        } catch (e) { cache = null; }
        var resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error('Could not load reader file ' + file + ' (HTTP ' + resp.status + ')');
        var text = await resp.text();
        if (cache) { try { await cache.put(url, new Response(text)); } catch (e) { /* quota etc. - still works uncached */ } }
        return text;
    }

    // Same approach as the standalone reader: one worker script = Tesseract core + a tiny shim that answers
    // the worker's "download eng.traineddata" request from the bundled data + the worker itself.
    function makeWorkerUrl(core, worker, engB64) {
        var shim = 'self.__ENG_B64=' + JSON.stringify(engB64) + ';\n' +
            'const __realFetch=self.fetch;\n' +
            'self.fetch=function(u,o){ if(String(u).indexOf("eng.traineddata")>=0){\n' +
            '  const bin=atob(self.__ENG_B64), a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i);\n' +
            '  return Promise.resolve(new Response(a)); } return __realFetch(u,o); };\n';
        return URL.createObjectURL(new Blob([core, '\n', shim, worker], { type: 'application/javascript' }));
    }

    function start() {
        if (enginePromise) return enginePromise;
        enginePromise = (async function () {
            if (typeof Tesseract === 'undefined') throw new Error('Tesseract library is not loaded');
            if (!window.MoistureReaderCore) throw new Error('Moisture reader logic (lib/ocr/moisture-reader-core.js) is not loaded');
            dropOldCaches();
            var parts = await Promise.all([getText('tess-core.js'), getText('tess-worker.js'), getText('eng-b64.js')]);
            var workerUrl = makeWorkerUrl(parts[0], parts[1], parts[2].trim());
            var w = await Tesseract.createWorker('eng', 1, {
                workerPath: workerUrl, workerBlobURL: false,
                langPath: 'https://bundled.local', cacheMethod: 'none', gzip: true
            });
            await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' });
            return w;
        })();
        // Forget a failed attempt so the next call can retry (e.g. after a network blip).
        enginePromise.catch(function () { enginePromise = null; });
        return enginePromise;
    }

    // Used by the generated moisture-reader-core.js
    window.MoistureEngine = { start: start };

    window.MoistureOCR = {
        MIN_CONFIDENCE: MIN_CONFIDENCE,
        preload: function () {
            return start().then(function () { return true; }, function (err) {
                console.warn('Moisture reader could not be loaded:', err);
                return false;
            });
        },
        // opts.kind: 'moisture' (default) or 'weight'; opts.decimals: decimals shown by the scale ('' = guess)
        read: async function (file, opts) {
            var core = window.MoistureReaderCore;
            if (!core) throw new Error('Moisture reader is not available');
            opts = opts || {};
            var loaded = await core.loadImage(file);
            try {
                if (opts.kind === 'weight') {
                    var dec = opts.decimals == null ? '' : opts.decimals;
                    // The lab's scale is a red 7-segment LED display: read it with the dedicated reader (lib/ocr/led-weight-reader.js).
                    // Only if the photo has no red LED display at all do we try the general (slower) reader from meter-reader.html.
                    if (window.LedWeightReader) {
                        var led = window.LedWeightReader.read(loaded.img, dec);
                        if (led.found) return led.value ? { value: led.value, conf: led.conf >= WEIGHT_MIN_CONFIDENCE ? led.conf : Math.min(led.conf, MIN_CONFIDENCE - 1), meter: led.meter, crop: led.crop } : null;
                    }
                    // No red LED display found (e.g. a far-away photo): the general reader is a last resort and its answer is
                    // never trusted enough to accept - the cap keeps it below MIN_CONFIDENCE so the operator is asked to retake.
                    var general = await core.readWeightImg(loaded.img, dec);
                    if (general) general.conf = Math.min(general.conf, MIN_CONFIDENCE - 5);
                    return general;
                }
                return await core.readMoisture(loaded.img);
            } finally {
                URL.revokeObjectURL(loaded.url);
            }
        }
    };
})();
