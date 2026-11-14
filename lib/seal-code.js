/* SealCode: the private pattern printed on the seal tags.
 *
 * It is NOT a standard barcode. It has no QR / Code 128 / Data Matrix finder pattern, so phone scanner apps and Google Lens find
 * nothing in it at all. Only this reader can decode it. A tag carries an 80-bit random token (the database holds the list of tokens it
 * generated and whether each has been used); the pattern adds a 16-bit check, three copies of the bits and a fixed whitening mask.
 *
 *   layout (23 x 23 modules):  2 black frame | 1 white gap | 17 x 17 data cells | 1 white gap | 2 black frame
 *   three corners of the data area carry orientation marks (black block, white block, checker); the fourth carries data.
 *
 *   SealCode.render(tokenHex, modulePx)    -> canvas   (quiet zone of 2 modules included)
 *   SealCode.decodeImageData(imageData)    -> tokenHex | null
 *   SealCode.decodeFile(file)              -> Promise<tokenHex | null>   (tries several sizes / contrast settings)
 */
(function () {
  'use strict';
  var SW = 39, SH = 13, FR = 1, GAP = 1, DW = 35, DH = 9, OFF = FR + GAP;     // 3 x 1 cm tag: 39 x 13 modules, data area starts at module 2
  var HEX = '0123456789ABCDEF';

  // ---------- bits ----------
  function hexToBytes(h) { var o = []; for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o; }
  function bytesToHex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15]; return s; }
  function crc16(bytes) { var c = 0xB5E3; for (var i = 0; i < bytes.length; i++) { c ^= bytes[i] << 8; for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c; }
  function toBits(bytes) { var b = []; bytes.forEach(function (v) { for (var k = 7; k >= 0; k--) b.push((v >> k) & 1); }); return b; }
  function bitsToBytes(b) { var o = []; for (var i = 0; i < b.length; i += 8) { var v = 0; for (var k = 0; k < 8; k++) v = (v << 1) | b[i + k]; o.push(v); } return o; }
  // fixed whitening mask (same on every tag): a 16-bit LFSR
  var MASK = (function () { var m = [], x = 0xACE1; for (var i = 0; i < 320; i++) { var bit = ((x >> 0) ^ (x >> 2) ^ (x >> 3) ^ (x >> 5)) & 1; x = (x >> 1) | (bit << 15); m.push(x & 1); } return m; })();

  // ---------- layout ----------
  var RESERVED = {}, MARKS = [];
  (function () {
    function mark(cx, cy, vals) { vals.forEach(function (v, i) { var x = cx + (i % 2), y = cy + (i >> 1); RESERVED[x + ',' + y] = 1; MARKS.push([x, y, v]); }); }
    mark(0, 0, [1, 1, 1, 1]);                         // top-left: black block
    mark(DW - 2, 0, [0, 0, 0, 0]);                    // top-right: white block
    mark(0, DH - 2, [1, 0, 0, 1]);                    // bottom-left: checker
  })();
  var CELLS = [];                                      // data cell coordinates in reading order
  for (var y = 0; y < DH; y++) for (var x = 0; x < DW; x++) if (!RESERVED[x + ',' + y]) CELLS.push([x, y]);
  var NC = CELLS.length;                                // 303

  // payload (80 bits) + crc (16) = 96 bits -> positions of every copy
  function positions() { var A = [], B = [], C = []; for (var i = 0; i < 96; i++) { A.push(i); B.push(NC - 1 - i); } for (var j = 0; j < Math.min(96, NC - 192); j++) C.push(96 + j); return { A: A, B: B, C: C }; }
  var POS = positions();

  function encodeMatrix(tokenHex) {
    var bytes = hexToBytes(tokenHex); if (bytes.length !== 10) throw new Error('token must be 20 hex characters');
    var c = crc16(bytes), all = toBits(bytes.concat([c >> 8, c & 255]));
    var data = new Array(NC).fill(0);
    for (var i = 0; i < 96; i++) { data[POS.A[i]] = all[i]; data[POS.B[i]] = all[i]; }
    for (var j = 0; j < POS.C.length; j++) data[POS.C[j]] = all[j];
    var M = []; for (var r = 0; r < SH; r++) { M.push(new Array(SW).fill(0)); }
    for (var k = 0; k < SW; k++) { M[0][k] = 1; M[SH - 1][k] = 1; }
    for (var k2 = 0; k2 < SH; k2++) { M[k2][0] = 1; M[k2][SW - 1] = 1; }
    MARKS.forEach(function (m) { M[OFF + m[1]][OFF + m[0]] = m[2]; });
    for (var n = 0; n < NC; n++) M[OFF + CELLS[n][1]][OFF + CELLS[n][0]] = data[n] ^ MASK[n];
    return M;
  }
  function render(tokenHex, px) {
    px = px || 12; var q = 1, M = encodeMatrix(tokenHex);
    var c = document.createElement('canvas'); c.width = (SW + 2 * q) * px; c.height = (SH + 2 * q) * px; var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    for (var y = 0; y < SH; y++) for (var x = 0; x < SW; x++) if (M[y][x]) g.fillRect((x + q) * px, (y + q) * px, px, px);
    return c;
  }

  // ---------- decoding ----------
  function solve(A, b) {                                // Gaussian elimination, 8x8
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) A[i].push(b[i]);
    for (i = 0; i < n; i++) {
      var p = i; for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      var t = A[i]; A[i] = A[p]; A[p] = t; if (Math.abs(A[i][i]) < 1e-12) return null;
      for (j = i + 1; j < n; j++) { var f = A[j][i] / A[i][i]; for (k = i; k <= n; k++) A[j][k] -= f * A[i][k]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = A[i][n]; for (j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    return x;
  }
  function homography(src, dst) {                       // maps src[i] -> dst[i]
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var h = solve(A, b); if (!h) return null; h.push(1); return h;
  }
  function apply(h, x, y) { var w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; }

  function grayOf(id) { var d = id.data, n = id.width * id.height, g = new Float32Array(n); for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; return g; }
  function blur3(g, w, h) { var o = new Float32Array(g.length); for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) { var i = y * w + x; o[i] = (g[i] * 4 + g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) / 8; } return o; }
  function sample(g, w, h, x, y) { var x0 = Math.floor(x), y0 = Math.floor(y); if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return null; var fx = x - x0, fy = y - y0, i = y0 * w + x0; return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy; }

  // dark pixels (adaptive threshold over a sliding window, computed with an integral image)
  function binarize(g, w, h) {
    var I = new Float64Array((w + 1) * (h + 1)), x, y;
    for (y = 1; y <= h; y++) { var row = 0; for (x = 1; x <= w; x++) { row += g[(y - 1) * w + (x - 1)]; I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x] + row; } }
    var r = Math.max(20, Math.round(Math.min(w, h) / 6)), out = new Uint8Array(w * h);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      var s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0], m = s / ((x1 - x0) * (y1 - y0));
      out[y * w + x] = g[y * w + x] < m - 10 ? 1 : 0;
    }
    return out;
  }
  function components(bin, w, h) {                       // 8-connected, returns [{area, pts}] (points subsampled)
    var lab = new Int32Array(w * h), comps = [], stack = new Int32Array(w * h), id = 0;
    for (var s0 = 0; s0 < w * h; s0++) {
      if (!bin[s0] || lab[s0]) continue;
      id++; var sp = 0, area = 0, pts = [], step = 1; stack[sp++] = s0; lab[s0] = id;
      var minx = w, maxx = 0, miny = h, maxy = 0;
      while (sp) {
        var p = stack[--sp], px = p % w, py = (p - px) / w; area++;
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
        pts.push([px, py]);
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; var nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var q = ny * w + nx; if (bin[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
        }
      }
      if (area > 250) comps.push({ area: area, pts: pts, bbox: [minx, miny, maxx, maxy] });
    }
    return comps;
  }
  function hull(pts) {                                    // monotone chain
    var P = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }); if (P.length < 3) return P;
    var cr = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }, L = [], U = [], i;
    for (i = 0; i < P.length; i++) { while (L.length >= 2 && cr(L[L.length - 2], L[L.length - 1], P[i]) <= 0) L.pop(); L.push(P[i]); }
    for (i = P.length - 1; i >= 0; i--) { while (U.length >= 2 && cr(U[U.length - 2], U[U.length - 1], P[i]) <= 0) U.pop(); U.push(P[i]); }
    L.pop(); U.pop(); return L.concat(U);
  }
  function polyArea(H) { var a = 0; for (var i = 0; i < H.length; i++) { var j = (i + 1) % H.length; a += H[i][0] * H[j][1] - H[j][0] * H[i][1]; } return Math.abs(a) / 2; }
  function corners(H) {                                   // four corners of a (perspective) square from its convex hull
    var cx = 0, cy = 0; H.forEach(function (p) { cx += p[0]; cy += p[1]; }); cx /= H.length; cy /= H.length;
    var far = function (ref) { var b = H[0], bd = -1; H.forEach(function (p) { var d = Math.pow(p[0] - ref[0], 2) + Math.pow(p[1] - ref[1], 2); if (d > bd) { bd = d; b = p; } }); return b; };
    var p1 = far([cx, cy]), p3 = far(p1);
    var side = function (p) { return (p3[0] - p1[0]) * (p[1] - p1[1]) - (p3[1] - p1[1]) * (p[0] - p1[0]); };
    var best = [null, null], bv = [0, 0];
    H.forEach(function (p) { var s = side(p), k = s > 0 ? 0 : 1, a = Math.abs(s); if (a > bv[k]) { bv[k] = a; best[k] = p; } });
    if (!best[0] || !best[1]) return null;
    var q = [p1, best[0], p3, best[1]], sa = 0;           // make the order clockwise on screen (never a mirror image)
    for (var i = 0; i < 4; i++) { var j = (i + 1) % 4; sa += q[i][0] * q[j][1] - q[j][0] * q[i][1]; }
    return sa < 0 ? [q[0], q[3], q[2], q[1]] : q;
  }

  function tryDecode(g, w, h, quad) {
    // all four rotations of the corner order
    var bestRes = null;
    for (var rot = 0; rot < 4; rot++) {
      var q = [quad[rot % 4], quad[(rot + 1) % 4], quad[(rot + 2) % 4], quad[(rot + 3) % 4]];
      var H = homography([[0, 0], [SW, 0], [SW, SH], [0, SH]], q); if (!H) continue;
      var lum = function (mx, my) {                       // average of 5 samples inside the module
        var t = 0, n = 0, offs = [[0, 0], [-.2, -.2], [.2, -.2], [-.2, .2], [.2, .2]];
        for (var i = 0; i < 5; i++) { var pt = apply(H, mx + .5 + offs[i][0], my + .5 + offs[i][1]), v = sample(g, w, h, pt[0], pt[1]); if (v === null) return null; t += v; n++; }
        return t / n;
      };
      // contrast: frame (dark) against the gap (light)
      var dk = 0, lt = 0, nd = 0, nl = 0, ok = true, a, b, z;
      for (var k = 1; k < SW - 1 && ok; k++) { a = [lum(k, 0), lum(k, SH - 1)]; b = [lum(k, 1), lum(k, SH - 2)]; for (z = 0; z < 2; z++) { if (a[z] === null || b[z] === null) { ok = false; break; } dk += a[z]; nd++; lt += b[z]; nl++; } }
      for (var k3 = 1; k3 < SH - 1 && ok; k3++) { a = [lum(0, k3), lum(SW - 1, k3)]; b = [lum(1, k3), lum(SW - 2, k3)]; for (z = 0; z < 2; z++) { if (a[z] === null || b[z] === null) { ok = false; break; } dk += a[z]; nd++; lt += b[z]; nl++; } }
      if (!ok) continue; dk /= nd; lt /= nl; if (lt - dk < 28) continue;
      var thr = (dk + lt) / 2, margin = (lt - dk) / 2, soft = [];
      // marks decide the orientation
      var markOk = 0;
      for (var m = 0; m < MARKS.length; m++) { var v = lum(OFF + MARKS[m][0], OFF + MARKS[m][1]); if (v === null) { markOk = -99; break; } if ((v < thr ? 1 : 0) === MARKS[m][2]) markOk++; }
      if (markOk < 11) continue;
      var bits = new Array(NC), conf = new Array(NC);
      for (var n = 0; n < NC; n++) {
        var vv = lum(OFF + CELLS[n][0], OFF + CELLS[n][1]); if (vv === null) { bits = null; break; }
        var raw = vv < thr ? 1 : 0; bits[n] = raw ^ MASK[n]; conf[n] = Math.min(1, Math.abs(vv - thr) / margin);
      }
      if (!bits) continue;
      // combine the three copies (soft vote), then check the 16-bit crc; try flipping the weakest bits if needed
      var vote = new Array(96).fill(0), wt = new Array(96).fill(0);
      var add = function (idx, bi) { var sg = bits[idx] ? 1 : -1; vote[bi] += sg * (0.2 + conf[idx]); wt[bi] += 1; };
      for (var i = 0; i < 96; i++) { add(POS.A[i], i); add(POS.B[i], i); }
      for (var j = 0; j < POS.C.length; j++) add(POS.C[j], j);
      var dec = vote.map(function (v) { return v > 0 ? 1 : 0; });
      var check = function (arr) { var by = bitsToBytes(arr), c = crc16(by.slice(0, 10)); return c === ((by[10] << 8) | by[11]) ? bytesToHex(by.slice(0, 10)) : null; };
      var res = check(dec); if (res) return res;
      var weak = vote.map(function (v, i) { return [Math.abs(v), i]; }).sort(function (a, b) { return a[0] - b[0]; }).slice(0, 14).map(function (a) { return a[1]; });
      for (var a1 = 0; a1 < weak.length; a1++) {
        var t1 = dec.slice(); t1[weak[a1]] ^= 1; if ((res = check(t1))) return res;
        for (var a2 = a1 + 1; a2 < weak.length; a2++) {
          var t2 = t1.slice(); t2[weak[a2]] ^= 1; if ((res = check(t2))) return res;
          for (var a3 = a2 + 1; a3 < weak.length; a3++) { var t3 = t2.slice(); t3[weak[a3]] ^= 1; if ((res = check(t3))) return res; }
        }
      }
    }
    return bestRes;
  }
  function decodeImageData(id) {
    var w = id.width, h = id.height, g0 = grayOf(id), g = blur3(g0, w, h);
    var bin = binarize(g, w, h), comps = components(bin, w, h);
    comps.sort(function (a, b) { return b.area - a.area; });
    var tried = 0;
    for (var c = 0; c < comps.length && tried < 8; c++) {
      var comp = comps[c], H = hull(comp.pts); if (H.length < 4) continue;
      var ha = polyArea(H); if (ha < 500) continue;
      var ratio = comp.area / ha; if (ratio < 0.12 || ratio > 0.62) continue;       // a thin square frame: far less than a filled block
      var bw = comp.bbox[2] - comp.bbox[0], bh = comp.bbox[3] - comp.bbox[1]; if (bw < 25 || bh < 8) continue;
      var quad = corners(H); if (!quad) continue; tried++;
      var res = tryDecode(g0, w, h, quad) || tryDecode(g, w, h, quad); if (res) return res;
    }
    return null;
  }

  function loadBitmap(file) {
    return new Promise(function (resolve, reject) {
      if (window.createImageBitmap) { createImageBitmap(file).then(resolve, function () { fallback(); }); } else fallback();
      function fallback() { var im = new Image(), u = URL.createObjectURL(file); im.onload = function () { resolve(im); }; im.onerror = reject; im.src = u; }
    });
  }
  function draw(bm, maxSide, rot) {
    var s = Math.min(1, maxSide / Math.max(bm.width, bm.height)), w = Math.round(bm.width * s), h = Math.round(bm.height * s);
    var c = document.createElement('canvas'); c.width = w; c.height = h; var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0, w, h); return g.getImageData(0, 0, w, h);
  }
  function decodeFile(file) {
    return loadBitmap(file).then(function (bm) {
      var sizes = [900, 1400, 2200, 3200];
      for (var i = 0; i < sizes.length; i++) { var res = decodeImageData(draw(bm, sizes[i])); if (res) return res; }
      return null;
    });
  }
  window.SealCode = { render: render, encodeMatrix: encodeMatrix, decodeImageData: decodeImageData, decodeFile: decodeFile, SIZE: SW + 'x' + SH, CAPACITY_COPIES: 3 };
})();
