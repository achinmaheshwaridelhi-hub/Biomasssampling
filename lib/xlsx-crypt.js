/**
 * xlsx-crypt.js - password-protects an .xlsx file the way Excel does it ("Encrypt with Password"):
 * Office "Agile" encryption (MS-OFFCRYPTO 2.3.4: AES-256-CBC, SHA-512, 100,000 password iterations, HMAC integrity) inside an
 * OLE compound file. Excel / LibreOffice ask for the password when the file is opened; without it the content cannot be read.
 *
 *     const locked = await XlsxCrypt.encrypt(xlsxBytes, 'password');     // Uint8Array, save it as .xlsx
 *
 * Needs only the browser's WebCrypto (no other library).
 */
(function (global) {
    'use strict';
    const subtle = (global.crypto || require('crypto').webcrypto).subtle;
    const getRandom = (n) => (global.crypto || require('crypto').webcrypto).getRandomValues(new Uint8Array(n));
    const SPIN = 100000, BLOCK = 4096;

    const cat = (...p) => { let n = 0; p.forEach(x => n += x.length); const o = new Uint8Array(n); let k = 0; p.forEach(x => { o.set(x, k); k += x.length; }); return o; };
    const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
    const utf16 = (s) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 255; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
    const sha512 = async (d) => new Uint8Array(await subtle.digest('SHA-512', d));
    // AES-CBC without padding (data length must be a multiple of 16): WebCrypto always appends one padding block, which is cut off again
    async function aes(key, iv, data) {
        const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
        return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv.slice(0, 16) }, k, data)).slice(0, data.length);
    }
    const padTo = (d, m) => { const n = Math.ceil(d.length / m) * m; if (n === d.length) return d; const o = new Uint8Array(n); o.set(d); return o; };
    const BK_VERIFIER_INPUT = [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79], BK_VERIFIER_VALUE = [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
        BK_KEY = [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6], BK_HMAC_KEY = [0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6], BK_HMAC_VALUE = [0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33];

    async function passwordHash(password, salt) {
        let h = await sha512(cat(salt, utf16(password)));
        for (let i = 0; i < SPIN; i++) h = await sha512(cat(u32(i), h));
        return h;
    }
    const derive = async (h, block) => (await sha512(cat(h, new Uint8Array(block)))).slice(0, 32);

    // ---------------------------------------------------------------- OLE compound file (version 3, 512-byte sectors)
    function cfbName(s) { return s; }
    function cmpName(a, b) { if (a.length !== b.length) return a.length - b.length; const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : (x > y ? 1 : 0); }
    function buildCfb(root) {
        // root = { children: [ node ] }; node = { name, stream: Uint8Array } or { name, children: [node] }
        const entries = [{ name: 'Root Entry', type: 5, node: root }];
        const NOSTREAM = 0xFFFFFFFF;
        function link(parent) {                       // sort the children of a storage and make a balanced tree of them
            const kids = (parent.node.children || []).slice().sort((a, b) => cmpName(a.name, b.name));
            const ids = kids.map(k => { entries.push({ name: k.name, type: k.children ? 1 : 2, node: k, data: k.stream }); return entries.length - 1; });
            const build = (lo, hi) => { if (lo > hi) return NOSTREAM; const mid = (lo + hi) >> 1; const e = entries[ids[mid]]; e.left = build(lo, mid - 1); e.right = build(mid + 1, hi); return ids[mid]; };
            parent.child = build(0, ids.length - 1);
            ids.forEach(id => { if (entries[id].type === 1) link(entries[id]); });
        }
        link(entries[0]);
        // streams: < 4096 bytes live in the mini stream (64-byte sectors), the others in normal sectors
        const miniParts = []; let miniLen = 0; const miniFat = [];
        entries.forEach(e => {
            if (e.type !== 2) return;
            e.size = e.data.length;
            if (e.size < 4096) {
                const n = Math.max(1, Math.ceil(e.size / 64)); e.mini = true; e.start = miniLen / 64;
                miniParts.push(padTo(e.data, 64).length === n * 64 ? padTo(e.data, 64) : padTo(cat(e.data, new Uint8Array(n * 64 - e.data.length)), 64));
                for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? 0xFFFFFFFE : (miniLen / 64) + i + 1);
                miniLen += n * 64;
            }
        });
        const mini = cat(...miniParts, new Uint8Array(0));
        const secs = [];                              // data sectors in order; fat[] is filled in the same order
        const fat = [];
        const addChain = (bytes) => {
            const n = Math.max(1, Math.ceil(bytes.length / 512)), start = fat.length;
            const padded = padTo(bytes, 512);
            for (let i = 0; i < n; i++) { fat.push(i === n - 1 ? 0xFFFFFFFE : start + i + 1); secs.push(padded.slice(i * 512, (i + 1) * 512).length === 512 ? padded.slice(i * 512, (i + 1) * 512) : cat(padded.slice(i * 512), new Uint8Array(512))); }
            return start;
        };
        entries.forEach(e => { if (e.type === 2 && !e.mini) e.start = addChain(e.data); });
        const miniStart = mini.length ? addChain(mini) : 0xFFFFFFFE;
        let miniFatStart = 0xFFFFFFFE, miniFatSecs = 0;
        if (miniFat.length) { const mf = new Uint8Array(miniFat.length * 4); miniFat.forEach((v, i) => mf.set(u32(v), i * 4)); const m = new Uint8Array(Math.ceil(mf.length / 512) * 512).fill(0xFF); m.set(mf); miniFatStart = addChain(m); miniFatSecs = m.length / 512; }
        entries[0].start = miniStart; entries[0].size = mini.length;
        // directory
        const dirBytes = new Uint8Array(Math.ceil(entries.length / 4) * 512);
        const dv = new DataView(dirBytes.buffer);
        for (let i = 0; i < dirBytes.length / 128; i++) { const o = i * 128; dv.setUint32(o + 68, NOSTREAM, true); dv.setUint32(o + 72, NOSTREAM, true); dv.setUint32(o + 76, NOSTREAM, true); }
        entries.forEach((e, i) => {
            const o = i * 128, nm = e.name;
            for (let k = 0; k < nm.length; k++) dv.setUint16(o + 2 * k, nm.charCodeAt(k), true);
            dv.setUint16(o + 64, (nm.length + 1) * 2, true);
            dirBytes[o + 66] = e.type; dirBytes[o + 67] = 1;
            dv.setUint32(o + 68, e.left === undefined ? NOSTREAM : e.left, true);
            dv.setUint32(o + 72, e.right === undefined ? NOSTREAM : e.right, true);
            dv.setUint32(o + 76, e.child === undefined ? NOSTREAM : e.child, true);
            dv.setUint32(o + 116, e.start === undefined ? 0 : e.start, true);
            dv.setUint32(o + 120, e.size || 0, true);
        });
        const dirStart = addChain(dirBytes), dirSecs = dirBytes.length / 512;
        // the FAT itself
        let nFat = 1; while (Math.ceil((fat.length + nFat) / 128) > nFat) nFat++;
        if (nFat > 109) throw new Error('The file is too large to protect (more than about 7 MB).');
        const fatStart = fat.length;
        for (let i = 0; i < nFat; i++) fat.push(0xFFFFFFFD);
        const fatBytes = new Uint8Array(nFat * 512).fill(0xFF);
        fat.forEach((v, i) => fatBytes.set(u32(v), i * 4));
        const header = new Uint8Array(512), hv = new DataView(header.buffer);
        header.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
        hv.setUint16(24, 0x3E, true); hv.setUint16(26, 3, true); hv.setUint16(28, 0xFFFE, true); hv.setUint16(30, 9, true); hv.setUint16(32, 6, true);
        hv.setUint32(44, nFat, true); hv.setUint32(48, dirStart, true); hv.setUint32(56, 4096, true);
        hv.setUint32(60, miniFatStart, true); hv.setUint32(64, miniFatSecs, true); hv.setUint32(68, 0xFFFFFFFE, true); hv.setUint32(72, 0, true);
        for (let i = 0; i < 109; i++) hv.setUint32(76 + 4 * i, i < nFat ? fatStart + i : 0xFFFFFFFF, true);
        return cat(header, ...secs, fatBytes);
    }

    // DataSpaces: the fixed description that says "the package is protected by the strong encryption transform"
    const lp4 = (s) => { const d = utf16(s); return cat(u32(d.length), padTo(d, 4)); };
    function dataSpaces() {
        const version = cat(lp4('Microsoft.Container.DataSpaces'), u32(0x00010000 >>> 0).slice(0, 0), new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
        const entry = cat(u32(1), u32(0), lp4('EncryptedPackage'), lp4('StrongEncryptionDataSpace'));
        const map = cat(u32(8), u32(1), u32(entry.length + 4), entry);
        const space = cat(u32(8), u32(1), lp4('StrongEncryptionTransform'));
        const tid = lp4('{FF9A3F03-56EF-4613-BDD5-5A41C3D0E7B9}');
        const primary = cat(u32(4 + 4 + tid.length), u32(1), tid, lp4('Microsoft.Container.EncryptionTransform'), new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), u32(0), u32(0), u32(0), u32(4));
        return {
            name: '\u0006DataSpaces', children: [
                { name: 'Version', stream: version },
                { name: 'DataSpaceMap', stream: map },
                { name: 'DataSpaceInfo', children: [{ name: 'StrongEncryptionDataSpace', stream: space }] },
                { name: 'TransformInfo', children: [{ name: 'StrongEncryptionTransform', children: [{ name: '\u0006Primary', stream: primary }] }] }
            ]
        };
    }

    async function encrypt(xlsx, password) {
        if (!(xlsx instanceof Uint8Array)) xlsx = new Uint8Array(xlsx);
        if (!password) throw new Error('A password is required');
        const keySalt = getRandom(16), pwSalt = getRandom(16), verifierInput = getRandom(16), secret = getRandom(32), hmacKey = getRandom(64);
        // the package, in 4096-byte segments, each with its own IV
        const parts = [];
        for (let i = 0, n = 0; i < xlsx.length; i += BLOCK, n++) {
            const seg = padTo(xlsx.slice(i, i + BLOCK), 16);
            const iv = (await sha512(cat(keySalt, u32(n)))).slice(0, 16);
            parts.push(await aes(secret, iv, seg));
        }
        const size8 = new Uint8Array(8); new DataView(size8.buffer).setUint32(0, xlsx.length >>> 0, true); new DataView(size8.buffer).setUint32(4, Math.floor(xlsx.length / 4294967296), true);
        const encPackage = cat(size8, ...parts);
        // password -> key that protects the secret key
        const h = await passwordHash(password, pwSalt);
        const encVerifierInput = await aes(await derive(h, BK_VERIFIER_INPUT), pwSalt, verifierInput);
        const encVerifierValue = await aes(await derive(h, BK_VERIFIER_VALUE), pwSalt, padTo(await sha512(verifierInput), 16));
        const encKeyValue = await aes(await derive(h, BK_KEY), pwSalt, secret);
        // integrity: HMAC-SHA512 over the encrypted package
        const hk = await subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
        const hmac = new Uint8Array(await subtle.sign('HMAC', hk, encPackage));
        const encHmacKey = await aes(secret, (await sha512(cat(keySalt, new Uint8Array(BK_HMAC_KEY)))).slice(0, 16), hmacKey);
        const encHmacValue = await aes(secret, (await sha512(cat(keySalt, new Uint8Array(BK_HMAC_VALUE)))).slice(0, 16), hmac);
        const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
            '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
            '<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="' + b64(keySalt) + '"/>' +
            '<dataIntegrity encryptedHmacKey="' + b64(encHmacKey) + '" encryptedHmacValue="' + b64(encHmacValue) + '"/>' +
            '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
            '<p:encryptedKey spinCount="' + SPIN + '" saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="' + b64(pwSalt) +
            '" encryptedVerifierHashInput="' + b64(encVerifierInput) + '" encryptedVerifierHashValue="' + b64(encVerifierValue) + '" encryptedKeyValue="' + b64(encKeyValue) + '"/>' +
            '</keyEncryptor></keyEncryptors></encryption>';
        const info = cat(new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]), new TextEncoder().encode(xml));
        return buildCfb({ children: [dataSpaces(), { name: 'EncryptionInfo', stream: info }, { name: 'EncryptedPackage', stream: encPackage }] });
    }
    global.XlsxCrypt = { encrypt };
})(typeof window !== 'undefined' ? window : globalThis);
