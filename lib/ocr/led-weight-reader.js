/**
 * Red 7-segment LED weighing-scale display reader (the scales used for the fineness weights).
 *
 * Hand-written for this app (NOT generated from meter-reader.html): the general weight reader in the trained html
 * returned the wrong number on the lab's scale photos (the LED glow merges neighbouring segments and the digits are italic).
 *
 *   1. find the display's dark-red window, crop it, un-tilt it (camera held at an angle) and un-slant the italic digits
 *   2. split the display into digits (the decimal point is taken out first)
 *   3. turn every digit into a small brightness grid of its bright LED core (green channel) and classify it by comparing
 *      with labelled example digits (window.LED_TEMPLATES, built from real photos by build_led_templates - the more labelled
 *      photos go into it, the better it reads)
 *
 *     LedWeightReader.read(img, decimals) -> { found, value, conf, meter, crop, fail }
 *         found=false : no red LED display in the photo (caller may fall back to the general reader)
 *         conf        : how clearly each digit matched its best class rather than the runner-up; the app refuses to let
 *                       anything below MoistureOCR.MIN_CONFIDENCE be accepted.
 *     decimals: digits shown after the decimal point on this scale (3). '' / null = use the decimal point that was found.
 */
(function () {
    'use strict';

    const GRID_COLS = 10, GRID_ROWS = 16;      // size of the brightness grid one digit is reduced to
    const CORE_FRACTION = 0.30;                // an LED core is at least this fraction of the brightest green in the display
    const TILT_STEPS = [0, -1, 1, -2, 2];      // read at the estimated camera tilt plus/minus these degrees and vote
    // digit splitting settings (mask growth and minimum gap between digits, as fractions of the digit height). Photos with fat bright
    // cores split best with the tight setting; photos with thin cores (digits break into pieces) need the looser one.
    const PARAM_SETS = [{ dil: 0.012, gap: 0.03 }, { dil: 0.02, gap: 0.06 }];
    const MARGIN_FULL = 0.5;                   // digit-match margin at which a reading counts as fully clear (calibrated on labelled photos)

    function components(m, W, H) {
        const lab = new Int32Array(W * H).fill(-1), out = [], st = [];
        for (let s = 0; s < W * H; s++) {
            if (!m[s] || lab[s] >= 0) continue;
            const id = out.length; let x0 = W, y0 = H, x1 = 0, y1 = 0, a = 0;
            st.push(s); lab[s] = id;
            while (st.length) {
                const p = st.pop(), x = p % W, y = (p - x) / W; a++;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy; if (yy < 0 || yy >= H) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx; if (xx < 0 || xx >= W) continue;
                        const q = yy * W + xx; if (m[q] && lab[q] < 0) { lab[q] = id; st.push(q); }
                    }
                }
            }
            out.push({ id: id, x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: a });
        }
        return { boxes: out, lab: lab };
    }

    // grow a mask by r pixels (separable) so the thin cores of one digit join into a single blob
    function dilate(m, w, h, r) {
        const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (!m[y * w + x]) continue;
            for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) t[y * w + xx] = 1; }
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (!t[y * w + x]) continue;
            for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) o[yy * w + x] = 1; }
        }
        return o;
    }

    function percentile(arr, p) {
        const s = Array.from(arr).sort(function (a, b) { return a - b; });
        return s[Math.floor(p * (s.length - 1))];
    }

    // The display is a dark red window; its lit digits are holes of bright colour inside it.
    function findWindow(rgba, W, H) {
        const m = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
            m[i] = (r >= 20 && r <= 170 && r > 1.6 * g + 8 && r > 1.4 * b + 8 && g < 80) ? 1 : 0;
        }
        const cc = components(m, W, H);
        let best = null;
        for (const b of cc.boxes) if (!best || b.area > best.area) best = b;
        if (!best || best.area < 0.0025 * W * H) return null;
        const ar = best.w / best.h;
        if (ar < 1.8 || ar > 8) return null;
        return best;
    }

    // Lit segments = saturated red AND a bright LED core in green. Red alone is too fat: in brighter photos the glow of one
    // segment bridges the gap to the next digit and the whole row becomes one blob.
    function litMask(rgba, N) {
        const R = new Uint8ClampedArray(N), G = new Uint8ClampedArray(N);
        for (let i = 0; i < N; i++) { R[i] = rgba[4 * i]; G[i] = rgba[4 * i + 1]; }
        const p995 = percentile(R, 0.995), g995 = percentile(G, 0.995);
        const t = Math.max(150, Math.min(240, Math.round(0.93 * p995)));
        const gT = Math.max(30, Math.round(CORE_FRACTION * g995));
        const m = new Uint8Array(N);
        for (let i = 0; i < N; i++) m[i] = (R[i] > t && G[i] > gT) ? 1 : 0;
        return { mask: m, p995: p995 };
    }

    // Camera tilt: the horizontal bars of the digits line up best (sharpest row histogram) at the right angle.
    function estimateTilt(mask, w, h) {
        const pts = [];
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (mask[y * w + x]) pts.push(x, y);
        if (pts.length < 40) return 0;
        const cx = w / 2, cy = h / 2;
        let best = 0, bestScore = -1;
        for (let deg = -25; deg <= 25.001; deg += 0.5) {
            const a = deg * Math.PI / 180, sn = Math.sin(a), cs = Math.cos(a);
            const hist = new Float64Array(h * 2 + 4);
            for (let i = 0; i < pts.length; i += 2) {
                const y = (pts[i + 1] - cy) * cs - (pts[i] - cx) * sn + cy;      // row after rotating by -deg
                const k = Math.round(y) + h; if (k >= 0 && k < hist.length) hist[k]++;
            }
            let sc = 0; for (let i = 0; i < hist.length; i++) sc += hist[i] * hist[i];
            if (sc > bestScore) { bestScore = sc; best = deg; }
        }
        return best;
    }

    function rotateCanvas(src, deg) {
        const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
        const c = out.getContext('2d');
        c.fillStyle = '#300'; c.fillRect(0, 0, out.width, out.height);
        c.translate(out.width / 2, out.height / 2); c.rotate(-deg * Math.PI / 180); c.translate(-out.width / 2, -out.height / 2);
        c.drawImage(src, 0, 0);
        return out;
    }

    // One digit -> a GRID_COLS x GRID_ROWS grid of how much bright LED core each small cell holds, scaled by this digit's
    // own brightest cores so the same digit looks the same in a bright and in a dim photo. Values 0..9 as a string.
    function digitGrid(Gs, SW, ch, xLeft, xRight, ymin, ymax) {
        const rw = xRight - xLeft + 1, rh = ymax - ymin + 1;
        const vals = [];
        for (let y = ymin; y <= ymax; y++) for (let x = Math.max(0, xLeft); x <= xRight && x < SW; x++) vals.push(Gs[y * SW + x]);
        const scale = Math.max(30, percentile(vals, 0.99));
        const out = new Array(GRID_COLS * GRID_ROWS);
        for (let r = 0; r < GRID_ROWS; r++) {
            const ya = ymin + Math.floor(r * rh / GRID_ROWS), yb = ymin + Math.max(Math.floor((r + 1) * rh / GRID_ROWS), Math.floor(r * rh / GRID_ROWS) + 1);
            for (let c = 0; c < GRID_COLS; c++) {
                const xa = xLeft + Math.floor(c * rw / GRID_COLS), xb = xLeft + Math.max(Math.floor((c + 1) * rw / GRID_COLS), Math.floor(c * rw / GRID_COLS) + 1);
                let sum = 0, n = 0;
                for (let y = ya; y < yb && y < ch; y++) for (let x = xa; x < xb; x++) { if (x < 0 || x >= SW) continue; sum += Gs[y * SW + x]; n++; }
                out[r * GRID_COLS + c] = Math.min(9, Math.round(9 * (n ? sum / n : 0) / scale));
            }
        }
        return out.join('');
    }

    // Split a straightened crop into digits. Returns { fail } or { grids: [[grid per digit] per shift], dpAfter, n }.
    // `shifts` are extra horizontal offsets (px) used only to make training examples more varied.
    function segmentWith(crop, shifts, P, expectedDigits) {
        const cw = crop.width, ch = crop.height, N = cw * ch;
        const rgba = crop.getContext('2d').getImageData(0, 0, cw, ch).data;
        const lm = litMask(rgba, N);
        if (lm.p995 < 150) return { fail: 'display not lit' };

        // drop tiny specks and anything touching the crop edge (bezel reflections)
        const cc = components(lm.mask, cw, ch), kept = [];
        for (const b of cc.boxes) {
            if (b.area < 0.0006 * N) continue;
            if (b.x0 <= 0 || b.y0 <= 0 || b.x1 >= cw - 1 || b.y1 >= ch - 1) continue;
            kept.push(b);
        }
        if (!kept.length) return { fail: 'no lit segments' };

        // decimal-point blobs are small and sit at the bottom; take them out so they cannot widen a digit
        const maxH = Math.max.apply(null, kept.map(function (b) { return b.h; }));
        // a dot is small next to a digit SEGMENT (a lone lit dot is roughly square and about a third of a segment's length)
        const small = function (b) { return b.w < 0.4 * maxH && b.h < 0.4 * maxH && b.w < 1.6 * b.h && b.h < 1.6 * b.w; };
        const bodyComps = kept.filter(function (b) { return !small(b); });
        if (!bodyComps.length) return { fail: 'no digits' };
        const ymin = Math.min.apply(null, bodyComps.map(function (b) { return b.y0; }));
        const ymax = Math.max.apply(null, bodyComps.map(function (b) { return b.y1; }));
        const Hd = ymax - ymin + 1;
        if (Hd < 0.2 * ch || Hd < 36) return { fail: 'digits too small' };
        const ymid = (ymin + ymax) / 2;
        const dpComps = kept.filter(function (b) { return small(b) && b.y0 > ymin + 0.6 * Hd; });
        const bodyIds = new Set(bodyComps.map(function (b) { return b.id; }));
        const keepRaw = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (cc.lab[i] >= 0 && bodyIds.has(cc.lab[i])) keepRaw[i] = 1;
        const keep = dilate(keepRaw, cw, ch, Math.max(1, Math.round(P.dil * Hd)));

        // straighten the italic lean: pick the shear that lines the vertical bars up best
        const off = Math.ceil(0.4 * ch) + 2, SW = cw + 2 * off;
        let bestS = 0, bestScore = -1;
        for (let s = 0; s <= 0.4001; s += 0.01) {
            const cnt = new Float64Array(SW);
            for (let y = ymin; y <= ymax; y++) for (let x = 0; x < cw; x++) if (keep[y * cw + x]) cnt[Math.round(x + s * (y - ymid)) + off]++;
            let sc = 0; for (let i = 0; i < SW; i++) sc += cnt[i] * cnt[i];
            if (sc > bestScore) { bestScore = sc; bestS = s; }
        }
        const sm = new Uint8Array(SW * ch), Gs = new Uint8ClampedArray(SW * ch);
        for (let y = 0; y < ch; y++) {
            const sh = Math.round(bestS * (y - ymid)) + off;
            for (let x = 0; x < cw; x++) {
                const nx = x + sh; if (nx < 0 || nx >= SW) continue;
                Gs[y * SW + nx] = rgba[4 * (y * cw + x) + 1];
                if (keep[y * cw + x]) sm[y * SW + nx] = 1;
            }
        }

        // digits = runs of lit columns over the full digit height (top/bottom bars tie a digit's two sides together)
        const col = new Int32Array(SW);
        for (let y = ymin; y <= ymax; y++) for (let x = 0; x < SW; x++) col[x] += sm[y * SW + x];
        const runs = []; let cur = null;
        for (let x = 0; x < SW; x++) {
            if (col[x] > 0) { if (!cur) cur = { x0: x, x1: x }; else cur.x1 = x; } else if (cur) { runs.push(cur); cur = null; }
        }
        if (cur) runs.push(cur);
        const gapMin = P.gap * Hd, D = [];
        for (const r of runs) {
            const last = D[D.length - 1];
            if (last && r.x0 - last.x1 - 1 < gapMin) last.x1 = r.x1; else D.push({ x0: r.x0, x1: r.x1 });
        }
        // measure each digit from its middle rows only, so nothing at the baseline can stretch it
        const midA = Math.round(ymin + 0.2 * Hd), midB = Math.round(ymax - 0.2 * Hd);
        for (const d of D) {
            let a = d.x1, b = d.x0;
            for (let y = midA; y <= midB; y++) for (let x = d.x0; x <= d.x1; x++) if (sm[y * SW + x]) { if (x < a) a = x; if (x > b) b = x; }
            if (b >= a) { d.mx0 = a; d.mx1 = b; } else { d.mx0 = d.x0; d.mx1 = d.x1; }
        }
        const D2 = D.filter(function (d) { return d.x1 - d.x0 + 1 >= 0.05 * Hd; });
        if (D2.length < 1 || D2.length > 7) return { fail: 'digit count ' + D2.length };

        // every digit cell has the same width and is anchored on the digit's right edge (the right-hand bars are present on
        // almost every digit), so a lone "1" bar is cut out exactly like the others
        const wide = D2.map(function (d) { return d.mx1 - d.mx0 + 1; }).filter(function (w) { return w >= 0.3 * Hd; }).sort(function (a, b) { return a - b; });
        const cellW = wide.length ? wide[wide.length >> 1] : Math.round(0.55 * Hd);

        // Which dot is the decimal point? Some scales light a dot in an empty cell to the left of the number, so when the
        // number of decimals is known prefer the dot that leaves exactly that many digits after it, and never one that sits
        // to the left of every digit.
        let dpAfter = null;
        const wantDec = expectedDigits ? expectedDigits - 1 : null;
        const cands = dpComps.map(function (b) {
            const dx = (b.x0 + b.x1) / 2 + bestS * ((b.y0 + b.y1) / 2 - ymid) + off;
            return D2.filter(function (d) { return (d.mx0 + d.mx1) / 2 > dx; }).length;
        }).filter(function (n) { return n < D2.length || wantDec === D2.length; });
        if (cands.length) dpAfter = (wantDec !== null && cands.indexOf(wantDec) >= 0) ? wantDec : cands[0];
        const variants = shifts && shifts.length ? shifts : [0];
        const grids = variants.map(function (sx) {
            return D2.map(function (d) { return digitGrid(Gs, SW, ch, d.mx1 - cellW + 1 + sx, d.mx1 + 1 + sx, ymin, ymax); });
        });
        return { grids: grids, dpAfter: dpAfter, n: D2.length };
    }


    function segment(crop, shifts, expected) {
        let first = null, lastFail = null;
        for (const ps of PARAM_SETS) {
            const r = segmentWith(crop, shifts, ps, expected);
            if (r.fail) { lastFail = r; continue; }
            if (!expected || r.n === expected) return r;
            if (!first) first = r;
        }
        return first || lastFail || { fail: 'no digits' };
    }

    // ---- classification against labelled example digits ----
    function gridDistance(a, b) {
        let s = 0;
        for (let i = 0; i < a.length; i++) { const d = (a.charCodeAt(i) - b.charCodeAt(i)); s += d * d; }
        return s;
    }

    // templates: [{ch:'4', g:'0123...'}]. Returns { ch, margin, alt } where margin = how much closer the best class is than the best other class.
    function classify(grid, templates) {
        const best = {};
        for (const t of templates) {
            const d = gridDistance(grid, t.g);
            if (best[t.ch] === undefined || d < best[t.ch]) best[t.ch] = d;
        }
        const ranked = Object.keys(best).map(function (k) { return { ch: k, d: best[k] }; }).sort(function (a, b) { return a.d - b.d; });
        if (!ranked.length) return null;
        const d1 = ranked[0].d, d2 = ranked.length > 1 ? ranked[1].d : d1 * 2 + 1;
        return { ch: ranked[0].ch, margin: (d2 - d1) / Math.max(1, d2), alt: ranked.length > 1 ? ranked[1].ch : null };
    }


    // ---- second opinion: read the digit's seven segments straight from its grid, independent of any examples ----
    const SEG_SHAPES = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' };
    const SEG_ALT_7 = 'abcf';   // a 7 with the extra upper-left stroke (seen on some scales)
    const SEG_REG = { a: [.25, .75, 0, .17], b: [.68, 1, .12, .47], c: [.68, 1, .53, .88], d: [.25, .75, .83, 1],
                      e: [0, .32, .53, .88], f: [0, .32, .12, .47], g: [.25, .75, .41, .59] };
    const SEG_LIT_MEAN = 5;     // average grid value (0..9) of a clearly lit segment area

    function structuralDigit(grid) {
        const v = {};
        for (const k of 'abcdefg') {
            const g = SEG_REG[k];
            const c0 = Math.floor(g[0] * GRID_COLS), c1 = Math.max(c0, Math.ceil(g[1] * GRID_COLS) - 1);
            const r0 = Math.floor(g[2] * GRID_ROWS), r1 = Math.max(r0, Math.ceil(g[3] * GRID_ROWS) - 1);
            let sum = 0, n = 0;
            for (let r = r0; r <= r1 && r < GRID_ROWS; r++) for (let c = c0; c <= c1 && c < GRID_COLS; c++) { sum += grid.charCodeAt(r * GRID_COLS + c) - 48; n++; }
            v[k] = Math.max(0, Math.min(1, (n ? sum / n : 0) / SEG_LIT_MEAN));
        }
        let best = null, second = -1;
        const shapes = Object.keys(SEG_SHAPES).map(function (ch) { return { ch: ch, seg: SEG_SHAPES[ch] }; }).concat([{ ch: '7', seg: SEG_ALT_7 }]);
        for (const sh of shapes) {
            let sc = 0;
            for (const k of 'abcdefg') sc += sh.seg.indexOf(k) >= 0 ? v[k] : 1 - v[k];
            if (!best || sc > best.sc) { if (best && best.ch !== sh.ch) second = Math.max(second, best.sc); best = { ch: sh.ch, sc: sc }; }
            else if (sh.ch !== best.ch && sc > second) second = sc;
        }
        return { ch: best.ch, margin: best.sc - second };
    }

    function previewImage(crop) {
        const sc = 68 / crop.height;
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(crop.width * sc)); out.height = 68;
        out.getContext('2d').drawImage(crop, 0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.8);
    }

    function formatValue(digits, dpAfter, decimals) {
        let dec = decimals === '' || decimals == null ? null : Number(decimals);
        let penalty = 0;
        if (dpAfter !== null && dec !== null && dpAfter !== dec) penalty = 100;   // a decimal point was seen that disagrees with the scale setting
        if (dec === null) dec = dpAfter;
        if (dec === null) return null;
        if (dec >= digits.length) return { value: '0.' + digits.padStart(dec, '0'), penalty: penalty };
        return { value: dec > 0 ? digits.slice(0, digits.length - dec) + '.' + digits.slice(digits.length - dec) : digits, penalty: penalty };
    }

    // Prepare the cropped display for an image (shared by reading and by building the templates)
    function prepare(img) {
        const s = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
        const full = document.createElement('canvas');
        full.width = Math.round(img.naturalWidth * s); full.height = Math.round(img.naturalHeight * s);
        full.getContext('2d').drawImage(img, 0, 0, full.width, full.height);
        const rgba = full.getContext('2d').getImageData(0, 0, full.width, full.height).data;
        const win = findWindow(rgba, full.width, full.height);
        if (!win) return null;
        // crop with a generous margin, scaled so the display is ~700px wide (more pixels per segment)
        const pad = Math.round(0.12 * win.w);
        const x0 = Math.max(0, win.x0 - pad), y0 = Math.max(0, win.y0 - pad);
        const x1 = Math.min(full.width - 1, win.x1 + pad), y1 = Math.min(full.height - 1, win.y1 + pad);
        const cwid = x1 - x0 + 1, chei = y1 - y0 + 1, up = Math.max(1, Math.min(2.5, 700 / win.w));
        const crop = document.createElement('canvas');
        crop.width = Math.round(cwid * up); crop.height = Math.round(chei * up);
        // the window was found on the reduced copy, but the crop itself is taken from the ORIGINAL photo (s <= 1 maps back)
        crop.getContext('2d').drawImage(img, x0 / s, y0 / s, cwid / s, chei / s, 0, 0, crop.width, crop.height);
        const lm = litMask(crop.getContext('2d').getImageData(0, 0, crop.width, crop.height).data, crop.width * crop.height);
        const tilt = estimateTilt(lm.mask, crop.width, crop.height);
        return { crop: crop, tilt: tilt };
    }

    window.LedWeightReader = {
        // Used by the template builder: digit grids of an image at several tilt angles / shifts.
        examples: function (img, tiltSteps, shifts, expected) {
            const p = prepare(img);
            if (!p) return { found: false };
            const out = [], fails = [];
            (tiltSteps || [0]).forEach(function (delta) {
                const ang = p.tilt + delta;
                const straight = Math.abs(ang) > 0.4 ? rotateCanvas(p.crop, ang) : p.crop;
                const sg = segment(straight, shifts, expected);
                if (!sg.fail) out.push({ delta: delta, n: sg.n, grids: sg.grids, dpAfter: sg.dpAfter }); else fails.push(sg.fail);
            });
            return { found: true, tilt: p.tilt, sets: out, fails: fails };
        },
        classify: classify,
        structuralDigit: structuralDigit,
        read: function (img, decimals, templatesOverride) {
            const templates = templatesOverride || window.LED_TEMPLATES;
            const p = prepare(img);
            if (!p) return { found: false };
            if (!templates || !templates.length) return { found: true, fail: 'no digit examples loaded' };

            // The tilt estimate is not perfect, so read at a few nearby angles and trust only what they agree on.
            const expected = decimals === '' || decimals == null ? null : Number(decimals) + 1;
            const votes = {}; let valid = 0, lastFail = null, bestCrop = null;
            TILT_STEPS.forEach(function (delta) {
                const ang = p.tilt + delta;
                const straight = Math.abs(ang) > 0.4 ? rotateCanvas(p.crop, ang) : p.crop;
                const sg = segment(straight, [0], expected);
                if (sg.fail) { lastFail = sg.fail; return; }
                if (expected && sg.n !== expected) { lastFail = 'found ' + sg.n + ' digits, expected ' + expected; return; }   // a missing/extra digit would silently change the number
                let digits = '', minMargin = 9, disagree = 0;
                for (const g of sg.grids[0]) {
                    const c = classify(g, templates);
                    if (!c) return;
                    digits += c.ch; minMargin = Math.min(minMargin, c.margin);
                    if (structuralDigit(g).ch !== c.ch) disagree++;
                }
                const f = formatValue(digits, sg.dpAfter, decimals);
                if (!f) { lastFail = 'no decimal point found'; return; }
                valid++;
                const v = votes[f.value] || (votes[f.value] = { value: f.value, n: 0, margin: 0, penalty: f.penalty, digits: digits, disagree: 99 });
                v.n++;
                if (disagree < v.disagree) v.disagree = disagree;
                if (minMargin > v.margin) v.margin = minMargin;
                if (delta === 0 || !bestCrop) bestCrop = straight;
            });
            if (!valid) return { found: true, fail: lastFail || 'unreadable', tilt: p.tilt };
            const ranked = Object.keys(votes).map(function (k) { return votes[k]; }).sort(function (a, b) { return (b.n - a.n) || (b.margin - a.margin); });
            const top = ranked[0], agreement = top.n / valid;
            let conf = 40 + 56 * Math.min(1, top.margin / MARGIN_FULL) - top.penalty;
            conf *= (0.6 + 0.4 * agreement) * (valid >= 3 ? 1 : 0.8);
            if (top.disagree > 0) conf = Math.min(conf, 40);   // the two independent readings of at least one digit disagree: do not trust it
            conf = Math.max(30, Math.min(96, conf));
            return { found: true, value: top.value, conf: conf, meter: 'LED 7-segment scale', crop: previewImage(bestCrop || p.crop), tilt: p.tilt, digits: top.digits, margin: top.margin, agreement: agreement, disagree: top.disagree };
        }
    };
})();
