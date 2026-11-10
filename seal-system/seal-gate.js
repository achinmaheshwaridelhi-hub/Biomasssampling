/* Barcoded seals - shared scan window + verdict signs + decoder.  No dependency on the biomass app.
 *
 * A "backend" supplies the rules (the stand-alone page uses a local store, the biomass app uses the database):
 *   backend.enabled()                                   -> Promise<boolean>
 *   backend.precheck(codes[])                           -> Promise<{ used: [codes already registered] }>
 *   backend.register({ qr, lab, comp })                 -> Promise<{ success, message }>
 *   backend.clear({ code, kind, qr? })                  -> Promise<{ ok, verdict, message }>      (kind: 'LAB' | 'COMP'; qr only when asked after a QR scan)
 *   backend.gate({ qr, kind })                          -> Promise<{ required, ok, verdict }>     (does this sample need a seal, and is it cleared?)
 * Nothing here ever receives or shows a truck, supplier or vehicle: a seal answers only "intact" or "not intact".
 */
(function () {
  'use strict';
  var SG = { enabled: false, mode: 'off', backend: null };
  var $ = function (h) { var d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  SG.norm = function (c) { return String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, ''); };
  SG.use = function (b) { SG.backend = b; };
  // mode: 'off' (nothing visible), 'preview' (new fields shown greyed out, not working), 'on'
  SG.refresh = async function () {
    try {
      var m = SG.backend && SG.backend.mode ? await SG.backend.mode() : ((SG.backend && await SG.backend.enabled()) ? 'on' : 'off');
      SG.mode = (m === 'on' || m === 'preview') ? m : 'off';
    } catch (e) { SG.mode = 'off'; }
    SG.enabled = SG.mode === 'on'; return SG.enabled;
  };
  // seals carry no printed number: typing is only for the stand-alone demo and the simulated preview
  SG.typing = function () { return !!(window.__SEAL_ALLOW_TYPING || SG.allowTyping); };

  var VERDICT_TEXT = {
    OK: ['SEAL OK', 'The seal is intact and belongs to this sample type.'],
    OK_SECOND: ['SEAL OK', 'Opened earlier by the other lab test of this sample. Allowed once for this test.'],
    NOT_REGISTERED: ['TAMPERED', 'This seal was never registered. The sample must not be used.'],
    ALREADY_OPENED: ['TAMPERED', 'This seal was already opened. The sample must not be used.'],
    VOIDED: ['TAMPERED', 'This seal was cancelled. The sample must not be used.'],
    WRONG_SEAL: ['TAMPERED', 'This seal is not meant for this test: it is the other seal of the truck, or already used for the other purpose.'],
    SAMPLE_MISMATCH: ['TAMPERED', 'This seal does not belong to the sample scanned.'],
    OK_AGAIN: ['SEAL OK', 'This seal was already cleared by the lab.'],
    NOT_LINKED: ['BLOCKED', 'This sample has no seal linked. Ask the Admin.'],
    EXPIRED: ['CHECK AGAIN', 'This seal was cleared too long ago. Ask the Admin.'],
    DUPLICATE: ['NOT ALLOWED', 'This seal is already used.'],
    SAME: ['NOT ALLOWED', 'The two seals must be different.']
  };
  SG.verdictText = function (v, msg) { var t = VERDICT_TEXT[v] || (v && /^OK/.test(v) ? VERDICT_TEXT.OK : ['TAMPERED', msg || '']); return [t[0], msg || t[1]]; };

  // ---------- decoding a photo of a seal ----------
  function readerDiv() { var d = document.getElementById('sg-reader'); if (!d) { d = document.createElement('div'); d.id = 'sg-reader'; d.style.display = 'none'; document.body.appendChild(d); } return d; }
  async function bitmapOf(file) { if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch (e) {} } return new Promise(function (res, rej) { var im = new Image(), u = URL.createObjectURL(file); im.onload = function () { res(im); }; im.onerror = rej; im.src = u; }); }
  function toFile(canvas, name) { return new Promise(function (res) { canvas.toBlob(function (b) { res(new File([b], name || 'x.png', { type: 'image/png' })); }, 'image/png'); }); }
  async function variants(file) {
    var out = [{ f: file, tag: 'original' }];
    try {
      var bm = await bitmapOf(file), w = bm.width, h = bm.height, scale = Math.min(1, 1400 / Math.max(w, h));
      var mk = async function (rot, contrast, tag) {
        var c = document.createElement('canvas'), sw = Math.round(w * scale), sh = Math.round(h * scale);
        c.width = rot ? sh : sw; c.height = rot ? sw : sh; var x = c.getContext('2d');
        if (contrast) x.filter = 'grayscale(1) contrast(1.6) brightness(1.05)';
        x.translate(c.width / 2, c.height / 2); if (rot) x.rotate(Math.PI / 2); x.drawImage(bm, -sw / 2, -sh / 2, sw, sh);
        out.push({ f: await toFile(c, tag + '.png'), tag: tag });
      };
      await mk(false, false, 'scaled'); await mk(false, true, 'contrast'); await mk(true, true, 'rotated');
    } catch (e) {}
    return out;
  }
  // returns { code, method } or null
  SG.decodeFile = async function (file) {
    if ('BarcodeDetector' in window) {
      try { var det = new window.BarcodeDetector(), bm = await bitmapOf(file), r = await det.detect(bm); if (r && r.length) return { code: r[0].rawValue, method: 'BarcodeDetector' }; } catch (e) {}
    }
    if (window.Html5Qrcode) {
      var vs = await variants(file);
      for (var i = 0; i < vs.length; i++) {
        try { var q = new window.Html5Qrcode(readerDiv().id); var code = await q.scanFile(vs[i].f, false); if (code) return { code: code, method: 'html5-qrcode/' + vs[i].tag }; } catch (e) {}
      }
    }
    return null;
  };

  // ---------- the window ----------
  var root = null, els = {};
  function build() {
    if (root) return;
    root = $('<div class="sg-back" role="dialog" aria-modal="true"><div class="sg-card">' +
      '<div class="sg-title" id="sg-t"></div><div class="sg-hint" id="sg-h"></div>' +
      '<div id="sg-scan"><button type="button" class="sg-snap" id="sg-snap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>Scan seal</button>' +
      '<input type="file" accept="image/*" capture="environment" id="sg-file" style="display:none">' +
      '<div class="sg-row"><input type="text" id="sg-code" autocomplete="off" placeholder="Seal number"><button type="button" class="sg-btn" id="sg-go">Check</button></div></div>' +
      '<div class="sg-busy" id="sg-busy"><i style="width:60%"></i><i></i></div>' +
      '<div class="sg-verdict" id="sg-v"><div class="sg-circle" id="sg-c"></div><div class="sg-vtitle" id="sg-vt"></div><div class="sg-vmsg" id="sg-vm"></div></div>' +
      '<div class="sg-foot"><button type="button" class="sg-btn ghost" id="sg-x">Cancel</button></div></div></div>');
    document.body.appendChild(root);
    ['t', 'h', 'scan', 'snap', 'file', 'code', 'go', 'busy', 'v', 'c', 'vt', 'vm', 'x'].forEach(function (k) { els[k] = root.querySelector('#sg-' + k); });
  }
  var TICK = '<svg viewBox="0 0 100 100"><path d="M24 52 L43 71 L77 31" pathLength="100"/></svg>', CROSS = '<svg viewBox="0 0 100 100"><path d="M28 28 L72 72 M72 28 L28 72" pathLength="100"/></svg>';

  /* Asks for one seal.  opts: { title, hint, check(code) -> Promise<{ ok, verdict, message }> }
   * Resolves { ok, code, verdict } when the check passes (after a short green sign), or { ok:false, cancelled:true } on Cancel.
   * A failed check shows the red sign and a Close button; the caller decides what happens next (the window then resolves { ok:false, verdict }). */
  SG.askSeal = function (opts) {
    build();
    return new Promise(function (resolve) {
      var done = false;
      els.t.textContent = opts.title || 'Scan the seal'; els.h.textContent = opts.hint || '';
      els.scan.style.display = ''; els.v.className = 'sg-verdict'; els.busy.className = 'sg-busy'; els.code.value = ''; els.x.textContent = 'Cancel'; els.x.style.display = '';
      els.code.parentNode.style.display = SG.typing() ? '' : 'none';
      root.className = 'sg-back on';
      var finish = function (r) { if (done) return; done = true; root.className = 'sg-back'; cleanup(); resolve(r); };
      var show = function (res, code) {
        var ok = !!res.ok, t = SG.verdictText(res.verdict, res.message);
        els.scan.style.display = 'none'; els.busy.className = 'sg-busy';
        els.c.className = 'sg-circle ' + (ok ? 'ok' : 'bad'); els.c.innerHTML = ok ? TICK : CROSS;
        els.vt.className = 'sg-vtitle ' + (ok ? 'ok' : 'bad'); els.vt.textContent = t[0]; els.vm.textContent = t[1];
        els.v.className = 'sg-verdict on';
        if (ok) { els.x.style.display = 'none'; setTimeout(function () { finish({ ok: true, code: code, verdict: res.verdict }); }, 1300); }
        else { els.x.textContent = 'Close'; els.x.onclick = function () { finish({ ok: false, code: code, verdict: res.verdict }); }; }
      };
      var run = async function (raw) {
        var code = SG.norm(raw); if (!code) return;
        els.scan.style.display = 'none'; els.busy.className = 'sg-busy on';
        var res; try { res = await opts.check(code); } catch (e) { res = { ok: false, verdict: 'ERROR', message: (e && e.message) || 'Could not check the seal.' }; }
        show(res || { ok: false, verdict: 'ERROR' }, code);
      };
      var onSnap = function () { els.file.click(); };
      var onFile = async function () {
        var f = els.file.files && els.file.files[0]; els.file.value = ''; if (!f) return;
        els.scan.style.display = 'none'; els.busy.className = 'sg-busy on';
        var r = await SG.decodeFile(f);
        if (!r) { els.busy.className = 'sg-busy'; els.scan.style.display = ''; els.h.textContent = 'No barcode found in that photo. Hold the phone closer, keep the seal flat and well lit, and try again.'; return; }
        run(r.code);
      };
      var onGo = function () { run(els.code.value); };
      var onKey = function (e) { if (e.key === 'Enter') { e.preventDefault(); onGo(); } };
      var onX = function () { finish({ ok: false, cancelled: true }); };
      els.snap.onclick = onSnap; els.file.onchange = onFile; els.go.onclick = onGo; els.code.onkeydown = onKey; els.x.onclick = onX;
      function cleanup() { els.snap.onclick = els.file.onchange = els.go.onclick = els.code.onkeydown = els.x.onclick = null; }
      setTimeout(function () { try { if (SG.typing()) els.code.focus(); } catch (e) {} }, 60);
    });
  };

  /* Registration at the gate: n interchangeable seals (2 for a truck, 1 for a bottom sample). Returns [codes] or null. */
  SG.askSeals = async function (n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var prior = out.slice();
      var r = await SG.askSeal({ title: n > 1 ? 'Seal ' + (i + 1) + ' of ' + n : 'Scan the seal',
        hint: n > 1 ? 'Scan the barcode of seal ' + (i + 1) + '. The two seals are interchangeable.' : 'Scan the barcode of the seal on the sample.',
        check: (function (pr) { return async function (c) {
          if (pr.some(function (x) { return SG.norm(x) === SG.norm(c); })) return { ok: false, verdict: 'SAME' };
          var rr = await SG.backend.precheck([c]);
          return (rr && rr.used && rr.used.length) ? { ok: false, verdict: 'DUPLICATE' } : { ok: true, verdict: 'OK', message: 'Seal accepted.' };
        }; })(prior) });
      if (!r.ok) return null;
      out.push(r.code);
    }
    return out;
  };

  /* After a sample QR was scanned in a lab login: true = go on, false = stop.
   * The database says: no seal needed (old sample) / cleared / scan the seal now.  The operator is never asked whether a sample is old or new. */
  SG.gate = async function (kind, qr) {
    if (!SG.enabled) return true;
    var g; try { g = await SG.backend.gate({ qr: qr, kind: kind }); } catch (e) { await SG.showVerdict(false, 'NOT ALLOWED', e.message || 'Could not check the seal.'); return false; }
    if (!g || !g.required || g.ok) return true;
    if (g.verdict === 'SEAL_NOT_SCANNED') {
      var r = await SG.askSeal({ title: 'Scan the seal of this sample',
        hint: kind === 'COMP' ? 'This container is sealed. Scan the seal on it before it is mixed.' : 'This sample is sealed. Scan the seal on it before the result can be entered.',
        check: function (code) { return SG.backend.clear({ code: code, kind: kind, qr: qr }); } });
      return !!r.ok;
    }
    var t = SG.verdictText(g.verdict, g.message); await SG.showVerdict(false, t[0], t[1]); return false;
  };

  /* Seal tray: scan the seals of all samples first (bulk).  opts: { kind, el }  Builds its own panel inside el. */
  SG.tray = function (opts) {
    var el = opts.el; if (!el || el._sgTray) return; el._sgTray = true;
    var kind = opts.kind, ok = 0;
    el.innerHTML = '<div class="sg-tray"><div class="sg-tray-head"><b>' + (kind === 'COMP' ? 'Seals of the composite containers' : 'Seals of the samples to test') + '</b><span class="sg-count">Cleared: <i>0</i></span></div>' +
      '<div class="sg-last" style="display:none"></div>' +
      '<button type="button" class="sg-snap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>Scan seal</button>' +
      '<input type="file" accept="image/*" capture="environment" style="display:none">' +
      '<div class="sg-row sg-trow"><input type="text" class="sg-tcode" autocomplete="off" placeholder="Seal number"><button type="button" class="sg-btn sg-tadd">Add</button></div>' +
      '<ul class="sg-list"></ul></div>';
    var q = function (c) { return el.querySelector(c); };
    var last = q('.sg-last'), list = q('.sg-list'), file = q('input[type=file]'), code = q('.sg-tcode');
    var show = function (res, c) {
      var good = !!res.ok, t = SG.verdictText(res.verdict, res.message);
      last.style.display = ''; last.className = 'sg-last ' + (good ? 'ok' : 'bad');
      last.innerHTML = '<span class="sg-mini">' + (good ? TICK : CROSS) + '</span><span><b>' + esc(t[0]) + '</b> ' + esc(c) + '<br><small>' + esc(t[1]) + '</small></span>';
      var li = document.createElement('li'); li.className = good ? 'ok' : 'bad'; li.innerHTML = '<span class="sg-mini">' + (good ? TICK : CROSS) + '</span><span>' + esc(c) + '</span><em>' + esc(t[0]) + '</em>';
      list.insertBefore(li, list.firstChild); while (list.children.length > 30) list.removeChild(list.lastChild);
      if (good) { ok++; q('.sg-count i').textContent = ok; }
    };
    var run = async function (raw) {
      var c = SG.norm(raw); if (!c) return;
      var res; try { res = await SG.backend.clear({ code: c, kind: kind }); } catch (e) { res = { ok: false, verdict: 'ERROR', message: (e && e.message) || 'Could not check.' }; }
      show(res || { ok: false, verdict: 'ERROR' }, c);
    };
    q('.sg-snap').onclick = function () { file.click(); };
    file.onchange = async function () {
      var f = file.files && file.files[0]; file.value = ''; if (!f) return;
      var b = q('.sg-snap'); b.disabled = true;
      var r = await SG.decodeFile(f); b.disabled = false;
      if (!r) { show({ ok: false, verdict: 'ERROR', message: 'No barcode found in that photo. Hold the phone closer, keep the seal flat and well lit, and try again.' }, ''); return; }
      run(r.code);
    };
    q('.sg-trow').style.display = SG.typing() ? '' : 'none';
    q('.sg-tadd').onclick = function () { run(code.value); code.value = ''; code.focus(); };
    code.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); q('.sg-tadd').click(); } };
  };

  // a plain verdict sign (no scanning), resolved when closed
  SG.showVerdict = function (ok, title, msg) {
    build();
    return new Promise(function (resolve) {
      els.t.textContent = ''; els.h.textContent = ''; els.scan.style.display = 'none'; els.busy.className = 'sg-busy';
      els.c.className = 'sg-circle ' + (ok ? 'ok' : 'bad'); els.c.innerHTML = ok ? TICK : CROSS;
      els.vt.className = 'sg-vtitle ' + (ok ? 'ok' : 'bad'); els.vt.textContent = title; els.vm.textContent = msg || '';
      els.v.className = 'sg-verdict on'; root.className = 'sg-back on'; els.x.style.display = ''; els.x.textContent = 'Close';
      var end = function () { root.className = 'sg-back'; els.x.onclick = null; resolve(); };
      els.x.onclick = end; if (ok) setTimeout(end, 1300);
    });
  };

  /* Preview MODE (set by the Super Admin): the new fields are visible in the real screens but greyed out and not working. */
  SG.previewTray = function (el, kind) {
    if (!el || el._sgPv) return; el._sgPv = true;
    el.innerHTML = '<div class="sg-pvmode"><div class="sg-pvbadge">PREVIEW: not active yet. This works only after the Super Admin switches the seal system on.</div>' +
      '<div class="sg-tray sg-greyed"><div class="sg-tray-head"><b>' + (kind === 'COMP' ? 'Seals of the composite containers' : 'Seals of the samples to test') + '</b><span class="sg-count">Cleared: <i>0</i></span></div>' +
      '<button type="button" class="sg-snap" disabled>Scan seal</button><ul class="sg-list"><li class="ok"><span class="sg-mini">' + TICK + '</span><span>example</span><em>SEAL OK</em></li></ul></div></div>';
  };
  SG.previewRegBox = function (before) {
    if (!before || before._sgPvBox) return; before._sgPvBox = true;
    var d = document.createElement('div'); d.className = 'sg-pvmode'; d.style.margin = '0.8rem 0';
    d.innerHTML = '<div class="sg-pvbadge">PREVIEW: after Register the system will ask for 2 seals. Not active yet.</div><div class="sg-greyed" style="display:flex;gap:.6rem;flex-wrap:wrap"><button type="button" class="sg-btn" disabled>Scan seal 1</button><button type="button" class="sg-btn" disabled>Scan seal 2</button></div>';
    before.parentNode.insertBefore(d, before);
  };

  /* PREVIEW: what each login would look like with the switch ON.  New parts are outlined and marked NEW; everything else is greyed.
   * Nothing here touches a real screen. */
  var PV = {
    'Gate entry': { note: 'Entry and Admin, when registering a truck. Nothing is saved unless both seals are scanned.',
      mock: [['Vendor / PO', 0], ['Vehicle number, challan, driver', 0], ['Photo', 0], ['Register truck', 0],
        ['NEW  After you press Register: a window asks for seal 1, then seal 2 (the two seals are interchangeable). Each shows a green tick when accepted. A seal that is already used, or the same seal twice, is refused. Scanning only: seals carry no printed number.', 1]] },
    'Moisture login': { note: 'Lab 1 / moisture login. The Scan & test screen itself does not change.',
      mock: [['Tabs: Scan & test  |  Today\'s list', 0], ['NEW  Tab "Seal tray": scan the seals of all samples on the bench first. Each scan shows a green tick or a red cross and a running count.', 1],
        ['Scan sample QR (as today, never locked)', 0], ['NEW  Only if the sample is sealed and its seal was not scanned in the tray: "Scan the seal of this sample". Old samples never see this.', 1], ['Moisture and fineness entry (as today)', 0]] },
    'Fineness login': { note: 'Lab 1 / fineness login. Mixing scan works as today.',
      mock: [['Tabs: Scan & test  |  Mixing scan  |  Today\'s list', 0], ['NEW  Tab "Seal tray": seals of the samples to test (shared with the moisture login: whoever scans first clears it for both).', 1],
        ['NEW  Tab "Composite seals": scan the seals of the containers to be mixed, before mixing starts. The seal used for the test cannot be used here: the other seal of the truck is.', 1], ['Mixing scan: scan each container QR, INCLUDE or EXCLUDE (as today)', 0],
        ['NEW  Only if a sealed container\'s seal was not scanned in the tab: "Scan the seal of this sample".', 1]] },
    'Admin': { note: 'Admin sees the seal events in the audit log; the screens do not change.',
      mock: [['Dashboard, reports, inspector (as today)', 0], ['NEW  Audit log lines: SEAL_REGISTERED, SEAL_CLEARED, SEAL_USED, and SEAL_EXCEPTION ... TAMPERED in the critical exceptions list.', 1],
        ['NEW  Bottom sample QR generation also asks for ONE seal; the original sample\'s composite purpose is cancelled and its lab seal stays valid.', 1]] },
    'Unloading, Weighment, Lab 2, Composite': { note: 'No change at all.', mock: [['Every screen stays exactly as it is.', 0]] }
  };
  SG.preview = function () {
    var back = document.getElementById('sg-pv');
    if (!back) {
      back = $('<div class="sg-back" id="sg-pv"><div class="sg-card sg-pvcard"><div class="sg-title">What changes when the switch is ON</div>' +
        '<div class="sg-hint">Outlined parts marked NEW appear. Greyed parts are the existing screen and do not change. Samples registered before the switch is on are never asked for a seal.</div>' +
        '<div class="sg-tabsrow" id="sg-pvt"></div><div id="sg-pvb"></div>' +
        '<p style="margin-top:.6rem"><a href="' + (SG.previewUrl || 'seal-system/preview.html') + '" target="_blank" rel="noopener" style="color:#60a5fa;font-weight:700">Open the live preview on the real screens</a></p>' +
        '<div class="sg-pvsigns"><div class="sg-mini big okc">' + TICK + '</div><span>Seal intact</span><div class="sg-mini big badc">' + CROSS + '</div><span>Tampered: entry stays locked, event logged</span></div>' +
        '<div class="sg-foot"><button type="button" class="sg-btn ghost" id="sg-pvx">Close</button></div></div></div>');
      document.body.appendChild(back);
      var names = Object.keys(PV), tabs = back.querySelector('#sg-pvt'), body = back.querySelector('#sg-pvb');
      var paint = function (n) {
        [].forEach.call(tabs.children, function (b) { b.classList.toggle('on', b.textContent === n); });
        var d = PV[n]; body.innerHTML = '<p class="sg-pvnote">' + esc(d.note) + '</p>' + d.mock.map(function (m) { return '<div class="sg-pvbox' + (m[1] ? ' new' : '') + '">' + esc(m[0]) + '</div>'; }).join('');
      };
      names.forEach(function (n) { var b = document.createElement('button'); b.type = 'button'; b.textContent = n; b.onclick = function () { paint(n); }; tabs.appendChild(b); });
      back.querySelector('#sg-pvx').onclick = function () { back.className = 'sg-back'; };
      paint(names[0]);
    }
    back.className = 'sg-back on';
  };
  window.SealGate = SG;
})();
