/* Weighbridge indicator reader (big blue / purple digits on a pale LCD: Rice Lake 920i style, value in kg).
 *
 * How it works (no network, no external library):
 *   1. work copy of the photo (max 1100 px); "blueness" of every pixel = B - (R+G)/2  (digits and frame are blue, the face is grey/white)
 *   2. threshold (several tried) -> connected pieces -> the ROW OF BIG DIGITS = the group of equally tall pieces with the largest (count x height)
 *      (date / time / "Gross" / "kg" are all much smaller, the frame and the divider lines are too thin or too big)
 *   3. every digit piece -> 12 x 18 grid of ink coverage + its width/height ratio -> nearest labelled example (templates in lcd-templates.js)
 *   4. confidence = how much closer the best digit is than the second best digit (worst digit counts) and how well the row hangs together
 *      (digit count 3-6, equal heights, even spacing, last digit 0 for a 10-kg scale)
 * The reader NEVER decides alone: the operator sees the digits it read and must confirm (same flow as the moisture / fineness readers).
 * Training = adding labelled photos (examples()), exactly like the LED reader.                                                          */
(function () {
    'use strict';
    var GW = 12, GH = 18, MAXDIM = 1100;

    function workCanvas(src, maxDim, angleDeg, scale) {
        var sw = src.naturalWidth || src.videoWidth || src.width, sh = src.naturalHeight || src.videoHeight || src.height;
        var k = Math.min(1, (maxDim || MAXDIM) / Math.max(sw, sh)) * (scale || 1);
        var w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
        var c = document.createElement('canvas');
        var a = (angleDeg || 0) * Math.PI / 180;
        if (!a) { c.width = w; c.height = h; c.getContext('2d').drawImage(src, 0, 0, w, h); return c; }
        var cw = Math.round(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))), ch = Math.round(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)));
        c.width = cw; c.height = ch;
        var g = c.getContext('2d'); g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, cw, ch);
        g.translate(cw / 2, ch / 2); g.rotate(a); g.drawImage(src, -w / 2, -h / 2, w, h);
        return c;
    }

    // blueness map, lightly smoothed (3 x 3 box) to calm JPEG noise
    function blueMap(c) {
        var w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data, n = w * h, b = new Float32Array(n), t = new Float32Array(n);
        for (var i = 0, j = 0; i < n; i++, j += 4) { var v = d[j + 2] - (d[j] + d[j + 1]) / 2; b[i] = v < 0 ? 0 : v; }
        for (var y = 0; y < h; y++) {
            var y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
            for (var x = 0; x < w; x++) {
                var x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
                t[y * w + x] = (b[y0 * w + x0] + b[y0 * w + x] + b[y0 * w + x1] + b[y * w + x0] + b[y * w + x] + b[y * w + x1] + b[y1 * w + x0] + b[y1 * w + x] + b[y1 * w + x1]) / 9;
            }
        }
        return t;
    }

    function percentile(arr, p) {
        var hist = new Uint32Array(256), n = arr.length, i;
        for (i = 0; i < n; i++) { var v = arr[i] | 0; hist[v > 255 ? 255 : v]++; }
        var want = n * p, acc = 0;
        for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= want) return i; }
        return 255;
    }

    // opening (erode then dilate, square kernel of radius r): removes the thin divider / frame lines that would glue digits to the frame, keeps the thick digit strokes
    function opening(mask, w, h, r) {
        function pass(src, dst, horizontal, wantMax) {
            var len = horizontal ? w : h, lines = horizontal ? h : w, a, i, k;
            for (a = 0; a < lines; a++) {
                for (i = 0; i < len; i++) {
                    var acc = wantMax ? 0 : 1;
                    for (k = -r; k <= r; k++) {
                        var j = i + k, v;
                        if (j < 0 || j >= len) v = wantMax ? 0 : 1; else v = horizontal ? src[a * w + j] : src[j * w + a];
                        if (wantMax) { if (v) { acc = 1; break; } } else { if (!v) { acc = 0; break; } }
                    }
                    if (horizontal) dst[a * w + i] = acc; else dst[i * w + a] = acc;
                }
            }
        }
        var t1 = new Uint8Array(w * h), t2 = new Uint8Array(w * h), out = new Uint8Array(w * h);
        pass(mask, t1, true, false); pass(t1, t2, false, false);        // erode
        pass(t2, t1, true, true); pass(t1, out, false, true);           // dilate
        return out;
    }

    // connected pieces of a binary mask (8-neighbours): returns [{x0,y0,x1,y1,n,id}] and the label image
    function pieces(mask, w, h) {
        var lab = new Int32Array(w * h), parent = [0], next = 1, x, y, i;
        function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                i = y * w + x;
                if (!mask[i]) continue;
                var ns = [];
                if (x > 0 && lab[i - 1]) ns.push(lab[i - 1]);
                if (y > 0) {
                    if (lab[i - w]) ns.push(lab[i - w]);
                    if (x > 0 && lab[i - w - 1]) ns.push(lab[i - w - 1]);
                    if (x < w - 1 && lab[i - w + 1]) ns.push(lab[i - w + 1]);
                }
                if (!ns.length) { lab[i] = next; parent.push(next); next++; }
                else {
                    var m = ns[0]; for (var k = 1; k < ns.length; k++) if (ns[k] < m) m = ns[k];
                    lab[i] = m;
                    for (k = 0; k < ns.length; k++) { var ra = find(ns[k]), rb = find(m); if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; } }
                }
            }
        }
        var map = {}, out = [];
        for (i = 0; i < w * h; i++) {
            if (!lab[i]) continue;
            var r = find(lab[i]); lab[i] = r;
            var p = map[r];
            x = i % w; y = (i - x) / w;
            if (!p) { p = map[r] = { id: r, x0: x, y0: y, x1: x, y1: y, n: 0 }; out.push(p); }
            if (x < p.x0) p.x0 = x; if (x > p.x1) p.x1 = x; if (y < p.y0) p.y0 = y; if (y > p.y1) p.y1 = y; p.n++;
        }
        return { list: out, lab: lab };
    }

    // the row of big digits among the pieces
    function digitRow(list, w, h, minH) {
        minH = minH || 0.07 * h;
        var cand = list.filter(function (p) {
            var pw = p.x1 - p.x0 + 1, ph = p.y1 - p.y0 + 1, ar = pw / ph;
            return p.n >= 60 && ph >= minH && ar >= 0.15 && ar <= 1.35 && p.x0 > 1 && p.y0 > 1 && p.y1 < h - 2;
        });
        var best = null;
        cand.forEach(function (r) {
            var rh = r.y1 - r.y0 + 1, rc = (r.y0 + r.y1) / 2;
            var g = cand.filter(function (p) { var ph = p.y1 - p.y0 + 1, pc = (p.y0 + p.y1) / 2; return Math.abs(ph - rh) <= 0.2 * rh && Math.abs(pc - rc) <= 0.35 * rh; });
            if (g.length < 3) return;
            var score = g.length * rh;
            if (!best || score > best.score) best = { score: score, g: g };
        });
        if (!best) return null;
        var g = best.g.slice().sort(function (a, b) { return a.x0 - b.x0; });
        // two pieces that overlap in x are one glyph in two parts (rare): merge
        var out = [];
        g.forEach(function (p) {
            var last = out[out.length - 1];
            if (last && p.x0 <= last.x1 - 0.5 * Math.min(p.x1 - p.x0, last.x1 - last.x0)) {
                last.x1 = Math.max(last.x1, p.x1); last.y0 = Math.min(last.y0, p.y0); last.y1 = Math.max(last.y1, p.y1); last.n += p.n; last.ids = (last.ids || [last.id]).concat([p.id]);
            } else out.push({ id: p.id, ids: [p.id], x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, n: p.n });
        });
        return out;
    }

    // one digit piece -> GW x GH ink coverage (0-9 characters) + aspect
    function glyph(lab, ids, box, w) {
        var pw = box.x1 - box.x0 + 1, ph = box.y1 - box.y0 + 1, cells = new Float32Array(GW * GH), cnt = new Float32Array(GW * GH), x, y;
        var idset = {}; ids.forEach(function (i) { idset[i] = 1; });
        for (y = box.y0; y <= box.y1; y++) {
            var gy = Math.min(GH - 1, Math.floor((y - box.y0) * GH / ph));
            for (x = box.x0; x <= box.x1; x++) {
                var gx = Math.min(GW - 1, Math.floor((x - box.x0) * GW / pw)), k = gy * GW + gx;
                cnt[k]++; if (idset[lab[y * w + x]]) cells[k]++;
            }
        }
        var s = '';
        for (var i = 0; i < GW * GH; i++) { var f = cnt[i] ? cells[i] / cnt[i] : 0; s += String(Math.min(9, Math.round(f * 9))); }
        return { f: s, a: Math.round(100 * pw / ph) };
    }

    // find the digits of one photo (one threshold try); returns {digits:[{box,f,a}], hgt, thr} or null
    function findDigits(bl, w, h, bg, hi, fr, rad, minH) {
        var thr = bg + fr * Math.max(20, hi - bg), mask = new Uint8Array(w * h);
        for (var i = 0; i < w * h; i++) mask[i] = bl[i] > thr ? 1 : 0;
        if (rad > 0) mask = opening(mask, w, h, rad);
        var ps = pieces(mask, w, h), row = digitRow(ps.list, w, h, minH);
        if (!row) return null;
        var hs = row.map(function (b) { return b.y1 - b.y0 + 1; }), sorted = hs.slice().sort(function (a, b) { return a - b; }), mh = sorted[sorted.length >> 1];
        var hdev = Math.max.apply(null, hs.map(function (v) { return Math.abs(v - mh) / mh; }));
        var n = row.length, ok = n >= 3 && n <= 6 && hdev <= 0.15;
        return { digits: row.map(function (b) { var g = glyph(ps.lab, b.ids, b, w); return { box: b, f: g.f, a: g.a }; }), hgt: mh, hdev: hdev, thr: Math.round(thr), frac: fr, rad: rad, score: ok ? n * 10 - 40 * hdev : -1 };
    }

    // Phase 1 finds the row roughly (first plausible try on the whole photo); phase 2 re-cuts a window around it with MANY thresholds x thin-line filters
    // (a faint or glare-washed digit appears at a low threshold, glued lines vanish with a larger filter) and keeps the row with the most equal-height digits.
    var SEEDS = [[0.2, 0], [0.2, 2], [0.12, 0], [0.12, 2], [0.3, 2], [0.08, 0], [0.08, 2], [0.4, 0], [0.12, 4], [0.3, 0]];
    var FRACS = [0.07, 0.1, 0.14, 0.19, 0.26, 0.34, 0.45], RADS = [0, 1, 2, 4];
    function analyse(src, opts) {
        opts = opts || {};
        var c = workCanvas(src, opts.maxDim, opts.angle, opts.scale), w = c.width, h = c.height;
        var bl = blueMap(c), bg = percentile(bl, 0.5), hi = percentile(bl, 0.99), seed = null, i, j, k;
        for (i = 0; i < SEEDS.length && !seed; i++) {
            var s = findDigits(bl, w, h, bg, hi, SEEDS[i][0], SEEDS[i][1], 0.06 * h);
            if (s && s.score >= 0) seed = s;
        }
        if (!seed) return null;
        var bx0 = 1e9, bx1 = 0, by0 = 1e9, by1 = 0;
        seed.digits.forEach(function (d) { bx0 = Math.min(bx0, d.box.x0); bx1 = Math.max(bx1, d.box.x1); by0 = Math.min(by0, d.box.y0); by1 = Math.max(by1, d.box.y1); });
        var bh = seed.hgt, dw = bh * 0.62;
        var rx0 = Math.max(0, Math.floor(bx0 - 1.8 * dw)), rx1 = Math.min(w, Math.ceil(bx1 + 1.2 * dw)), ry0 = Math.max(0, Math.floor(by0 - 0.35 * bh)), ry1 = Math.min(h, Math.ceil(by1 + 0.35 * bh));
        var rw = rx1 - rx0, rh = ry1 - ry0, rbl = new Float32Array(rw * rh), y, x;
        for (y = 0; y < rh; y++) for (x = 0; x < rw; x++) rbl[y * rw + x] = bl[(ry0 + y) * w + rx0 + x];
        var best = null;
        for (j = 0; j < FRACS.length; j++) {
            for (k = 0; k < RADS.length; k++) {
                var r = findDigits(rbl, rw, rh, bg, hi, FRACS[j], RADS[k], 0.6 * bh);
                if (r && r.score >= 0 && (!best || r.score > best.score)) best = r;
            }
        }
        if (!best || best.score < seed.score) best = seed, rx0 = ry0 = 0;       // (the seed itself was already in full-photo coordinates)
        best.digits.forEach(function (d) { d.box.x0 += rx0; d.box.x1 += rx0; d.box.y0 += ry0; d.box.y1 += ry0; });
        best.w = w; best.h = h;
        return best;
    }

    function dist(a, b) { var s = 0; for (var i = 0; i < a.length; i++) { var d = a.charCodeAt(i) - b.charCodeAt(i); s += d * d; } return s; }

    // templates: array of [digitChar, aspect, featureString]
    function classify(d, T) {
        var per = {}, i;
        for (i = 0; i < T.length; i++) {
            var t = T[i], dd = dist(d.f, t[2]) + 0.6 * Math.pow(d.a - t[1], 2) * 0.1;
            if (per[t[0]] === undefined || dd < per[t[0]]) per[t[0]] = dd;
        }
        var arr = Object.keys(per).map(function (k) { return [k, per[k]]; }).sort(function (a, b) { return a[1] - b[1]; });
        return arr;
    }

    // read(src [, {templates}]) -> {ok, text, value, conf, digits:[{ch,conf,alt}], why}
    function read(src, opts) {
        opts = opts || {};
        var T = opts.templates || window.LCD_TEMPLATES || [];
        if (!T.length) return { ok: false, why: 'no templates loaded', conf: 0 };
        var r = analyse(src, opts);
        if (!r) return { ok: false, why: 'no row of big digits found', conf: 0 };
        var n = r.digits.length;
        if (n < 3 || n > 6) return { ok: false, why: 'found ' + n + ' digits', conf: 0, digits: [] };
        var out = [], text = '', minc = 100;
        r.digits.forEach(function (d) {
            var arr = classify(d, T), d1 = arr[0][1], d2 = arr.length > 1 ? arr[1][1] : d1 * 3 + 1;
            var margin = (d2 - d1) / (d2 + 1);                                  // 0..1: how much better the best digit is than the runner-up
            var rms = Math.sqrt(d1 / (GW * GH));                                // how far the best template is from this digit
            var c = 100 * Math.min(1, margin / 0.35) * Math.max(0, 1 - Math.max(0, rms - 1.5) / 3);
            out.push({ ch: arr[0][0], conf: Math.round(c), alt: arr.length > 1 ? arr[1][0] : '', rms: +rms.toFixed(2) });
            text += arr[0][0]; if (c < minc) minc = c;
        });
        // the row has to hang together
        var hs = r.digits.map(function (d) { return d.box.y1 - d.box.y0 + 1; }), mh = hs.reduce(function (a, b) { return a + b; }, 0) / n;
        var hdev = Math.max.apply(null, hs.map(function (v) { return Math.abs(v - mh) / mh; }));
        var gaps = [], i;
        for (i = 1; i < n; i++) gaps.push(r.digits[i].box.x0 - r.digits[i - 1].box.x1);
        var mg = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length, gdev = Math.max.apply(null, gaps.map(function (v) { return Math.abs(v - mg); })) / mh;
        var conf = minc, notes = [];
        if (hdev > 0.12) { conf = Math.min(conf, 45); notes.push('digit heights differ'); }
        if (gdev > 0.35) { conf = Math.min(conf, 55); notes.push('uneven spacing'); }
        // plausibility of a truck weight on a 10-kg scale (switch off with {tenKg:false} for a scale that shows single kilograms)
        if (opts.tenKg !== false && text.slice(-1) !== '0') { conf = Math.min(conf, 45); notes.push('last digit is not 0'); }
        if (n > 1 && text.charAt(0) === '0') return { ok: false, why: 'leading zero', conf: 0, text: text, digits: out };
        if (n === 3) { conf = Math.min(conf, 50); notes.push('only 3 digits'); }
        return { ok: true, text: text, value: Number(text), conf: Math.round(conf), digits: out, notes: notes, rows: r };
    }

    // training examples of a labelled photo: several tilts / sizes -> [[digit, aspect, features], ...]
    function examples(src, truthText, opts) {
        opts = opts || {};
        var angles = opts.angles || [-6, -3, 0, 3, 6], scales = opts.scales || [1, 0.7], out = [], fails = 0;
        angles.forEach(function (a) {
            scales.forEach(function (s) {
                var r = analyse(src, { angle: a, scale: s });
                if (!r || r.digits.length !== truthText.length) { fails++; return; }
                r.digits.forEach(function (d, i) { out.push([truthText.charAt(i), d.a, d.f]); });
            });
        });
        return { examples: out, fails: fails, tries: angles.length * scales.length };
    }

    window.LcdWeightReader = { read: read, examples: examples, analyse: analyse, GW: GW, GH: GH, _dbg: { workCanvas: workCanvas, blueMap: blueMap, pieces: pieces, percentile: percentile, opening: opening } };
})();
