/* Local (browser-only) seal store for the stand-alone demo. It applies exactly the rules the database functions apply
 * (db/migrations/2026-11-09_seals.sql), so the behaviour seen here is the behaviour the biomass app will have. */
(function () {
  'use strict';
  var KEY = 'SEAL_DEMO_DB2';
  var norm = function (c) { return String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, ''); };
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || { seals: {}, samples: {}, events: [] }; } catch (e) { return { seals: {}, samples: {}, events: [] }; } }
  function save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
  function ev(d, kind, code, detail) { d.events.unshift({ at: new Date().toISOString(), who: B.user, event: kind, code: code, detail: detail }); d.events = d.events.slice(0, 500); }
  var B = { station: 'lab1', user: 'demo', hours: 16 };
  B.reset = function () { save({ seals: {}, samples: {}, events: [] }); };
  B.dump = load;
  B.enabled = async function () { return true; };
  B.precheck = async function (codes) { var d = load(); return { used: (codes || []).map(norm).filter(function (c) { return d.seals[c]; }) }; };
  // a sample registered while the switch was off: it never needs a seal
  B.addOldSample = function (qr) { var d = load(); d.samples[norm(qr)] = { required: false }; save(d); };
  B.register = async function (o) {
    var d = load(), qr = norm(o.qr), a = norm(o.a), b = norm(o.b);
    if (!qr) return { success: false, message: 'No sample QR.' };
    var act = Object.keys(d.seals).some(function (c) { return d.seals[c].qr === qr && d.seals[c].status !== 'VOIDED'; });
    if (act) return { success: false, message: 'This sample already has seals.' };
    if (o.bottomOf) {
      if (!a) return { success: false, message: 'The seal is needed.' };
      if (d.seals[a]) return { success: false, message: 'This seal is already used.' };
      d.seals[a] = { qr: qr, kind: null, status: 'SEALED' };
      var orig = norm(o.bottomOf), origSeals = Object.keys(d.seals).filter(function (c) { return d.seals[c].qr === orig && d.seals[c].status !== 'VOIDED'; });
      var labAssigned = origSeals.some(function (c) { return d.seals[c].kind === 'LAB'; });
      origSeals.forEach(function (c) { var x = d.seals[c]; if (x.kind === 'COMP' || (x.kind === null && labAssigned)) { x.status = 'VOIDED'; ev(d, 'SEAL_VOIDED', c, 'Composite purpose replaced by a bottom sample'); } });
      if (d.samples[orig]) d.samples[orig].compVoid = true;
      d.samples[qr] = { required: true, bottom: true }; ev(d, 'SEAL_REGISTERED', a, 'Seal linked to bottom sample ' + qr); save(d); return { success: true };
    }
    if (!a || !b) return { success: false, message: 'Both seals are needed.' };
    if (a === b) return { success: false, message: 'The two seals must be different.' };
    if (d.seals[a] || d.seals[b]) return { success: false, message: 'A seal is already used.' };
    d.seals[a] = { qr: qr, kind: null, status: 'SEALED' }; d.seals[b] = { qr: qr, kind: null, status: 'SEALED' };
    d.samples[qr] = { required: true, bottom: false }; ev(d, 'SEAL_REGISTERED', a + ' / ' + b, 'Linked to sample ' + qr); save(d); return { success: true };
  };
  function fresh(s) { return s.clearedAt && (Date.now() - s.clearedAt) < B.hours * 3600 * 1000; }
  B.clear = async function (o) {
    var d = load(), code = norm(o.code), s = d.seals[code], k = o.kind, qr = norm(o.qr), v;
    if (!s) v = 'NOT_REGISTERED';
    else if (s.status === 'VOIDED') v = 'VOIDED';
    else if (k === 'COMP' && B.station !== 'lab1f') v = 'WRONG_SEAL';
    else if (qr && s.qr !== qr) v = 'SAMPLE_MISMATCH';
    else {
      var smp = d.samples[s.qr] || {}, other = Object.keys(d.seals).some(function (c) { var x = d.seals[c]; return c !== code && x.qr === s.qr && x.status !== 'VOIDED' && x.kind === k; });
      if (k === 'COMP' && smp.compVoid) v = 'VOIDED';
      else if (k === 'LAB' && smp.bottom) v = 'WRONG_SEAL';
      else if (s.kind && s.kind !== k) v = 'WRONG_SEAL';
      else if (!s.kind && other) v = 'WRONG_SEAL';
      else if (s.status === 'SEALED') { s.status = 'CLEARED'; s.kind = k; s.clearedAt = Date.now(); s.by = B.station; ev(d, 'SEAL_CLEARED', code, 'Cleared at ' + B.station + ' as the ' + k + ' seal'); v = 'OK'; }
      else v = fresh(s) ? 'OK_AGAIN' : 'EXPIRED';
    }
    var ok = v === 'OK' || v === 'OK_AGAIN';
    if (!ok) ev(d, 'SEAL_EXCEPTION', code, 'TAMPERED seal check at ' + B.station + ': ' + v + (qr ? ' (sample ' + qr + ')' : ''));
    save(d); return { ok: ok, verdict: v };
  };
  B.gate = async function (o) {
    var d = load(), qr = norm(o.qr), k = o.kind, smp = d.samples[qr];
    if (!smp || !smp.required || (k === 'LAB' && smp.bottom)) return { required: false, ok: true, verdict: 'NO_SEAL_NEEDED' };
    if (k === 'COMP' && smp.compVoid) return { required: true, ok: false, verdict: 'VOIDED' };
    var act = Object.keys(d.seals).filter(function (c) { return d.seals[c].qr === qr && d.seals[c].status !== 'VOIDED'; });
    if (!act.length) { ev(d, 'SEAL_EXCEPTION', qr, 'TAMPERED: sample needs seals but none is linked'); save(d); return { required: true, ok: false, verdict: 'NOT_LINKED' }; }
    var s = null; act.forEach(function (c) { if (d.seals[c].kind === k) s = d.seals[c]; });
    if (!s) return { required: true, ok: false, verdict: 'SEAL_NOT_SCANNED' };
    if (!fresh(s)) { ev(d, 'SEAL_EXCEPTION', qr, 'TAMPERED: seal cleared too long ago'); save(d); return { required: true, ok: false, verdict: 'EXPIRED' }; }
    ev(d, 'SEAL_USED', qr, 'Seal used at ' + B.station); save(d); return { required: true, ok: true, verdict: 'OK' };
  };
  B.voidSample = function (qr, reason) { var d = load(), n = 0; Object.keys(d.seals).forEach(function (c) { var s = d.seals[c]; if (s.qr === norm(qr) && s.status !== 'VOIDED') { s.status = 'VOIDED'; n++; ev(d, 'SEAL_VOIDED', c, reason || 'QR cancelled'); } }); save(d); return n; };
  B.ageSeal = function (code, hours) { var d = load(), s = d.seals[norm(code)]; if (s) { s.clearedAt = Date.now() - hours * 3600 * 1000; save(d); } };
  B.stampWithoutSeals = function (qr) { var d = load(); d.samples[norm(qr)] = { required: true, bottom: false }; save(d); };
  window.SealLocal = B;
})();
