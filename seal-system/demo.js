(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, SG = window.SealGate, B = window.SealLocal;
  SG.use(B); SG.enabled = true; SG.mode = 'on'; SG.allowTyping = true; SG.previewUrl = 'preview.html';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  document.getElementById('tabs').onclick = function (e) { var b = e.target.closest('button[data-p]'); if (!b) return; document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); }); document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + b.dataset.p); }); if (b.dataset.p === 'admin') paintAdmin(); };

  // 1 entry
  $('e-new').onclick = function () { $('e-qr').value = 'S1-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Math.floor(Math.random() * 9000) + 1000); };
  $('e-go').onclick = async function () {
    var qr = $('e-qr').value.trim(); if (!qr) { $('e-msg').textContent = 'Type or generate a sample QR first.'; return; }
    var s = await SG.askSeals(2); if (!s) { $('e-msg').textContent = 'Registration cancelled: nothing saved.'; return; }
    var r = await B.register({ qr: qr, a: s[0], b: s[1] });
    $('e-msg').textContent = r.success ? 'Seals ' + s[0] + ' and ' + s[1] + ' are linked to ' + qr + '. They are interchangeable: the lab decides which one is used first.' : r.message;
  };

  // 2 lab: the sample QR is scanned as usual; a sealed sample then asks for its seal; the tray clears seals in advance
  var trays = {};
  function mountTray() { var k = $('l-kind').value; $('l-tray').innerHTML = ''; $('l-tray')._sgTray = false; SG.tray({ kind: k, el: $('l-tray') }); }
  var setStation = function () { B.station = $('l-st').value; mountTray(); };
  $('l-st').onchange = setStation; $('l-kind').onchange = setStation; setStation();
  $('l-go').onclick = async function () {
    var qr = $('l-qr').value.trim(); if (!qr) return;
    var ok = await SG.gate($('l-kind').value, qr);
    $('l-msg').textContent = ok ? 'Sample ' + qr + ': you may enter the result.' : 'Sample ' + qr + ' refused. The event was logged for the Admin.';
    if (ok) { await SG.showVerdict(true, 'SAMPLE OK', 'Go ahead with the test.'); $('l-qr').value = ''; }
  };
  $('e-old').onclick = function () { var qr = $('e-qr').value.trim(); if (!qr) { $('e-msg').textContent = 'Type a sample QR first.'; return; } B.addOldSample(qr); $('e-msg').textContent = qr + ' registered as an OLD sample (before the switch): no seal needed.'; };
  $('e-bottom').onclick = async function () {
    var qr = $('e-qr').value.trim(), orig = $('e-orig').value.trim(); if (!qr || !orig) { $('e-msg').textContent = 'Type the bottom sample QR and the original sample QR.'; return; }
    var s = await SG.askSeals(1); if (!s) { $('e-msg').textContent = 'Cancelled.'; return; }
    var r = await B.register({ qr: qr, a: s[0], bottomOf: orig }); $('e-msg').textContent = r.success ? 'Bottom sample ' + qr + ' linked to seal ' + s[0] + '. The composite seal of ' + orig + ' is cancelled; its lab seal stays valid.' : r.message;
  };
  $('h-preview').onclick = function () { SG.preview(); };

  // 3 admin
  function paintAdmin() {
    var d = B.dump();
    $('a-seals').innerHTML = Object.keys(d.seals).map(function (c) { var s = d.seals[c]; return '<tr><td>' + esc(c) + '</td><td>' + s.kind + '</td><td>' + esc(s.qr) + '</td><td>' + s.status + '</td><td>' + (s.clearedAt ? 'cleared ' + new Date(s.clearedAt).toLocaleTimeString() : '') + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="note">No seals yet.</td></tr>';
    $('a-ev').innerHTML = d.events.map(function (e) { return '<tr><td>' + esc(e.at.slice(0, 19).replace('T', ' ')) + '</td><td>' + esc(e.event) + '</td><td>' + esc(e.code) + '</td><td>' + esc(e.detail) + '</td></tr>'; }).join('') || '<tr><td colspan="4" class="note">No events.</td></tr>';
  }
  $('a-void').onclick = function () { B.voidSample($('a-qr').value, 'QR cancelled'); paintAdmin(); };
  $('a-reset').onclick = function () { if (confirm('Clear all demo seals and events?')) { B.reset(); paintAdmin(); } };

  // 4 photo test
  var results = [];
  $('ph-go').onclick = async function () {
    var files = [].slice.call($('ph-files').files); results = []; $('ph-body').innerHTML = ''; var ok = 0;
    for (var i = 0; i < files.length; i++) {
      var t0 = performance.now(), r = await SG.decodeFile(files[i]), ms = Math.round(performance.now() - t0);
      results.push([files[i].name, r ? r.code : '', r ? r.method : 'NOT READ', ms]); if (r) ok++;
      var tr = document.createElement('tr'); tr.innerHTML = '<td>' + esc(files[i].name) + '</td><td class="' + (r ? 'pass' : 'fail') + '">' + esc(r ? r.code : 'NOT READ') + '</td><td>' + esc(r ? r.method : '') + '</td><td>' + ms + '</td>'; $('ph-body').appendChild(tr);
      $('ph-sum').textContent = 'Read ' + ok + ' of ' + (i + 1) + ' so far (' + Math.round(ok / (i + 1) * 100) + '%)';
    }
    $('ph-sum').textContent = 'Done: ' + ok + ' of ' + files.length + ' photos read (' + (files.length ? Math.round(ok / files.length * 100) : 0) + '%).';
  };
  $('ph-csv').onclick = function () { var c = 'photo,code,method,ms\r\n' + results.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n'); var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([c], { type: 'text/csv' })); a.download = 'seal-photo-test.csv'; a.click(); };

  // 5 self-test: the rules, on a scratch store
  $('s-go').onclick = async function () {
    var keep = localStorage.getItem('SEAL_DEMO_DB2'), out = [], t = function (n, c) { out.push([n, !!c]); };
    try {
      B.reset(); B.station = 'lab1m';
      t('register two interchangeable seals', (await B.register({ qr: 'Q1', a: 'A-1', b: 'B-1' })).success);
      t('same seal twice refused', !(await B.register({ qr: 'Q9', a: 'X', b: 'x' })).success);
      t('reused seal refused', !(await B.register({ qr: 'Q9', a: 'A-1', b: 'C-9' })).success);
      t('precheck lists used', (await B.precheck(['a-1', 'new'])).used.join() === 'A-1');
      t('QR scanned, seal not scanned: asks for a seal', (await B.gate({ qr: 'q1', kind: 'LAB' })).verdict === 'SEAL_NOT_SCANNED');
      t('unknown seal = tampered', (await B.clear({ code: 'NOPE', kind: 'LAB' })).verdict === 'NOT_REGISTERED');
      t('seal of another sample = mismatch, logged', (await B.clear({ code: 'A-1', kind: 'LAB', qr: 'Q2' })).verdict === 'SAMPLE_MISMATCH' && B.dump().events.some(function (e) { return /TAMPERED/.test(e.detail); }));
      t('either seal can be the lab seal (B scanned first)', (await B.clear({ code: 'B-1', kind: 'LAB' })).ok);
      t('then the QR scan passes without another seal scan', (await B.gate({ qr: 'Q1', kind: 'LAB' })).ok);
      B.station = 'lab1f'; t('the other lab login passes too (shared)', (await B.gate({ qr: 'Q1', kind: 'LAB' })).ok);
      t('the sample\'s other seal is refused for the lab test', (await B.clear({ code: 'A-1', kind: 'LAB' })).verdict === 'WRONG_SEAL');
      t('the used lab seal is refused at the mixing scan', (await B.clear({ code: 'B-1', kind: 'COMP' })).verdict === 'WRONG_SEAL');
      t('the other seal becomes the composite seal', (await B.clear({ code: 'A-1', kind: 'COMP' })).ok && (await B.gate({ qr: 'Q1', kind: 'COMP' })).ok);
      B.station = 'lab1m'; t('moisture login cannot clear a composite seal', (await B.clear({ code: 'A-1', kind: 'COMP' })).verdict === 'WRONG_SEAL');
      B.station = 'lab1f'; B.ageSeal('B-1', 20); t('a seal cleared too long ago is refused', (await B.gate({ qr: 'Q1', kind: 'LAB' })).verdict === 'EXPIRED');
      B.reset(); await B.register({ qr: 'Q3', a: 'A-3', b: 'B-3' });
      t('composite purpose can be taken first', (await B.clear({ code: 'B-3', kind: 'COMP' })).ok);
      B.station = 'lab1m'; t('then the other seal is the lab seal', (await B.clear({ code: 'A-3', kind: 'LAB' })).ok && !(await B.clear({ code: 'B-3', kind: 'LAB' })).ok);
      B.addOldSample('OLD1'); t('old sample: no seal needed', (await B.gate({ qr: 'OLD1', kind: 'LAB' })).verdict === 'NO_SEAL_NEEDED');
      t('unknown QR: no seal needed (existing checks decide)', !(await B.gate({ qr: 'ZZZ', kind: 'LAB' })).required);
      B.stampWithoutSeals('Q7'); t('stamped sample without seals is blocked', (await B.gate({ qr: 'Q7', kind: 'LAB' })).verdict === 'NOT_LINKED');
      B.reset(); await B.register({ qr: 'Q4', a: 'A-4', b: 'B-4' }); B.station = 'lab1m'; await B.clear({ code: 'A-4', kind: 'LAB' });
      await B.register({ qr: 'Q4B', a: 'A-5', bottomOf: 'Q4' }); B.station = 'lab1f';
      t('bottom sample: original composite seal cancelled', (await B.clear({ code: 'B-4', kind: 'COMP' })).verdict === 'VOIDED' || (await B.clear({ code: 'B-4', kind: 'COMP' })).verdict === 'VOIDED');
      t('bottom sample: original composite purpose blocked', (await B.gate({ qr: 'Q4', kind: 'COMP' })).verdict === 'VOIDED');
      t('bottom sample: original lab seal still valid', (await B.gate({ qr: 'Q4', kind: 'LAB' })).ok);
      t('bottom sample needs no lab seal', !(await B.gate({ qr: 'Q4B', kind: 'LAB' })).required);
      t('bottom sample seal refused for the lab test', (await B.clear({ code: 'A-5', kind: 'LAB' })).verdict === 'WRONG_SEAL');
      t('bottom sample seal works at the mixing scan', (await B.clear({ code: 'A-5', kind: 'COMP' })).ok && (await B.gate({ qr: 'Q4B', kind: 'COMP' })).ok);
      B.reset(); await B.register({ qr: 'Q6', a: 'A-6', b: 'B-6' }); B.voidSample('Q6', 'QR cancelled');
      t('cancelled QR cancels its seals', (await B.clear({ code: 'A-6', kind: 'LAB' })).verdict === 'VOIDED');
    } finally { if (keep === null) localStorage.removeItem('SEAL_DEMO_DB2'); else localStorage.setItem('SEAL_DEMO_DB2', keep); }
    $('s-body').innerHTML = out.map(function (o) { return '<tr><td>' + esc(o[0]) + '</td><td class="' + (o[1] ? 'pass' : 'fail') + '">' + (o[1] ? 'PASS' : 'FAIL') + '</td></tr>'; }).join('');
    window.__selfTest = out;
  };
})();
