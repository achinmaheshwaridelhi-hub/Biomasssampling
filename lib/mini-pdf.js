/**
 * mini-pdf.js - a tiny PDF writer with AES-256 password protection (PDF 2.0, security handler revision 6), no other library needed.
 *
 *   const pdf = new MiniPdf();
 *   pdf.addPage(842, 595);                                   // A4 landscape, points
 *   pdf.rect(40, 40, 200, 30, { fill: '#1F2A5A' });         // coordinates: origin top-left, y grows downwards
 *   pdf.text('Hello', 50, 60, { size: 14, bold: true, color: '#FFFFFF' });
 *   pdf.image(canvas, 40, 100, 300, 150);                    // a canvas, drawn as JPEG
 *   const bytes = await pdf.build('open-password');          // Uint8Array; opens only with the password
 *
 * Text uses the standard Helvetica fonts (WinAnsi), widths are measured with the browser's Arial (identical metrics).
 * Only the PDF "content" is written (no metadata strings), so every encrypted object is a stream.
 */
(function (global) {
    'use strict';
    const enc = new TextEncoder();
    const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C,
        'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F,
        '−': 0x2D, '×': 0xD7, '→': 0x2D, '₹': 0x52 };
    function toWinAnsi(str) {                        // JS string -> string whose char codes are the WinAnsi bytes
        let o = '';
        for (const ch of String(str)) {
            const c = ch.codePointAt(0);
            if (WIN[ch] !== undefined) o += String.fromCharCode(WIN[ch]);
            else if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) o += String.fromCharCode(c);
            else o += '?';
        }
        return o;
    }
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const num = (n) => (Math.round(n * 100) / 100).toString();
    function rgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return '0 0 0';
        const v = parseInt(m[1], 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => num(x / 255)).join(' ');
    }
    let measureCtx = null;
    function measure(str, size, bold) {
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = (bold ? 'bold ' : '') + '100px Arial, Helvetica, sans-serif';
        return measureCtx.measureText(String(str)).width * size / 100;
    }
    const cat = (...parts) => { let n = 0; parts.forEach(p => n += p.length); const o = new Uint8Array(n); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; }); return o; };
    const latin = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; };
    const hex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
    const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

    // ------------------------------------------------------------------ AES-256 (ISO 32000-2, algorithm 2.A / 2.B)
    const subtle = crypto.subtle;
    async function aesCbc(keyBytes, iv, data, noPad) {             // returns the ciphertext; noPad: data length must be a multiple of 16
        const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
        const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, data));
        return noPad ? out.slice(0, data.length) : out;
    }
    async function sha(bits, data) { return new Uint8Array(await subtle.digest('SHA-' + bits, data)); }
    async function hash2B(pw, salt, udata) {                       // "hash" of algorithm 2.B (revision 6)
        let K = await sha(256, cat(pw, salt, udata));
        for (let i = 1; ; i++) {
            const one = cat(pw, K, udata);
            const K1 = new Uint8Array(one.length * 64);
            for (let r = 0; r < 64; r++) K1.set(one, r * one.length);
            const E = await aesCbc(K.slice(0, 16), K.slice(16, 32), K1, true);
            let s = 0; for (let b = 0; b < 16; b++) s += E[b];
            K = await sha([256, 384, 512][s % 3], E);
            if (i >= 64 && E[E.length - 1] <= i - 32) break;
        }
        return K.slice(0, 32);
    }
    async function makeEncryption(userPw, ownerPw) {
        const u8 = (p) => enc.encode(p).slice(0, 127);
        const up = u8(userPw), op = u8(ownerPw), empty = new Uint8Array(0);
        const fileKey = rnd(32), zero = new Uint8Array(16);
        const uvs = rnd(8), uks = rnd(8), ovs = rnd(8), oks = rnd(8);
        const U = cat(await hash2B(up, uvs, empty), uvs, uks);
        const UE = await aesCbc(await hash2B(up, uks, empty), zero, fileKey, true);
        const O = cat(await hash2B(op, ovs, U), ovs, oks);
        const OE = await aesCbc(await hash2B(op, oks, U), zero, fileKey, true);
        const P = (0xFFFFF000 | 0xAD4) | 0;                           // print, copy, accessibility, high-quality print; no editing / annotating
        const perms = new Uint8Array(16);
        perms.set([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255, 255, 255, 255, 255, 0x54, 0x61, 0x64, 0x62], 0); perms.set(rnd(4), 12);
        const Perms = await aesCbc(fileKey, zero, perms, true);       // one block: CBC with a zero IV is ECB
        return { fileKey, dict: `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P} /EncryptMetadata true /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(O)}> /U <${hex(U)}> /OE <${hex(OE)}> /UE <${hex(UE)}> /Perms <${hex(Perms)}> >>` };
    }
    async function deflate(bytes) {
        if (typeof CompressionStream === 'undefined') return null;
        try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()); } catch (e) { return null; }
    }
    function dataUrlToBytes(u) { const b = atob(u.split(',')[1]), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }

    // ------------------------------------------------------------------ the document
    class MiniPdf {
        constructor() { this.pages = []; this.cur = null; this.images = []; }
        addPage(w, h) { this.cur = { w: w || 842, h: h || 595, ops: [], imgs: [] }; this.pages.push(this.cur); return this.cur; }
        get pageWidth() { return this.cur.w; }
        get pageHeight() { return this.cur.h; }
        textWidth(str, size, bold) { return measure(str, size || 10, !!bold); }
        rect(x, y, w, h, o) {
            o = o || {}; const p = this.cur, Y = p.h - y - h;
            if (o.fill) p.ops.push(`${rgb(o.fill)} rg`);
            if (o.stroke) p.ops.push(`${rgb(o.stroke)} RG ${num(o.lw || 0.5)} w`);
            p.ops.push(`${num(x)} ${num(Y)} ${num(w)} ${num(h)} re ${o.fill && o.stroke ? 'B' : (o.fill ? 'f' : (o.stroke ? 'S' : 'n'))}`);
        }
        line(x1, y1, x2, y2, o) {
            o = o || {}; const p = this.cur;
            p.ops.push(`${rgb(o.color || '#000000')} RG ${num(o.lw || 0.5)} w ${num(x1)} ${num(p.h - y1)} m ${num(x2)} ${num(p.h - y2)} l S`);
        }
        // y is the TOP of the text line (the baseline is placed at y + 0.8 * size)
        text(str, x, y, o) {
            o = o || {}; const size = o.size || 10, p = this.cur, s = toWinAnsi(str);
            if (s === '') return;
            let X = x;
            if (o.align === 'center' || o.align === 'right') { const w = measure(str, size, o.bold); X = o.align === 'center' ? x - w / 2 : x - w; }
            p.ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(o.color || '#000000')} rg ${num(X)} ${num(p.h - y - size * 0.8)} Td (${esc(s)}) Tj ET`);
        }
        // a canvas (or an <img>) as a JPEG picture; w x h in points
        image(source, x, y, w, h) {
            const c = source, p = this.cur;
            const du = c.toDataURL('image/jpeg', 0.93);
            const bytes = dataUrlToBytes(du);
            const idx = this.images.push({ bytes, w: c.width, h: c.height }) - 1, name = 'Im' + (idx + 1);
            p.imgs.push(name);
            p.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(p.h - y - h)} cm /${name} Do Q`);
        }
        async build(userPassword, ownerPassword) {
            const encryption = userPassword ? await makeEncryption(userPassword, ownerPassword || (userPassword + '#' + hex(rnd(8)))) : null;
            const chunks = [], offsets = [];
            let pos = 0;
            const push = (u8) => { chunks.push(u8); pos += u8.length; };
            push(latin('%PDF-2.0\n%\xE2\xE3\xCF\xD3\n'));
            const obj = async (n, body, streamBytes, filter) => {
                offsets[n] = pos;
                if (streamBytes) {
                    let data = streamBytes, dict = body;
                    const z = filter === 'DCT' ? null : await deflate(data);       // a JPEG is already compressed
                    if (z && z.length < data.length) { data = z; dict += ' /Filter /FlateDecode'; }
                    if (encryption) data = cat(...await (async () => { const iv = rnd(16); return [iv, await aesCbc(encryption.fileKey, iv, data, false)]; })());
                    push(latin(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`)); push(data); push(latin('\nendstream\nendobj\n'));
                } else push(latin(`${n} 0 obj\n${body}\nendobj\n`));
            };
            // object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, 5.. images, then (page, content) pairs, then encrypt
            let n = 5; const imgNums = this.images.map(() => n++);
            const pageNums = this.pages.map(() => { const a = n; n += 2; return a; });
            const encNum = encryption ? n++ : null;
            await obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
            await obj(2, `<< /Type /Pages /Kids [${pageNums.map(k => k + ' 0 R').join(' ')}] /Count ${this.pages.length} >>`);
            await obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
            await obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
            for (let i = 0; i < this.images.length; i++) {
                const im = this.images[i];
                await obj(imgNums[i], `/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, im.bytes, 'DCT');
            }
            for (let i = 0; i < this.pages.length; i++) {
                const p = this.pages[i], pn = pageNums[i], cn = pn + 1;
                const xo = p.imgs.length ? ` /XObject << ${[...new Set(p.imgs)].map(nm => `/${nm} ${imgNums[Number(nm.slice(2)) - 1]} 0 R`).join(' ')} >>` : '';
                await obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.w)} ${num(p.h)}] /Contents ${cn} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo} >> >>`);
                await obj(cn, '', latin(p.ops.join('\n')));
            }
            if (encryption) await obj(encNum, encryption.dict);
            const xrefPos = pos, total = n;
            let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
            for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
            push(latin(x));
            const id = hex(rnd(16));
            push(latin(`trailer\n<< /Size ${total} /Root 1 0 R${encryption ? ` /Encrypt ${encNum} 0 R` : ''} /ID [<${id}> <${id}>] >>\nstartxref\n${xrefPos}\n%%EOF\n`));
            return cat(...chunks);
        }
    }
    global.MiniPdf = MiniPdf;
})(window);
