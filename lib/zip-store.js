/* Minimal ZIP writer (no compression, "store" method) - used to hand the Admin the reader training set (photos + labels) as ONE file.
 * Photos are already compressed JPEGs, so storing them as they are costs nothing. No network, no external library.
 *
 *   ZipStore.build([{ name: 'photos/1.jpg', data: Uint8Array|ArrayBuffer|string }, ...], date?) -> Blob (application/zip)
 *   ZipStore.verify(blob) -> Promise<{ ok, count, error }>   re-reads the zip from the start and checks every entry's CRC-32
 *   ZipStore.crc32(Uint8Array) -> unsigned int
 */
(function () {
    'use strict';
    var TABLE = null;

    function table() {
        if (TABLE) return TABLE;
        TABLE = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            TABLE[n] = c >>> 0;
        }
        return TABLE;
    }

    function crc32(u8) {
        var t = table(), c = 0xFFFFFFFF;
        for (var i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function bytes(d) {
        if (typeof d === 'string') return new TextEncoder().encode(d);
        if (d instanceof Uint8Array) return d;
        return new Uint8Array(d);
    }

    function dosDateTime(d) {
        var y = Math.max(1980, d.getFullYear());
        return {
            time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
            date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
        };
    }

    function build(files, date) {
        var dt = dosDateTime(date || new Date()), parts = [], central = [], offset = 0;
        if (files.length > 65535) throw new Error('Too many files for one zip (' + files.length + ')');
        files.forEach(function (f) {
            var name = new TextEncoder().encode(String(f.name)), data = bytes(f.data), crc = crc32(data);
            if (data.length >= 0xFFFFFFFF) throw new Error('File too large for this zip writer: ' + f.name);
            var h = new DataView(new ArrayBuffer(30));
            h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
            h.setUint16(10, dt.time, true); h.setUint16(12, dt.date, true); h.setUint32(14, crc, true);
            h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
            parts.push(h.buffer, name, data);
            var c = new DataView(new ArrayBuffer(46));
            c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
            c.setUint16(12, dt.time, true); c.setUint16(14, dt.date, true); c.setUint32(16, crc, true);
            c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
            c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true);
            c.setUint32(42, offset, true);
            central.push(c.buffer, name);
            offset += 30 + name.length + data.length;
        });
        var cdSize = 0;
        central.forEach(function (p) { cdSize += p.byteLength !== undefined ? p.byteLength : p.length; });
        var e = new DataView(new ArrayBuffer(22));
        e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
        e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
        e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
        return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
    }

    function verify(blob) {
        return blob.arrayBuffer().then(function (buf) {
            var u8 = new Uint8Array(buf), v = new DataView(buf), i = u8.length - 22;
            while (i >= 0 && v.getUint32(i, true) !== 0x06054b50) i--;
            if (i < 0) return { ok: false, error: 'end of the zip not found' };
            var count = v.getUint16(i + 10, true), cd = v.getUint32(i + 16, true), p = cd, n;
            for (n = 0; n < count; n++) {
                if (v.getUint32(p, true) !== 0x02014b50) return { ok: false, error: 'entry ' + (n + 1) + ': directory damaged' };
                var crc = v.getUint32(p + 16, true), size = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
                if (v.getUint32(off, true) !== 0x04034b50) return { ok: false, error: 'entry ' + (n + 1) + ': header damaged' };
                var start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
                if (crc32(u8.subarray(start, start + size)) !== crc) return { ok: false, error: 'entry ' + (n + 1) + ' (' + new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)) + '): CRC mismatch' };
                p += 46 + nl + xl + cl;
            }
            return { ok: true, count: count };
        }).catch(function (e) { return { ok: false, error: e.message }; });
    }

    window.ZipStore = { build: build, verify: verify, crc32: crc32 };
})();
