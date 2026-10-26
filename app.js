/**
 * Biomass Sampling - Main Application Controller (app.js)
 * Coordinates user interaction, webcam frames, barcode scanning, print rendering, and reporting.
 */
document.addEventListener('DOMContentLoaded', function() {
    // Current application state
    let activeCameraStream = null;
    let capturedPhotoBase64 = '';

    // HTML-escape any value that came from the database or a user before it is placed in innerHTML.
    function esc(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
    }

    // "2026-10-19" -> "19-10-2026" (the date printed on every sample label)
    function dmy(d) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
        return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || '');
    }

    // ================= UNIFIED, ISOLATED PDF/PRINT ENGINE =================
    // Every "Print" / "Export PDF" button in the app builds its document HTML, then calls this.
    // It shows the document ON-SCREEN in its own overlay (an iframe with a self-contained
    // stylesheet, so it can never inherit the dark app theme), with the app's OWN "Print" and
    // "Close" buttons. The system print dialog is only ever opened when the operator explicitly
    // clicks "Print" here — never automatically — because on some locked-down/kiosk browsers the
    // native print dialog has no visible Cancel, which previously left the operator stuck with no
    // way back. Our own "✕ Close" button always exists and always works, regardless of what the
    // browser's own print UI looks like on a given device.
    // `title` also becomes the suggested filename when the user chooses "Save as PDF".
    function printDocumentInFrame({ title, bodyHtml, css }) {
        return new Promise((resolve) => {
            const oldTitle = document.title;

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed !important; inset:0 !important; z-index:999999 !important; ' +
                'background:rgba(10,12,16,0.88) !important; display:flex !important; flex-direction:column !important; ' +
                'align-items:center !important; padding:14px !important; overflow:auto !important;';

            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'width:100% !important; max-width:850px !important; display:flex !important; ' +
                'align-items:center !important; justify-content:space-between !important; gap:10px !important; ' +
                'margin-bottom:12px !important; flex-shrink:0 !important;';
            toolbar.innerHTML =
                '<div style="color:#fff !important; font-weight:700 !important; font-size:14px !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important;">' + esc(title || 'Print Preview') + '</div>' +
                '<div style="display:flex !important; gap:8px !important; flex-shrink:0 !important;">' +
                    '<button type="button" id="print-preview-print-btn" style="background:#10b981 !important; color:#fff !important; border:none !important; border-radius:6px !important; padding:10px 18px !important; font-weight:700 !important; font-size:14px !important; cursor:pointer !important;">🖨️ Print / Save PDF</button>' +
                    '<button type="button" id="print-preview-close-btn" style="background:#dc2626 !important; color:#fff !important; border:none !important; border-radius:6px !important; padding:10px 18px !important; font-weight:700 !important; font-size:14px !important; cursor:pointer !important;">✕ Close</button>' +
                '</div>';

            // IMPORTANT: give the iframe a REAL page-sized layout box (Letter @ 96dpi). A 0x0 iframe
            // lays out its content in a near-zero viewport before print/@page rules apply, which is
            // what previously produced the faint, oddly-scaled, sometimes-blank output. !important on
            // width/height/max-width is not decoration: the app's own responsive CSS has a global
            // `iframe { max-width: 100%; height: auto; }` rule (for embedded content) which was silently
            // clamping this print iframe's WIDTH TO 0 (max-width:100% resolved against an unrelated
            // containing block when the iframe was parked off-screen). A 0-width print surface is
            // exactly what produced the faint, barely-there text and "blank" PDFs - every line was
            // wrapping after zero characters. Now that the iframe is shown ON-SCREEN inside a normal
            // flex layout instead of parked off-canvas, that clamp no longer has anywhere to bite either.
            const frame = document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'false');
            frame.style.cssText = 'background:#fff !important; width:816px !important; max-width:100% !important; ' +
                'height:1056px !important; max-height:none !important; flex-shrink:0 !important; ' +
                'border:0 !important; border-radius:6px !important; box-shadow:0 8px 30px rgba(0,0,0,0.5) !important;';

            overlay.appendChild(toolbar);
            overlay.appendChild(frame);
            document.body.appendChild(overlay);

            let finished = false;
            const cleanup = () => {
                if (finished) return;
                finished = true;
                document.title = oldTitle;
                document.removeEventListener('keydown', escHandler);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve();
            };
            const escHandler = (e) => { if (e.key === 'Escape') cleanup(); };
            document.addEventListener('keydown', escHandler);

            toolbar.querySelector('#print-preview-close-btn').onclick = cleanup;
            // Clicking the dark backdrop itself (not the toolbar or the page) also closes it.
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

            try {
                const doc = frame.contentWindow.document;
                doc.open();
                doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${esc(location.href)}"><title>${esc(title || 'Document')}</title>
                    <style>
                        * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                        html, body { margin: 0; padding: 0; background: #fff; width: 100%; }
                        body {
                            padding: 0.3in; color: #000 !important; font-size: 10.5pt;
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        }
                        /* Force every element to plain solid black text by default. The app's own dark theme
                           (and any class name copied from a live on-screen component) uses light/gradient
                           text meant for a dark background - if any of that leaks into the printed document,
                           this stops it being unreadable on the white printed page. This is deliberately NOT
                           !important: callers intentionally set their own inline/class colours for status
                           text (red "REJECTED", green "ACCEPTED", white text on a solid badge fill) and those
                           must still win over this default. Headings are the one exception forced with
                           !important below, since they are the elements that were actually found rendering
                           invisible-on-white in the field. */
                        * { color: #000; -webkit-text-fill-color: #000; text-shadow: none; }
                        h1, h2, h3, h4 { color: #000 !important; -webkit-text-fill-color: #000 !important; font-weight: 700; }
                        table { border-collapse: collapse; width: 100%; }
                        @page { margin: 10mm; }
                        ${css || ''}
                    </style>
                </head><body>${bodyHtml}</body></html>`);
                doc.close();
            } catch (e) {
                console.error('Print document build failed:', e);
                cleanup();
                return;
            }

            const win = frame.contentWindow;
            toolbar.querySelector('#print-preview-print-btn').onclick = () => {
                document.title = title || oldTitle;   // Chrome's "Save as PDF" default filename follows the TOP document's title
                try {
                    win.focus();
                    win.print();
                } catch (e) {
                    console.error('Print failed:', e);
                    alert('Could not open the print dialog: ' + e.message);
                }
            };
        });
    }

    // "AGRO FRESH FIELDS" -> "AFF". Used to keep exported filenames short and readable.
    function shortCode(name) {
        const words = String(name || '').trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
        if (words.length === 0) return 'NA';
        if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'NA';
        return words.map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    }
    // "2026-09-23" -> "20260923"; falls back to today if the value isn't a plain date.
    function compactDate(dateStr) {
        const s = String(dateStr || '');
        return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).replace(/-/g, '') : window.BiomassAPI.todayIST().replace(/-/g, '');
    }

    // ================= CONFIG & SECURITY KEYS =================
    // NOTE: Because this is a purely client-side web application, a technically sophisticated 
    // user can extract this symmetric key from the JavaScript source. This encryption scheme 
    // is designed to prevent casual scanning of QR codes by generic apps (like Google Lens or 
    // built-in phone scanners) to protect the double-blind integrity of the testing workflow, 
    // but is NOT a substitute for absolute server-side security.
    const CONFIG = {
        QR_SECRET_KEY: 'b3f88c3a9d024e6a8f8d2c4b8e9a1d3f5c7b9e0f1a2b3c4d5e6f7a8b9c0d1e2f'
    };

    // --- Web Crypto AES-GCM Encrypted QR Helpers ---
    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    function bytesToBase64Url(bytes) {
        let binString = '';
        for (let i = 0; i < bytes.length; i++) {
            binString += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binString);
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64UrlToBytes(b64url) {
        let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) {
            b64 += '=';
        }
        const binString = atob(b64);
        const bytes = new Uint8Array(binString.length);
        for (let i = 0; i < binString.length; i++) {
            bytes[i] = binString.charCodeAt(i);
        }
        return bytes;
    }

    // Fallback simple obfuscation for non-secure contexts (e.g. file:/// protocol)
    function fallbackEncrypt(text) {
        const key = CONFIG.QR_SECRET_KEY || 'BIOMASS_KEY';
        let result = '';
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            result += String.fromCharCode(charCode);
        }
        return 'BSW1F:' + btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fallbackDecrypt(token) {
        if (!token.startsWith('BSW1F:')) {
            throw new Error('Invalid fallback token format');
        }
        const base64Part = token.substring(6);
        let b64 = base64Part.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const text = atob(b64);
        const key = CONFIG.QR_SECRET_KEY || 'BIOMASS_KEY';
        let result = '';
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            result += String.fromCharCode(charCode);
        }
        return { id: result, issuedAt: Date.now(), isFallback: true };
    }

    async function getCryptoKey() {
        const keyBytes = hexToBytes(CONFIG.QR_SECRET_KEY);
        return await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // Encrypts an ID to an opaque string prefixed with BSW2:. This is deliberately SHORT: the printed QR gets fewer, bigger
    // squares (about 33x33 instead of 57x57), which is what lets a phone read it reliably from a small paper label.
    // (Older labels printed with the longer BSW1: format are still accepted - see decryptPayload.)
    async function encryptPayload(plainId, issuedAtOverride = null) {
        if (!window.crypto || !window.crypto.subtle) {
            return fallbackEncrypt(plainId);
        }
        try {
            const key = await getCryptoKey();
            const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit standard IV
            const encodedText = new TextEncoder().encode(String(plainId));
            
            const ciphertextBuffer = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                encodedText
            );
            
            const ciphertextBytes = new Uint8Array(ciphertextBuffer);
            const combined = new Uint8Array(iv.length + ciphertextBytes.length);
            combined.set(iv, 0);
            combined.set(ciphertextBytes, iv.length);
            
            return 'BSW2:' + bytesToBase64Url(combined);
        } catch (e) {
            console.error('Encryption failed:', e);
            throw new Error('Failed to encrypt QR payload');
        }
    }

    // Decrypts an opaque string. Returns { id, issuedAt }
    async function decryptPayload(token) {
        // Fallback for fallback-encrypted codes
        if (token.startsWith('BSW1F:')) {
            try {
                return fallbackDecrypt(token);
            } catch (e) {
                throw new Error('Invalid or corrupt fallback sample QR');
            }
        }
        
        // Compact labels (BSW2:): AES-GCM of the plain ID only
        if (token.startsWith('BSW2:')) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Encrypted QR codes cannot be verified in non-secure offline browser tabs. Please use a secure connection (HTTPS or localhost).');
            }
            try {
                const combined = base64UrlToBytes(token.substring(5));
                if (combined.length < 13) throw new Error('Payload too short or corrupt');
                const key = await getCryptoKey();
                const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12) }, key, combined.slice(12));
                return { id: new TextDecoder().decode(decryptedBuffer), issuedAt: Date.now() };
            } catch (e) {
                console.error('Decryption failed:', e);
                throw new Error('Invalid or tampered sample QR');
            }
        }

        // Fallback for old CODE128 plain-text stock: if not prefixed with BSW1:, return plain ID directly
        if (!token.startsWith('BSW1:')) {
            // Check if it matches a legacy pattern (S1- or CMP-)
            if (token.startsWith('S1-') || token.startsWith('CMP-')) {
                console.log('Legacy plaintext code scanned:', token);
                return { id: token, issuedAt: Date.now(), isLegacy: true };
            }
            throw new Error('Not a valid sample QR code');
        }
        
        if (!window.crypto || !window.crypto.subtle) {
            throw new Error('Standard encrypted QR codes cannot be verified in non-secure offline browser tabs. Please use a secure connection (HTTPS or localhost) or scan local offline barcodes.');
        }
        
        try {
            const base64Part = token.substring(5);
            const combined = base64UrlToBytes(base64Part);
            
            if (combined.length < 13) {
                throw new Error('Payload too short or corrupt');
            }
            
            const iv = combined.slice(0, 12);
            const ciphertextBytes = combined.slice(12);
            
            const key = await getCryptoKey();
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ciphertextBytes
            );
            
            const plainText = new TextDecoder().decode(decryptedBuffer);
            return JSON.parse(plainText);
        } catch (e) {
            console.error('Decryption failed:', e);
            throw new Error('Invalid or tampered sample QR');
        }
    }

    function updateConnectionBanner() {
        const banner = document.getElementById('connection-mode-banner');
        if (!banner) return;
        
        if (window.BiomassAPI.isRemoteMode()) {
            banner.textContent = 'SECURE CLOUD MODE — SUPABASE';
            banner.className = 'connection-banner online';
        } else {
            banner.textContent = 'OFFLINE LOCALSTORAGE MODE';
            banner.className = 'connection-banner offline';
        }
    }

    updateConnectionBanner();

    // Downsamples camera/upload photos to max 1200px JPEG (~150KB) to prevent HTTP 413 Payload Too Large crashes
    function compressScaleImage(dataUrl, maxDim = 1200, quality = 0.75) {
        return new Promise((resolve) => {
            if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
                resolve(dataUrl);
                return;
            }
            const img = new Image();
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) {
                        h = Math.round((h * maxDim) / w);
                        w = maxDim;
                    } else {
                        w = Math.round((w * maxDim) / h);
                        h = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const compressed = canvas.toDataURL('image/jpeg', quality);
                resolve(compressed);
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }
    window.compressScaleImage = compressScaleImage;

    // Dom elements cache
    const appHeader = document.getElementById('app-header');
    const displayUserName = document.getElementById('display-user-name');
    const displayUserRole = document.getElementById('display-user-role');
    const btnLogout = document.getElementById('btn-logout-action');
    
    // Screens
    const screens = {
        login: document.getElementById('screen-login'),
        admin: document.getElementById('screen-admin'),
        lab1: document.getElementById('screen-lab1'),
        lab2: document.getElementById('screen-lab2'),
        unloading: document.getElementById('screen-unloading')
    };

    // Helper: download QR Code Canvas as PNG with text headers and plain ID below.
    // `identifiable`: composite lot labels (Test/Referee/Vendor) aren't supplier-identifying,
    // so pass true to keep the readable filename instead of the anonymized token used for
    // Sample-1 intake barcodes (which must never leak a serial that maps back to a supplier).
    function downloadQrAsPng(canvasSelector, filename, headerText, plainId, identifiable, vendorName) {
        const canvasElement = document.querySelector(canvasSelector);
        if (!canvasElement) {
            alert('QR sticker element not found.');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            // the COMPLETE vendor name (Vendor / Referee copies) is word-wrapped into as many lines as it needs
            const vLines = [];
            if (vendorName) {
                const probe = document.createElement('canvas').getContext('2d');
                probe.font = 'bold 20pt sans-serif';
                let cur = '';
                String(vendorName).split(/\s+/).forEach(w => {
                    const t = cur ? cur + ' ' + w : w;
                    if (probe.measureText(t).width > 560 && cur) { vLines.push(cur); cur = w; } else cur = t;
                });
                if (cur) vLines.push(cur);
            }
            canvas.height = 720 + vLines.length * 36;
            
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            let currentY = 40;
            
            // 1. Draw Header Text cleanly wrapped to 2 lines if needed
            if (headerText) {
                context.fillStyle = '#000000';
                context.textAlign = 'center';
                
                let line1 = headerText;
                let line2 = '';
                
                if (headerText.includes('|')) {
                    const parts = headerText.split('|');
                    line1 = parts[0].trim();
                    line2 = parts[1].trim();
                } else if (headerText.includes('—')) {
                    const parts = headerText.split('—');
                    line1 = parts[0].trim();
                    line2 = parts[1].trim();
                } else if (headerText.length > 20) {
                    const spaceIdx = headerText.indexOf(' ', 15);
                    if (spaceIdx > -1) {
                        line1 = headerText.substring(0, spaceIdx).trim();
                        line2 = headerText.substring(spaceIdx).trim();
                    }
                }

                context.font = 'bold 22pt sans-serif';
                context.fillText(line1, canvas.width / 2, currentY);
                currentY += 36;

                if (line2) {
                    context.font = 'bold 18pt sans-serif';
                    context.fillText(line2, canvas.width / 2, currentY);
                    currentY += 34;
                }
            } else {
                currentY = 30;
            }
            if (vLines.length) {
                context.fillStyle = '#000000'; context.textAlign = 'center'; context.font = 'bold 20pt sans-serif';
                vLines.forEach(l => { context.fillText(l, canvas.width / 2, currentY); currentY += 36; });
            }
            
            // 2. Draw QR code image MUCH BIGGER (480x480) with clean white quiet zone
            // Enlarge by a WHOLE number and without smoothing, so every square stays razor sharp (a blurry
            // or unevenly stretched code is what a phone camera struggles to read).
            const srcSize = canvasElement.width;
            let factor = Math.max(1, Math.round(480 / srcSize));
            while (srcSize * factor > 560 && factor > 1) factor--;
            const qrSize = srcSize * factor;
            const qrX = Math.round((canvas.width - qrSize) / 2);
            context.imageSmoothingEnabled = false;
            context.drawImage(canvasElement, qrX, currentY + 10, qrSize, qrSize);
            
            const png = canvas.toDataURL('image/png');
            const downloadLink = document.createElement('a');
            downloadLink.href = png;
            if (identifiable) {
                const safeName = String(filename || 'Composite').replace(/[^a-zA-Z0-9_-]/g, '_');
                downloadLink.download = `${safeName}.png`;
            } else {
                // Privacy: never expose the sample/QR serial in the saved file name.
                // Use an opaque random token instead.
                const randomToken = Math.random().toString(36).substring(2, 10).toUpperCase() + Date.now().toString(36).slice(-4).toUpperCase();
                downloadLink.download = `QR_${randomToken}.png`;
            }

            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
        } catch (e) {
            console.error('Failed to convert QR canvas:', e);
            alert('Sticker image download failed: ' + e.message);
        }
    }

    // Shared display formatters for Referee Challenge data, used by every report/export
    // (Compiled Reports, Executive Dashboard filtered report, Excel export).
    function formatVendorGcvDisplay(row) {
        return (row.vendor_gcv !== null && row.vendor_gcv !== undefined)
            ? `${row.vendor_gcv} kcal/kg`
            : 'Report Awaited';
    }
    function formatRefereeGcvDisplay(row) {
        if (row.referee_gcv !== null && row.referee_gcv !== undefined) return `${row.referee_gcv} kcal/kg`;
        if (row.referee_status === 'CHALLENGED') return 'Report Awaited';
        return 'Not Challenged Yet';
    }

    // Set pdf.js worker URL for PDF parsing in browser
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    }

    // ================= ROBUST QR / BARCODE DECODING OF A PHOTO =================
    // A phone camera photo is 12+ megapixels. The decoder only locks on when each QR square is a few pixels wide, so a dense
    // printed code in a huge photo (every square a big soft blob) - or in a tiny crop - is missed even though a person can see
    // it plainly. So the photo is tried as it is, then at several sizes, then with stretched contrast, until one decodes.
    // Every scanner in the app (labs, unloading, admin) goes through this one function.
    async function decodeQrImage(file, readerId) {
        let bitmap = null;
        try { bitmap = await createImageBitmap(file); } catch (e) { /* older browsers: use an <img> below */ }
        if (!bitmap) {
            bitmap = await new Promise(function(resolve, reject) {
                const url = URL.createObjectURL(file), img = new Image();
                img.onload = function() { resolve(img); };
                img.onerror = function() { reject(new Error('Could not open the photo.')); };
                img.src = url;
            });
        }
        const W = bitmap.width || bitmap.naturalWidth, H = bitmap.height || bitmap.naturalHeight;
        const longest = Math.max(W, H);

        // 1. Phones with the built-in barcode detector (Android Chrome) use it first: fast and very tolerant.
        if (typeof window.BarcodeDetector !== 'undefined') {
            try {
                const det = new window.BarcodeDetector({ formats: ['qr_code'] });
                const found = await det.detect(bitmap);
                if (found && found.length && found[0].rawValue) return found[0].rawValue;
            } catch (e) { /* fall through to the software decoder */ }
        }

        const tryBlob = async function(blob) {
            // html5-qrcode only accepts a real File object (a plain Blob is refused), so wrap it
            const asFile = (blob instanceof File) ? blob : new File([blob], 'qr.png', { type: blob.type || 'image/png' });
            try { return await new Html5Qrcode(readerId).scanFile(asFile, false); } catch (e) { return null; }
        };

        // 2. The photo exactly as taken
        let text = await tryBlob(file);
        if (text) return text;

        // 3. Resized (and, for small photos, enlarged a little), plain first and then with stretched contrast
        const sizes = [1280, 960, 1600, 720, 1100, 2000, 540].filter(function(sz) { return sz < longest || sz <= longest * 2.2; });
        for (const filter of ['none', 'grayscale(1) contrast(1.8)']) {
            for (const sz of sizes) {
                const k = sz / longest, w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const x = c.getContext('2d');
                x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
                x.filter = filter;
                x.drawImage(bitmap, 0, 0, w, h);
                const blob = await new Promise(function(r) { c.toBlob(r, 'image/png'); });
                if (!blob) continue;
                text = await tryBlob(blob);
                if (text) return text;
            }
        }
        throw new Error('No QR code could be read in this photo.');
    }

    // Helper: decode barcode from image file or PDF document
    async function scanUploadedFile(file, qrReaderId, successCallback, errorCallback) {
        if (!file) return;
        
        try {
            if (file.type === "application/pdf" || file.name.toLowerCase().endsWith('.pdf')) {
                if (typeof pdfjsLib === 'undefined') {
                    alert('PDF reader library is loading. Please try again in a few seconds.');
                    return;
                }
                const fileReader = new FileReader();
                fileReader.onload = async function() {
                    try {
                        const typedarray = new Uint8Array(this.result);
                        const pdf = await pdfjsLib.getDocument({ data: typedarray, isEvalSupported: false }).promise;
                        const page = await pdf.getPage(1);
                        
                        const canvas = document.createElement('canvas');
                        const viewport = page.getViewport({ scale: 2.5 }); // Sharp scale for barcode decoding
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        
                        const context = canvas.getContext('2d');
                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        canvas.toBlob(async (blob) => {
                            const tempFile = new File([blob], "scanned-page.png", { type: "image/png" });
                            try {
                                const decodedText = await decodeQrImage(tempFile, qrReaderId);
                                successCallback(decodedText);
                            } catch (err) {
                                errorCallback('Could not decode barcode from PDF page. Make sure the barcode is clear and not cropped.');
                            }
                        }, "image/png");
                    } catch (err) {
                        errorCallback('Failed to read PDF document: ' + err.message);
                    }
                };
                fileReader.readAsArrayBuffer(file);
            } else {
                // Standard image file parsing with multi-engine fallback
                try {
                    // Pass 1: the multi-size decoder (also tries the built-in detector where the browser has one)
                    const directText = await decodeQrImage(file, qrReaderId);
                    console.log('Successfully scanned using Html5Qrcode scaled scan');
                    successCallback(directText);
                    return;
                } catch (e1) {
                    console.log('Pass 1 direct scaled scan failed, trying image element engines...');
                }

                const fileReader = new FileReader();
                fileReader.onload = function(event) {
                    const img = new Image();
                    img.onload = async function() {
                        // Pass 2: Try Native BarcodeDetector on raw img element
                        if (typeof window.BarcodeDetector !== 'undefined') {
                            try {
                                const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] });
                                const detectedCodes = await detector.detect(img);
                                if (detectedCodes && detectedCodes.length > 0) {
                                    console.log('Successfully scanned using Native BarcodeDetector:', detectedCodes[0].rawValue);
                                    successCallback(detectedCodes[0].rawValue);
                                    return;
                                }
                            } catch (detectorErr) {
                                console.warn('Native BarcodeDetector check failed:', detectorErr);
                            }
                        }

                        // Pass 3: Try Html5Qrcode scanFile without scaling
                        try {
                            const rawReader2 = new Html5Qrcode(qrReaderId);
                            const rawText = await rawReader2.scanFile(file, false);
                            console.log('Successfully scanned using Html5Qrcode raw scan');
                            successCallback(rawText);
                            return;
                        } catch (e3) {}

                        // Pass 4: Header-cropped canvas scan (crops out top text header margin)
                        try {
                            const cropY = Math.round(img.height * 0.15); // skip top 15% header text
                            const cropH = img.height - cropY;
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = cropH;

                            const ctx = canvas.getContext('2d');
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, cropY, img.width, cropH, 0, 0, canvas.width, cropH);

                            // Try Native BarcodeDetector on cropped canvas first
                            if (typeof window.BarcodeDetector !== 'undefined') {
                                try {
                                    const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] });
                                    const detected = await detector.detect(canvas);
                                    if (detected && detected.length > 0) {
                                        console.log('Successfully scanned cropped canvas via BarcodeDetector:', detected[0].rawValue);
                                        successCallback(detected[0].rawValue);
                                        return;
                                    }
                                } catch(e) {}
                            }

                            canvas.toBlob(async (blob) => {
                                if (!blob) {
                                    errorCallback('Could not read QR code from this photo.');
                                    return;
                                }
                                const cropFile = new File([blob], "crop-scan.png", { type: "image/png" });
                                try {
                                    const cropReader = new Html5Qrcode(qrReaderId);
                                    const cropText = await cropReader.scanFile(cropFile, true);
                                    console.log('Successfully scanned using cropped canvas blob');
                                    successCallback(cropText);
                                } catch (cropErr) {
                                    // Pass 5: Square QR matrix crop around lower portion
                                    try {
                                        const sqCanvas = document.createElement('canvas');
                                        const sqDim = Math.min(img.width, img.height);
                                        sqCanvas.width = sqDim;
                                        sqCanvas.height = sqDim;
                                        const sqCtx = sqCanvas.getContext('2d');
                                        sqCtx.fillStyle = '#ffffff';
                                        sqCtx.fillRect(0, 0, sqDim, sqDim);
                                        const offsetX = (img.width - sqDim) / 2;
                                        const offsetY = Math.max(0, img.height - sqDim);
                                        sqCtx.drawImage(img, offsetX, offsetY, sqDim, sqDim, 0, 0, sqDim, sqDim);

                                        sqCanvas.toBlob(async (sqBlob) => {
                                            const sqFile = new File([sqBlob], "square-crop.png", { type: "image/png" });
                                            try {
                                                const sqReader = new Html5Qrcode(qrReaderId);
                                                const sqText = await sqReader.scanFile(sqFile, true);
                                                console.log('Successfully scanned using square crop canvas');
                                                successCallback(sqText);
                                            } catch(sqErr) {
                                                errorCallback('Could not read QR code or barcode from this photo. Please make sure the photo is well-lit and the code is not skewed or blurry.');
                                            }
                                        }, "image/png");
                                    } catch(e5) {
                                        errorCallback('Could not read QR code or barcode from this photo.');
                                    }
                                }
                            }, "image/png");
                        } catch (err4) {
                            errorCallback('Could not read QR code or barcode from this photo.');
                        }
                    };
                    img.src = event.target.result;
                };
                fileReader.readAsDataURL(file);
            }
        } catch (err) {
            errorCallback('Failed to decode uploaded file: ' + err.message);
        }
    }





    // ================= UN IFIED CAMERA QR / BARCODE SCANNER =================
    // Single implementation used by every station: rear camera, continuous
    // autofocus, torch toggle, large scan window and native BarcodeDetector
    // acceleration where the device supports it.
    const activeScanners = {};
    const scannerStoppers = {};

    function supportedScanFormats() {
        if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
        return [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.DATA_MATRIX
        ];
    }

    async function stopSharedScanner(key) {
        const stopper = scannerStoppers[key];
        if (stopper) {
            await stopper();
        }
    }

    async function stopAllSharedScanners() {
        for (const key of Object.keys(scannerStoppers)) {
            try { await scannerStoppers[key](); } catch (e) {}
        }
    }

    function setupSharedCameraScanner(cfg) {
        const trigger = document.getElementById(cfg.triggerId);
        const container = document.getElementById(cfg.containerId);
        const btnStop = document.getElementById(cfg.stopBtnId);
        const btnTorch = cfg.torchBtnId ? document.getElementById(cfg.torchBtnId) : null;
        if (!trigger || !container) return;

        // Create Capture & Scan Button dynamically
        let btnCapture = container.querySelector('.btn-capture-scan');
        if (!btnCapture) {
            btnCapture = document.createElement('button');
            btnCapture.type = 'button';
            btnCapture.className = 'btn btn-primary btn-sm btn-capture-scan';
            btnCapture.style.width = '100%';
            btnCapture.style.marginTop = '0.5rem';
            btnCapture.style.display = 'none';
            btnCapture.textContent = '📸 Capture & Scan Static Frame';
            if (btnStop) {
                container.insertBefore(btnCapture, btnStop);
            } else {
                container.appendChild(btnCapture);
            }
        }

        // Create Snap Photo / Upload Image Button and Input dynamically
        let btnUpload = trigger.parentNode.querySelector('.btn-upload-scan-' + cfg.key);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.setAttribute('capture', 'environment');
        fileInput.style.display = 'none';
        
        if (!btnUpload) {
            btnUpload = document.createElement('button');
            btnUpload.type = 'button';
            btnUpload.className = 'btn btn-secondary btn-sm btn-upload-scan-' + cfg.key;
            btnUpload.style.width = '100%';
            btnUpload.style.marginTop = '0.5rem';
            btnUpload.style.padding = '0.5rem';
            btnUpload.style.fontSize = '0.9rem';
            btnUpload.style.fontWeight = 'bold';
            btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
            
            // Insert it right after trigger
            trigger.parentNode.insertBefore(btnUpload, trigger.nextSibling);
            trigger.parentNode.insertBefore(fileInput, btnUpload);
        } else {
            const oldInput = trigger.parentNode.querySelector('input[type="file"][capture="environment"]');
            if (oldInput) {
                oldInput.parentNode.removeChild(oldInput);
            }
            trigger.parentNode.insertBefore(fileInput, btnUpload);
        }

        btnUpload.onclick = function() {
            fileInput.click();
        };

        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            try {
                btnUpload.textContent = '⏳ Processing Image...';
                const decodedText = await decodeQrImage(file, cfg.readerId);
                btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
                await cfg.onDecode(decodedText);
            } catch (err) {
                btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
                alert('Barcode scan failed: Could not detect barcode from the uploaded photo. Please make sure the QR code/barcode is clear, close-up, and well-lit, then try again.');
            }
            fileInput.value = '';
        };

        let torchOn = false;

        async function stopScanning() {
            const scanner = activeScanners[cfg.key];
            if (scanner) {
                try { await scanner.stop(); } catch (e) {}
                try { scanner.clear(); } catch (e) {}
                activeScanners[cfg.key] = null;
            }
            torchOn = false;
            if (btnTorch) btnTorch.textContent = 'Torch On / Off';
            if (btnCapture) btnCapture.style.display = 'none';
            container.style.display = 'none';
            trigger.style.display = 'flex';
        }
        scannerStoppers[cfg.key] = stopScanning;

        btnCapture.onclick = async function() {
            const scanner = activeScanners[cfg.key];
            if (!scanner) return;

            const video = container.querySelector('video');
            if (!video) {
                alert("Camera feed is not ready yet.");
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || video.clientWidth;
            canvas.height = video.videoHeight || video.clientHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            await stopScanning();

            canvas.toBlob(async function(blob) {
                if (!blob) {
                    alert("Failed to capture image frame.");
                    return;
                }
                try {
                    const decodedText = await decodeQrImage(blob, cfg.readerId);
                    await cfg.onDecode(decodedText);
                } catch (err) {
                    alert('Barcode scan failed: Could not detect barcode from the captured picture. Please make sure the barcode is in clear focus and try again.');
                }
            }, 'image/jpeg');
        };

        trigger.onclick = async function() {
            container.style.display = 'block';
            trigger.style.display = 'none';
            if (btnCapture) btnCapture.style.display = 'inline-block';

            let scanner;
            try {
                scanner = new Html5Qrcode(cfg.readerId, {
                    formatsToSupport: supportedScanFormats(),
                    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                    verbose: false
                });
            } catch (e) {
                scanner = new Html5Qrcode(cfg.readerId);
            }
            activeScanners[cfg.key] = scanner;

            // Common scanner options
            const scanOptions = {
                fps: 20,
                qrbox: function(viewfinderWidth, viewfinderHeight) {
                    const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.85);
                    return { width: edge, height: edge };
                },
                formatsToSupport: supportedScanFormats(),
                experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                disableFlip: false
            };

            const successCallback = async function(decodedText) {
                await stopScanning();
                try {
                    await cfg.onDecode(decodedText);
                } catch (e) {
                    alert(e.message || e);
                }
            };
            const errorCallback = function() { /* per-frame decode misses are expected */ };

            try {
                // Try rear/environment camera first
                await scanner.start({ facingMode: "environment" }, scanOptions, successCallback, errorCallback);
                
                // Continuous autofocus where hardware exposes it
                try {
                    await scanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] });
                } catch (e) {}

                // Torch availability
                if (btnTorch) {
                    let torchSupported = false;
                    try {
                        const caps = scanner.getRunningTrackCapabilities();
                        torchSupported = !!(caps && caps.torch);
                    } catch (e) {}
                    btnTorch.style.display = torchSupported ? 'inline-block' : 'none';
                }
            } catch (err) {
                console.warn('Failed starting with environment camera, retrying with default user camera...', err);
                try {
                    // Fallback to default user camera (e.g. laptop webcam)
                    await scanner.start({}, scanOptions, successCallback, errorCallback);
                } catch (retryErr) {
                    alert('Error opening camera scanner: ' + (retryErr.message || retryErr) + '\n\nPlease scan using a USB scanner or type the code manually.');
                    await stopScanning();
                }
            }
        };

        if (btnTorch) {
            btnTorch.onclick = async function() {
                const scanner = activeScanners[cfg.key];
                if (!scanner) return;
                try {
                    torchOn = !torchOn;
                    await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
                    btnTorch.textContent = torchOn ? 'Torch Off' : 'Torch On';
                } catch (e) {
                    torchOn = false;
                    alert('Torch is not available on this device camera.');
                }
            };
        }

        if (btnStop) {
            btnStop.onclick = stopScanning;
            btnStop.style.display = 'inline-block';
        }
    }

    // Single-shot "snap a photo, decode it" scanner — replaces the old live-video
    // trigger for every non-admin login. No manual typing, no gallery upload:
    // tapping the trigger opens the device camera, takes one photo, and decodes it.
    function setupSnapOnlyScanner(cfg) {
        const trigger = document.getElementById(cfg.triggerId);
        if (!trigger) return;

        // Html5Qrcode needs a container element to exist for its internal DOM work,
        // even though nothing is ever rendered into it here.
        let readerDiv = document.getElementById(cfg.readerId);
        if (!readerDiv) {
            readerDiv = document.createElement('div');
            readerDiv.id = cfg.readerId;
            readerDiv.style.display = 'none';
            document.body.appendChild(readerDiv);
        }

        // Reuse the input across repeat calls (e.g. re-entering a tab) instead of
        // stacking up orphaned hidden inputs each time this is set up again.
        let fileInput = trigger.nextElementSibling;
        if (!fileInput || fileInput.tagName !== 'INPUT' || fileInput.type !== 'file') {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.setAttribute('capture', 'environment');
            fileInput.style.display = 'none';
            trigger.parentNode.insertBefore(fileInput, trigger.nextSibling);
        }

        trigger.onclick = function() { fileInput.click(); };

        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            fileInput.value = '';
            if (!file) return;

            trigger.style.pointerEvents = 'none';
            trigger.style.opacity = '0.6';

            let decodedText;
            try {
                decodedText = await decodeQrImage(file, cfg.readerId);
            } catch (err) {
                trigger.style.pointerEvents = '';
                trigger.style.opacity = '';
                alert('Barcode scan failed: Could not detect a barcode in that photo. Please make sure it is clear, close-up, and well-lit, then try again.');
                return;
            }

            try {
                await cfg.onDecode(decodedText);
            } catch (err) {
                alert(err.message || err);
            } finally {
                trigger.style.pointerEvents = '';
                trigger.style.opacity = '';
            }
        };
    }

    function setupLab1CameraScanner() {
        setupSnapOnlyScanner({
            triggerId: 'lab1-scan-trigger',
            readerId: 'lab1-qr-reader',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                lookupLab1Barcode(plainId);
            }
        });
    }

    // ================= FINENESS LOGIN: MIXING SCAN (segregation for the composite) =================
    // The fineness technician scans each Sample-1 container being sorted for mixing. The answer is only the Mixing Code and
    // INCLUDE / EXCLUDE (no moisture value, no supplier). Scans are stored in the database; Lab 2 can generate the composite
    // only when every accepted container of a mixing code has been scanned here. A container cannot be scanned twice, and
    // only an Admin can reset a group's scans.
    const mixScan = { last: null };

    function fmtMixTime(t) { return esc(t || ''); }

    function initMixScanCard() {
        const card = document.getElementById('mixscan-card');
        if (!card) return;
        const u = window.BiomassAPI.getCurrentUser();
        const on = !!u && u.role === 'lab1f';
        card.style.display = on ? '' : 'none';
        const colB = document.getElementById('lab1-col-b'), layout = document.getElementById('lab1-layout');
        if (colB) colB.style.display = on ? 'flex' : 'none';
        if (layout) layout.classList.toggle('with-two', on);      // two features side by side, history underneath
        const mixTab = document.getElementById('lab1-tab-mix');
        if (mixTab) {
            mixTab.style.display = on ? '' : 'none';
            if (!on && mixTab.classList.contains('active')) showFtab('lab1-tabs', 'scan');
        }
        if (!on) return;

        const dateEl = document.getElementById('mixscan-date');
        const input = document.getElementById('mixscan-manual-input');
        dateEl.value = window.BiomassAPI.todayIST();
        const feedback = document.getElementById('mixscan-feedback');
        feedback.style.display = 'none';

        setupSnapOnlyScanner({
            triggerId: 'mixscan-trigger',
            readerId: 'mixscan-qr-reader',
            onDecode: async function(decodedText) { await handleMixScan(decodedText); }
        });
        const submitManual = () => { const v = input.value.trim(); if (v) { input.value = ''; handleMixScan(v); } };
        document.getElementById('btn-mixscan-manual').onclick = submitManual;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitManual(); } };
        dateEl.onchange = () => renderMixScanSummary();
        document.getElementById('btn-mixscan-refresh').onclick = () => renderMixScanSummary();
        document.getElementById('btn-mixscan-print').onclick = printMixScanSummary;
        renderMixScanSummary();
    }

    function showMixFeedback(kind, html) {
        const box = document.getElementById('mixscan-feedback');
        if (!box) return;
        const colors = {
            include: ['rgba(16,185,129,0.2)', '#10b981', '#bbf7d0'],
            exclude: ['rgba(239,68,68,0.2)', '#ef4444', '#fecaca'],
            dup:     ['rgba(245,158,11,0.2)', '#f59e0b', '#fde68a'],
            error:   ['rgba(239,68,68,0.2)', '#ef4444', '#fecaca']
        }[kind];
        box.style.display = 'block';
        box.style.background = colors[0];
        box.style.border = '2px solid ' + colors[1];
        box.style.color = colors[2];
        box.innerHTML = html;
    }

    async function handleMixScan(code) {
        if (!code) return;
        try {
            const plainId = await processScannedCode(code);
            const res = await window.BiomassAPI.mixingScan(plainId);
            if (!res || !res.success) {
                showMixFeedback('error', `<div style="font-weight:800;">⚠️ ${esc((res && res.message) || 'Scan could not be recorded')}</div>` +
                    (res && res.daily_group_code ? `<div>Mixing Code: <span class="scan-group-code-pill">${esc(res.daily_group_code)}</span></div>` : ''));
                return;
            }
            const pr = res.progress || {};
            const pill = `<span class="scan-group-code-pill" style="font-size:1.35rem;">${esc(res.daily_group_code)}</span>`;
            const prog = `<div style="margin-top:0.4rem; font-size:0.88rem;">Accepted containers of <strong>${esc(res.daily_group_code)}</strong> scanned: <strong>${esc(pr.accepted_scanned)} / ${esc(pr.accepted_total)}</strong>` +
                (pr.accepted_total > 0 && pr.accepted_scanned >= pr.accepted_total ? ' &mdash; <strong>all done, Lab 2 can now generate this composite ✅</strong>' : '') + '</div>';
            if (res.duplicate) {
                showMixFeedback('dup', `<div style="font-weight:800; font-size:1.1rem;">⚠️ ALREADY SCANNED at ${fmtMixTime(res.scanned_time)}</div>` +
                    `<div>${esc(res.sample1_barcode_id)} &rarr; Mixing Code ${pill} &mdash; <strong>${res.include ? 'INCLUDE' : 'EXCLUDE'}</strong>. This scan was not counted again.</div>${prog}`);
                alert(`⚠️ This container (${res.sample1_barcode_id}) was already scanned at ${res.scanned_time}.`);
            } else if (res.cancelled) {
                showMixFeedback('exclude', `<div style="font-weight:800; font-size:1.25rem;">🚫 QR CANCELLED &mdash; set this container aside</div>` +
                    `<div style="margin-top:0.25rem;">Mixing Code: ${pill}</div>` +
                    `<div style="font-size:0.85rem;">${esc(res.sample1_barcode_id)} &bull; <strong>Do NOT add it to the mixture.</strong> It is not counted and does not hold up the composite.${res.cancel_reason ? '<br>Reason: ' + esc(res.cancel_reason) : ''}</div>${prog}`);
            } else if (res.include) {
                showMixFeedback('include', `<div style="font-weight:800; font-size:1.25rem;">✅ INCLUDE in the mix</div>` +
                    `<div style="margin-top:0.25rem;">Mixing Code: ${pill}</div>` +
                    `<div style="font-size:0.85rem;">${esc(res.sample1_barcode_id)} &bull; scanned ${fmtMixTime(res.scanned_time)}</div>${prog}`);
            } else {
                showMixFeedback('exclude', `<div style="font-weight:800; font-size:1.25rem;">⛔ EXCLUDE &mdash; set this container aside</div>` +
                    `<div style="margin-top:0.25rem;">Mixing Code: ${pill}</div>` +
                    `<div style="font-size:0.85rem;">${esc(res.sample1_barcode_id)} &bull; scanned ${fmtMixTime(res.scanned_time)} &bull; <strong>Do NOT add it to the mixture.</strong></div>`);
            }
            const dateEl = document.getElementById('mixscan-date');
            if (dateEl && res.entry_date) dateEl.value = res.entry_date;     // show the day this container belongs to
            await renderMixScanSummary();
        } catch (err) {
            showMixFeedback('error', `<div style="font-weight:800;">⚠️ ${esc(err.message || err)}</div>`);
        }
    }

    async function renderMixScanSummary() {
        const box = document.getElementById('mixscan-summary');
        if (!box) return;
        const dateEl = document.getElementById('mixscan-date');
        const date = (dateEl && dateEl.value) || window.BiomassAPI.todayIST();
        try {
            const res = await window.BiomassAPI.getMixingScanSummary(date);
            mixScan.last = res;
            const groups = (res && res.groups) || [];
            if (!groups.length) { box.innerHTML = `<div style="color:#94a3b8; font-style:italic; padding:0.5rem;">No samples registered for ${esc(date)}.</div>`; return; }
            box.innerHTML = groups.slice().sort((a, b) => (a.composite_generated ? 1 : 0) - (b.composite_generated ? 1 : 0)).map(g => {  // open groups first
                const complete = g.accepted_total > 0 && g.accepted_scanned >= g.accepted_total;
                const badge = g.composite_generated ? '<span class="badge badge-success">COMPOSITE GENERATED</span>'
                    : g.pending_total > 0 ? `<span class="badge badge-pending">${esc(g.pending_total)} awaiting Lab 1</span>`
                    : g.accepted_total === 0 ? '<span class="badge badge-pending">nothing to mix</span>'
                    : complete ? '<span class="badge badge-success">ALL SCANNED</span>' : '<span class="badge badge-pending">IN PROGRESS</span>';
                const rows = g.scanned.map(x => `<tr><td>${esc(x.id)}</td><td style="font-weight:700; color:${x.include ? '#10b981' : '#ef4444'};">${x.include ? 'INCLUDE' : 'EXCLUDE'}</td><td>${esc(x.time)}</td></tr>`).join('');
                const toScan = g.to_scan.length ? `<div style="margin-top:0.4rem; font-size:0.9rem; color:#fde68a;">⏳ Still to scan: <strong>${g.to_scan.length}</strong> truck${g.to_scan.length > 1 ? 's' : ''}</div>` : '';
                const aside = g.rejected_to_set_aside.length ? `<div style="margin-top:0.3rem; font-size:0.9rem; color:#fca5a5;">⛔ Rejected / cancelled, not scanned yet: <strong>${g.rejected_to_set_aside.length}</strong> truck${g.rejected_to_set_aside.length > 1 ? 's' : ''} - keep out of the mix</div>` : '';
                return `<div style="border:1px solid var(--border-color); border-radius:8px; padding:0.6rem 0.75rem; margin-bottom:0.6rem; background:rgba(15,23,42,0.6);">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                        <div><span class="group-code-badge">${esc(g.group_code)}</span>
                        <span style="font-size:0.82rem; color:#cbd5e1; margin-left:0.4rem;">Include: <strong>${esc(g.accepted_scanned)}/${esc(g.accepted_total)}</strong> &nbsp; Excluded: <strong>${esc(g.rejected_scanned)}/${esc(g.rejected_total)}</strong></span></div>
                        ${badge}
                    </div>
                    ${g.scanned.length ? `<div class="table-responsive" style="margin-top:0.4rem;"><table style="min-width:0; width:100%; font-size:0.82rem;"><thead><tr><th>Container</th><th>Action</th><th>Scanned at</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div style="font-size:0.82rem; color:#94a3b8; margin-top:0.3rem;">Nothing scanned yet.</div>'}
                    ${toScan}${aside}
                </div>`;
            }).join('');
        } catch (err) {
            box.innerHTML = `<div style="color:#ef4444; padding:0.5rem;">Could not load the summary: ${esc(err.message)}</div>`;
        }
    }

    function printMixScanSummary() {
        const res = mixScan.last;
        if (!res || !res.groups || !res.groups.length) { alert('There is nothing to print yet.'); return; }
        const body = `<h2 style="margin:0 0 4px 0;">Mixing scan summary</h2><div style="margin-bottom:10px;">Date: <b>${esc(res.date)}</b> &nbsp; Printed: ${esc(new Date().toLocaleString())}</div>` +
            res.groups.map(g => `
                <h3 style="margin:14px 0 4px 0;">Mixing Code ${esc(g.group_code)} &nbsp; <span style="font-weight:400; font-size:10pt;">Include scanned ${esc(g.accepted_scanned)}/${esc(g.accepted_total)} &bull; Excluded scanned ${esc(g.rejected_scanned)}/${esc(g.rejected_total)}${g.composite_generated ? ' &bull; composite generated' : ''}</span></h3>
                <table border="1" cellpadding="4" style="font-size:10pt;"><thead><tr><th align="left">Container</th><th align="left">Action</th><th align="left">Scanned at</th></tr></thead><tbody>
                ${g.scanned.map(x => `<tr><td>${esc(x.id)}</td><td><b>${x.include ? 'INCLUDE' : 'EXCLUDE'}</b></td><td>${esc(x.time)}</td></tr>`).join('') || '<tr><td colspan="3">Nothing scanned</td></tr>'}
                </tbody></table>
                ${g.to_scan.length ? `<div style="margin-top:4px;"><b>Still to scan:</b> ${g.to_scan.length} truck(s)</div>` : ''}
                ${g.rejected_to_set_aside.length ? `<div style="margin-top:2px;"><b>Rejected, not scanned yet (keep out of the mix):</b> ${g.rejected_to_set_aside.length} truck(s)</div>` : ''}`).join('');
        printDocumentInFrame({ title: `Mixing_scan_summary_${compactDate(res.date)}`, bodyHtml: body });
    }

    // Admin > Settings: reset the scans of one mixing code (only possible before its composite is generated)
    function initMixResetCard() {
        const btn = document.getElementById('btn-mixreset');
        if (!btn) return;
        const dateEl = document.getElementById('mixreset-date'), codeEl = document.getElementById('mixreset-code'), out = document.getElementById('mixreset-result');
        if (!dateEl.value) dateEl.value = window.BiomassAPI.todayIST();
        btn.onclick = async function () {
            const date = dateEl.value, code = codeEl.value.trim().toUpperCase();
            out.textContent = '';
            if (!date || !code) { out.textContent = 'Choose the date and type the mixing code.'; return; }
            if (!confirm(`Reset ALL mixing scans of Mixing Code [${code}] on ${date}?\n\nThe fineness technician will have to scan those containers again before Lab 2 can generate the composite.`)) return;
            btn.disabled = true;
            try {
                const r = await window.BiomassAPI.resetMixingScans(date, code);
                out.textContent = `✅ ${r.removed} scan(s) removed for ${code} (${date}).`;
                codeEl.value = '';
            } catch (e) {
                out.textContent = '⚠️ ' + e.message;
            } finally { btn.disabled = false; }
        };
    }

    function setupLab2CameraScanner() {
        setupSnapOnlyScanner({
            triggerId: 'lab2-scan-trigger',
            readerId: 'lab2-qr-reader',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                lookupLab2Barcode(plainId);
            }
        });
    }

    function setupUnloadingCameraScanner() {
        setupSharedCameraScanner({
            key: 'unloading',
            triggerId: 'unloading-scan-trigger',
            containerId: 'unloading-scanner-container',
            readerId: 'unloading-qr-reader',
            stopBtnId: 'btn-unloading-stop-scan',
            torchBtnId: 'btn-unloading-torch',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('unloading-manual-input').value = plainId;
                lookupUnloadingStatus(plainId);
            }
        });
    }


    // ================= LOTS (three: Lot 2, Lot 3, Lot 4; "LOT2/3" is the old combined value of history booked before the split) =================
    const LOT_LABEL = { 'LOT2': 'Lot 2', 'LOT3': 'Lot 3', 'LOT4': 'Lot 4', 'LOT2/3': 'Lot 2/3' };
    const lotLabel = (l) => LOT_LABEL[l] || String(l || '');
    const lotCls = (l) => l === 'LOT4' ? 'lot-4' : l === 'LOT3' ? 'lot-3' : l === 'LOT2' ? 'lot-2' : 'lot-23';
    // a name without its leading "M/s" (vendor names are stored as "M/s NAME"; searching and matching must not depend on the prefix)
    const stripMs = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^(m\s*\/\s*s\.?\s+)+/i, '');
    // the old LOT2/3 entries (not yet split by the vendor-sheet upload) show up under both the Lot 2 and the Lot 3 filter
    const lotMatches = (lot, f) => !f || f === 'ALL' || lot === f || (lot === 'LOT2/3' && (f === 'LOT2' || f === 'LOT3'));

    // ================= AFTER WEIGHMENT / UNLOADING AREA =================
    // ================= UNLOADING: DAILY REPORT (a password-protected PDF only: nothing is shown on screen, no Excel) =================
    // The rows are fetched only after the server has checked the unloading action password (the one used for bottom samples and Cancel QR, asked EVERY time).
    // They are turned into an AES-256 encrypted PDF that opens only with that same password, and are not kept in the page afterwards.
    function initDayReportCard() {
        const dateEl = document.getElementById('dayreport-date');
        if (!dateEl) return;
        const today = window.BiomassAPI.todayIST();
        const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
        dateEl.max = today;
        if (!dateEl.value) dateEl.value = today;
        document.getElementById('btn-dayreport-today').onclick = () => { dateEl.value = window.BiomassAPI.todayIST(); };
        document.getElementById('btn-dayreport-yesterday').onclick = () => { dateEl.value = shift(window.BiomassAPI.todayIST(), -1); };
        document.getElementById('btn-dayreport-summary').onclick = () => openDayReportPdf('summary');
        document.getElementById('btn-dayreport-details').onclick = () => openDayReportPdf('details');
        document.getElementById('btn-dayreport-excel').onclick = () => openDayReportPdf('excel');
    }

    function openDayReportPdf(kind) {
        const date = document.getElementById('dayreport-date').value || window.BiomassAPI.todayIST();
        const note = document.getElementById('dayreport-note');
        const modal = document.getElementById('dayreport-pw-modal');
        const pw = document.getElementById('dayreport-pw'), msg = document.getElementById('dayreport-pw-msg'), send = document.getElementById('btn-dayreport-pw-send');
        const KIND_TXT = { summary: 'Summary report (PDF)', details: 'Truck-wise details (PDF)', excel: 'Summary + truck-wise details (one Excel file)' };
        document.getElementById('dayreport-pw-what').textContent = KIND_TXT[kind] + ' for ' + dmy(date);
        pw.value = ''; msg.textContent = ''; send.disabled = true;
        modal.style.display = 'flex';
        pw.focus();
        pw.oninput = () => { send.disabled = pw.value.length === 0; };
        pw.onkeydown = (e) => { if (e.key === 'Enter' && !send.disabled) send.click(); };
        document.getElementById('btn-dayreport-pw-cancel').onclick = () => { pw.value = ''; modal.style.display = 'none'; };
        send.onclick = async () => {
            const password = pw.value;
            send.disabled = true; msg.style.color = ''; msg.textContent = 'Checking...';
            try {
                const res = await window.BiomassAPI.getDayReport(date, password);
                if (!res || res.success === false) { msg.style.color = '#ef4444'; msg.textContent = (res && res.message) || 'The report was not opened.'; pw.value = ''; pw.focus(); return; }
                if (!(res.rows || []).length) { msg.style.color = '#f59e0b'; msg.textContent = `No trucks were registered on ${dmy(res.date)}.`; send.disabled = false; return; }
                msg.textContent = 'Creating the file...';
                const bytes = kind === 'summary' ? await buildDaySummaryPdf(res, password) : (kind === 'excel' ? await buildDayExcel(res, password) : await buildDayDetailsPdf(res, password));
                const url = URL.createObjectURL(new Blob([bytes], { type: kind === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf' }));
                const link = document.createElement('a');
                link.href = url; link.download = kind === 'excel' ? `Unloading_Report_${compactDate(res.date)}.xlsx` : `${kind === 'summary' ? 'Unloading_Summary' : 'Truck_Details'}_${compactDate(res.date)}.pdf`;
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(url), 4000);
                pw.value = ''; modal.style.display = 'none';
                note.style.color = '#10b981';
                note.textContent = `${KIND_TXT[kind]} for ${dmy(res.date)} downloaded (${res.rows.length} truck(s)). Open it with the same action password.`;
            } catch (err) {
                msg.style.color = '#f59e0b'; msg.textContent = '⏰ ' + (err.message || String(err)); send.disabled = pw.value.length === 0;
            }
        };
    }

    // ---- a tiny page-layout helper on top of MiniPdf (A4 landscape, points; y grows downwards)
    function newReportDoc(title, dateTxt, subtitle, generated) {
        const pdf = new MiniPdf();
        const W = 842, H = 595, M = 30, d = { pdf, W, H, M, CW: W - 2 * M, y: 0, title, dateTxt };
        const NAVY = '#1F2A5A';
        d.header = (first) => {
            pdf.addPage(W, H);
            if (first) {
                pdf.rect(M, 26, d.CW, 34, { fill: NAVY });
                pdf.text(title, M + 12, 35, { size: 19, bold: true, color: '#FFFFFF' });
                pdf.text('DATE: ' + dateTxt, W - M - 12, 38, { size: 13, bold: true, color: '#FFFFFF', align: 'right' });
                pdf.rect(M, 60, d.CW, 20, { fill: '#3B4A85' });
                pdf.text(subtitle, M + 12, 65, { size: 10.5, bold: true, color: '#FFFFFF' });
                pdf.text('Generated: ' + generated + ' IST', W - M - 12, 66, { size: 8, color: '#FFFFFF', align: 'right' });
                d.y = 94;
            } else {
                pdf.rect(M, 26, d.CW, 20, { fill: NAVY });
                pdf.text(title, M + 10, 31, { size: 10.5, bold: true, color: '#FFFFFF' });
                pdf.text('DATE: ' + dateTxt, W - M - 10, 31, { size: 10.5, bold: true, color: '#FFFFFF', align: 'right' });
                d.y = 58;
            }
        };
        d.ensure = (h) => { if (d.y + h > H - 38) d.header(false); };
        // wrap a text into lines no wider than w
        d.wrap = (str, w, size, bold) => {
            const out = []; let line = '';
            String(str === null || str === undefined ? '' : str).split(/\s+/).filter(Boolean).forEach((word) => {
                let t = line ? line + ' ' + word : word;
                if (pdf.textWidth(t, size, bold) <= w) { line = t; return; }
                if (line) out.push(line);
                while (pdf.textWidth(word, size, bold) > w && word.length > 1) {       // a word longer than the cell is cut
                    let k = word.length - 1; while (k > 1 && pdf.textWidth(word.slice(0, k), size, bold) > w) k--;
                    out.push(word.slice(0, k)); word = word.slice(k);
                }
                line = word;
            });
            if (line) out.push(line);
            return out.length ? out : [''];
        };
        d.section = (text, color) => {
            d.ensure(24 + 40);
            pdf.rect(M, d.y, d.CW, 18, { fill: color || NAVY });
            pdf.text(text, M + 8, d.y + 4.5, { size: 10, bold: true, color: '#FFFFFF' });
            d.y += 22;
        };
        // columns: [{ h, w, align }]; rows: arrays of strings (or { t, color, bold }); opts: size, headFill, headColor, subHead, rowFill(row, i), totalRow
        d.table = (cols, rows, o) => {
            o = o || {}; const size = o.size || 8.5, lh = size * 1.25, padX = 3.5, padY = 3;
            const isB = (cl) => !!(cl && typeof cl === 'object' && cl.bold);       // (a plain string also has a .bold method)
            const head = () => {
                const hl = cols.map(c => d.wrap(c.h, c.w - 2 * padX, size - 0.5, true));
                const hh = Math.max(...hl.map(l => l.length)) * (lh - 0.5) + 2 * padY;
                let x = M;
                cols.forEach((c, i) => {
                    pdf.rect(x, d.y, c.w, hh, { fill: o.headFill || '#3B4A85', stroke: '#B6BCC8', lw: 0.4 });
                    hl[i].forEach((ln, k) => pdf.text(ln, c.align === 'left' ? x + padX : x + c.w / 2, d.y + padY + k * (lh - 0.5), { size: size - 0.5, bold: true, color: o.headColor || '#FFFFFF', align: c.align === 'left' ? 'left' : 'center' }));
                    x += c.w;
                });
                d.y += hh;
            };
            const rowHeight = (cells) => Math.max(...cells.map((cl, i) => { const t = cl && cl.t !== undefined ? cl.t : cl; return d.wrap(t, cols[i].w - 2 * padX, size, isB(cl)).length; })) * lh + 2 * padY;
            d.ensure(40); head();
            rows.forEach((cells, ri) => {
                const rh = rowHeight(cells);
                if (d.y + rh > H - 38) { d.header(false); head(); }
                const isTotal = o.totalRow && ri === rows.length - 1;
                let x = M; const fill = isTotal ? NAVY : (o.rowFill && o.rowFill(cells, ri)) || (ri % 2 ? '#F6F7FA' : '#FFFFFF');
                cols.forEach((c, i) => {
                    const cl = cells[i], t = cl && cl.t !== undefined ? cl.t : cl;
                    pdf.rect(x, d.y, c.w, rh, { fill, stroke: isTotal ? NAVY : '#C9CDD6', lw: 0.4 });
                    const lines = d.wrap(t, c.w - 2 * padX, size, isB(cl) || isTotal);
                    lines.forEach((ln, k) => pdf.text(ln, c.align === 'left' ? x + padX : (c.align === 'right' ? x + c.w - padX : x + c.w / 2), d.y + padY + k * lh,
                        { size, bold: isB(cl) || isTotal, color: isTotal ? '#FFFFFF' : ((cl && cl.color) || '#111827'), align: c.align === 'left' ? 'left' : (c.align === 'right' ? 'right' : 'center') }));
                    x += c.w;
                });
                d.y += rh;
            });
        };
        // a row of equal tiles: [{ label, value, sub, color }]
        d.tiles = (items, h) => {
            h = h || 58; d.ensure(h + 6);
            const gap = 8, w = (d.CW - gap * (items.length - 1)) / items.length;
            items.forEach((t, i) => {
                const x = M + i * (w + gap);
                pdf.rect(x, d.y, w, h, { fill: '#FFFFFF', stroke: '#B6BCC8', lw: 0.6 });
                pdf.rect(x, d.y, w, 16, { fill: '#F0F1F5' });
                const fit = (txt, size, bold) => { while (size > 5 && pdf.textWidth(txt, size, bold) > w - 6) size -= 0.3; return size; };
                pdf.text(t.label, x + w / 2, d.y + 4.5, { size: fit(t.label, 7.6, true), bold: true, color: '#374151', align: 'center' });
                pdf.text(String(t.value), x + w / 2, d.y + 19, { size: fit(String(t.value), h > 50 ? 20 : 16, true), bold: true, color: t.color || '#111827', align: 'center' });
                if (t.sub) pdf.text(t.sub, x + w / 2, d.y + h - 12, { size: fit(t.sub, 7, false), color: '#6B7280', align: 'center' });
            });
            d.y += h + 6;
        };
        d.footers = () => {
            const n = pdf.pages.length;
            pdf.pages.forEach((p, i) => {
                pdf.cur = p;
                pdf.line(M, H - 30, W - M, H - 30, { color: '#C9CDD6', lw: 0.5 });
                pdf.text(title + '  •  ' + dateTxt + '  •  Confidential', M, H - 24, { size: 7.5, color: '#6B7280' });
                pdf.text('Page ' + (i + 1) + ' of ' + n, W - M, H - 24, { size: 7.5, color: '#6B7280', align: 'right' });
            });
        };
        return d;
    }

    // ================= UNLOADING: DAILY SUMMARY REPORT (for seniors) =================
    // Only the unloading department's view: trucks received / approved / unloaded / rejected and the unloaded quantity (net weighbridge weight).
    // No laboratory results. Vendors are ranked by net quantity unloaded; every vendor also shows its Lot 2 / Lot 3 / Lot 4 split.
    const SUMMARY_LOTS = ['LOT2', 'LOT3', 'LOT4', 'LOT2/3'];        // LOT2/3 = trucks booked before the split of Lot 2 and Lot 3 (shown only when present)
    function daySummaryData(rows) {
        const lotOf = (r) => { const k = String(r.lot || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return k === 'LOT4' ? 'LOT4' : k === 'LOT3' ? 'LOT3' : k === 'LOT2' ? 'LOT2' : 'LOT2/3'; };
        const kg = (r) => Number(r.net_weight) || 0;
        const isCancelled = (r) => r.acceptance_status === 'CANCELLED';
        const isRej = (r) => r.acceptance_status === 'REJECTED' || isCancelled(r);
        const isApp = (r) => r.acceptance_status === 'ACCEPTED';
        const isUnl = (r) => isApp(r) && Number(r.tare_weight) > 0 && kg(r) > 0;
        const lotBlank = () => { const o = {}; SUMMARY_LOTS.forEach(l => { o[l] = { unloaded: 0, kg: 0 }; }); return o; };
        const blank = () => ({ received: 0, approved: 0, unloaded: 0, rejected: 0, cancelled: 0, awaiting: 0, notUnloaded: 0, kg: 0, rejKg: 0, lots: lotBlank() });
        const add = (o, r) => {
            o.received++;
            if (isApp(r)) { o.approved++; if (!isUnl(r)) o.notUnloaded++; }
            if (isUnl(r)) { o.unloaded++; o.kg += kg(r); const L = o.lots[lotOf(r)]; L.unloaded++; L.kg += kg(r); }
            if (isRej(r)) { o.rejected++; o.rejKg += kg(r); if (isCancelled(r)) o.cancelled++; }
            if (!isApp(r) && !isRej(r)) o.awaiting++;
        };
        const total = blank(), vendors = {}, lots = {}, lotVendors = {};
        SUMMARY_LOTS.forEach(l => { lots[l] = blank(); lotVendors[l] = new Set(); });
        rows.forEach((r) => {
            const name = String(r.company_name || '-').trim();
            const v = vendors[name] || (vendors[name] = Object.assign(blank(), { name }));
            add(v, r); add(total, r); add(lots[lotOf(r)], r); lotVendors[lotOf(r)].add(name);
        });
        const list = Object.values(vendors).sort((a, b) => (b.kg - a.kg) || (b.received - a.received) || a.name.localeCompare(b.name));
        const rejected = rows.filter(isRej).sort((a, b) => String(a.company_name).localeCompare(String(b.company_name)) || String(a.truck_reg_number).localeCompare(String(b.truck_reg_number)));
        // the lots that appear in the report: the three real lots always, the old combined one only if trucks were booked under it
        const shownLots = SUMMARY_LOTS.filter(l => l !== 'LOT2/3' || lots[l].received > 0);
        return { total, vendors: list, lots, lotVendors, rejected, lotOf, kg, isCancelled, shownLots };
    }

    // a pie / donut chart drawn on a canvas (2x for a crisp picture inside the PDF)
    function drawPieImage(items, title, w, h, donut) {
        const palette = ['#2E7D32', '#00897B', '#1A237E', '#C62828', '#6A1B9A', '#8D6E63', '#37474F', '#F9A825', '#0288D1', '#AD1457', '#558B2F', '#EF6C00'];
        const SC = 2, c = document.createElement('canvas'); c.width = w * SC; c.height = h * SC;
        const x = c.getContext('2d'); x.scale(SC, SC);
        x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#1F2A5A'; x.font = 'bold 15px Arial'; x.textAlign = 'left'; x.textBaseline = 'top'; x.fillText(title, 10, 8);
        const sum = items.reduce((a, i) => a + i.value, 0);
        if (!(sum > 0)) { x.fillStyle = '#6B7280'; x.font = '14px Arial'; x.fillText('No biomass was unloaded.', 10, 50); return c; }
        const R = Math.min(h - 50, w * 0.42) / 2, cx = 14 + R + 6, cy = 34 + (h - 34) / 2;
        let a0 = -Math.PI / 2;
        items.forEach((it, i) => {
            const a1 = a0 + (it.value / sum) * Math.PI * 2;
            x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, R, a0, a1); x.closePath();
            x.fillStyle = it.color || palette[i % palette.length]; x.fill();
            x.strokeStyle = '#FFFFFF'; x.lineWidth = 2; x.stroke();
            const pct = it.value / sum * 100;
            if (pct >= 5) {
                const am = (a0 + a1) / 2, rr = donut ? R * 0.78 : R * 0.64;
                x.fillStyle = '#FFFFFF'; x.font = 'bold 12px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
                x.fillText(pct.toFixed(1) + '%', cx + Math.cos(am) * rr, cy + Math.sin(am) * rr);
            }
            a0 = a1;
        });
        if (donut) {
            x.beginPath(); x.arc(cx, cy, R * 0.5, 0, Math.PI * 2); x.fillStyle = '#FFFFFF'; x.fill();
            x.fillStyle = '#1F2A5A'; x.font = 'bold 15px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
            x.fillText((sum / 1000).toFixed(2), cx, cy - 8); x.font = '11px Arial'; x.fillText('MT unloaded', cx, cy + 10);
        }
        const lx = cx + R + 22; let ly = 40;
        const step = Math.min(22, (h - 52) / Math.max(1, items.length));
        items.forEach((it, i) => {
            x.fillStyle = it.color || palette[i % palette.length]; x.fillRect(lx, ly, 11, 11);
            x.fillStyle = '#111827'; x.font = '12px Arial'; x.textAlign = 'left'; x.textBaseline = 'top';
            const full = it.label + ' (' + (it.value / sum * 100).toFixed(1) + '%)';
            let t = full;
            const maxW = w - lx - 20;
            while (x.measureText(t).width > maxW && t.length > 8) t = t.slice(0, -2);
            if (t !== full) t += '…';
            x.fillText(t, lx + 17, ly - 1); ly += step;
        });
        return c;
    }

    async function buildDaySummaryPdf(res, password) {
        const S = daySummaryData(res.rows), T = S.total;
        const mt = (kg) => ((Number(kg) || 0) / 1000);
        const f2 = (kg) => mt(kg).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const f3 = (kg) => mt(kg).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
        const GREEN = '#2E7D32', RED = '#C62828', PURPLE = '#6A1B9A', BLUE = '#1565C0';
        const d = newReportDoc('BIOMASS RECEIPT & UNLOADING REPORT', dmy(res.date), 'PLANT SUMMARY  —  Unloading Department', res.generated_at || '');
        d.header(true);
        const avg = T.unloaded ? T.kg / T.unloaded : 0;
        d.tiles([
            { label: 'TRUCKS RECEIVED', value: T.received, sub: 'registered on this date', color: '#1F2A5A' },
            { label: 'APPROVED', value: T.approved, sub: (T.approved - T.notUnloaded) + ' unloaded' + (T.notUnloaded ? ', ' + T.notUnloaded + ' to unload' : ''), color: GREEN },
            { label: 'UNLOADED', value: T.unloaded, sub: 'approved and weighed out', color: GREEN },
            { label: 'REJECTED', value: T.rejected, sub: T.cancelled ? 'incl. ' + T.cancelled + ' QR cancelled' : 'by the laboratory', color: RED },
            { label: 'NET UNLOADED (MT)', value: f2(T.kg), sub: 'tonnes of biomass', color: PURPLE },
            { label: 'AVG WT / TRUCK (MT)', value: f2(avg), sub: 'unloaded trucks only', color: BLUE }
        ], 60);
        d.y += 4;
        // ---- vendor-wise table
        d.section('VENDOR-WISE SUMMARY — in descending order of net quantity unloaded');
        const lotsShown = S.shownLots, lotW = 74, fixed = 30 + 50 * 4 + lotW * lotsShown.length + 66 + 46;
        const cols = [{ h: 'Rank', w: 30 }, { h: 'Vendor name', w: d.CW - fixed, align: 'left' }, { h: 'Received', w: 50 }, { h: 'Approved', w: 50 }, { h: 'Unloaded', w: 50 }, { h: 'Rejected', w: 50 }]
            .concat(lotsShown.map(l => ({ h: lotLabel(l) + ' MT (trucks)', w: lotW })), [{ h: 'Total unloaded (MT)', w: 66 }, { h: '% share', w: 46 }]);
        const vrows = S.vendors.map((v, i) => [String(i + 1), { t: v.name, bold: false }, String(v.received), String(v.approved), String(v.unloaded), { t: String(v.rejected), color: v.rejected ? RED : undefined }]
            .concat(lotsShown.map(l => v.lots[l].unloaded ? f2(v.lots[l].kg) + ' (' + v.lots[l].unloaded + ')' : '-'), [{ t: f2(v.kg), bold: true }, (T.kg ? (v.kg / T.kg * 100).toFixed(2) : '0.00') + '%']));
        vrows.push(['', 'TOTAL', String(T.received), String(T.approved), String(T.unloaded), String(T.rejected)].concat(lotsShown.map(l => f2(T.lots[l].kg) + ' (' + T.lots[l].unloaded + ')'), [f2(T.kg), T.kg ? '100.00%' : '0.00%']));
        d.table(cols, vrows, { totalRow: true });
        d.y += 12;
        // ---- charts
        d.ensure(22 + 190);
        d.section('CONTRIBUTION OF EACH VENDOR AND EACH LOT TO THE UNLOADED BIOMASS');
        const items = S.vendors.filter(v => v.kg > 0).map(v => ({ label: v.name, value: v.kg }));
        let vItems = items;
        if (items.length > 9) { const rest = items.slice(9); vItems = items.slice(0, 9).concat([{ label: 'Others (' + rest.length + ' vendors)', value: rest.reduce((a, i) => a + i.value, 0), color: '#9CA3AF' }]); }
        const lotColor = { 'LOT2': '#0288D1', 'LOT3': '#1565C0', 'LOT4': '#6A1B9A', 'LOT2/3': '#00897B' };
        const lotItems = lotsShown.map(l => ({ label: lotLabel(l), value: T.lots[l].kg, color: lotColor[l] })).filter(i => i.value > 0);
        d.pdf.image(drawPieImage(vItems, 'Unloaded biomass by vendor (MT share)', 700, 300, false), d.M, d.y, 450, 193);
        d.pdf.image(drawPieImage(lotItems, 'Unloaded biomass by lot', 420, 300, true), d.M + 462, d.y, 290, 193);
        d.y += 200;
        // ---- rejected trucks
        d.ensure(22 + 24 + 3 * 18);
        d.section('REJECTED TRUCKS — details (weights are as weighed; they are NOT part of the unloaded quantity)', RED);
        if (!S.rejected.length) {
            d.table([{ h: 'Result', w: d.CW, align: 'left' }], [['No truck was rejected on this date.']], { headFill: RED });
        } else {
            d.table([{ h: 'Sl.', w: 30 }, { h: 'Vendor name', w: d.CW - 30 - 110 - 70 - 90 - 250, align: 'left' }, { h: 'Truck no.', w: 110 }, { h: 'Lot', w: 70 }, { h: 'Weighed (MT)', w: 90 }, { h: 'Remark', w: 250, align: 'left' }],
                S.rejected.map((x, i) => [String(i + 1), x.company_name, x.truck_reg_number, lotLabel(S.lotOf(x)), S.kg(x) > 0 ? f2(S.kg(x)) : '-', S.isCancelled(x) ? 'QR cancelled' + (x.cancel_reason ? ': ' + x.cancel_reason : '') : 'Rejected']),
                { headFill: RED, rowFill: (c, i) => i % 2 ? '#FEF2F2' : '#FFFFFF' });
            const byV = {}; S.rejected.forEach(x => { const v = byV[x.company_name] || (byV[x.company_name] = { n: 0, kg: 0 }); v.n++; v.kg += S.kg(x); });
            d.y += 10;
            d.ensure(40);
            d.pdf.text('REJECTION SUMMARY BY VENDOR', d.M, d.y, { size: 9, bold: true, color: '#991B1B' }); d.y += 14;
            d.table([{ h: 'Vendor name', w: 400, align: 'left' }, { h: 'Trucks rejected', w: 100 }, { h: 'Weighed (MT)', w: 100 }],
                Object.keys(byV).sort((a, b) => byV[b].n - byV[a].n || a.localeCompare(b)).map(name => [name, byV[name].n + ' truck' + (byV[name].n > 1 ? 's' : ''), byV[name].kg > 0 ? f2(byV[name].kg) : '-']), { headFill: '#991B1B' });
        }
        d.y += 14;
        // ---- bottom: daily total + lot-wise breakdown
        d.ensure(22 + 64 + 6);
        d.section('DAILY SUMMARY — total trucks');
        d.tiles([
            { label: 'TOTAL TRUCKS RECEIVED', value: T.received }, { label: 'APPROVED', value: T.approved, color: GREEN }, { label: 'UNLOADED', value: T.unloaded, color: GREEN },
            { label: 'APPROVED, TO UNLOAD', value: T.notUnloaded }, { label: 'REJECTED' + (T.cancelled ? ' (incl. ' + T.cancelled + ' QR cancelled)' : ''), value: T.rejected, color: RED },
            { label: 'AWAITING LAB DECISION', value: T.awaiting }, { label: 'NET QTY UNLOADED (MT)', value: f2(T.kg), color: PURPLE }, { label: 'REJECTED, WEIGHED (MT)', value: f2(T.rejKg), color: RED }
        ], 46);
        d.y += 6;
        d.ensure(22 + 24 + (lotsShown.length + 1) * 18 + 50);
        d.section('LOT-WISE BREAKDOWN OF UNLOADED BIOMASS');
        const lc = [{ h: 'Lot', w: 150, align: 'left' }, { h: 'Received', w: 80 }, { h: 'Approved', w: 80 }, { h: 'Unloaded', w: 80 }, { h: 'Rejected', w: 80 }, { h: 'Net qty (MT)', w: 100 }, { h: '% share', w: 80 }, { h: 'Vendors', w: d.CW - 650 }];
        const lr = lotsShown.map(l => { const L = S.lots[l]; return [{ t: lotLabel(l), bold: true }, String(L.received), String(L.approved), String(L.unloaded), String(L.rejected), { t: f2(L.kg), bold: true }, (T.kg ? (L.kg / T.kg * 100).toFixed(2) : '0.00') + '%', String(S.lotVendors[l].size)]; });
        lr.push(['TOTAL', String(T.received), String(T.approved), String(T.unloaded), String(T.rejected), f2(T.kg), T.kg ? '100.00%' : '0.00%', String(S.vendors.length)]);
        d.table(lc, lr, { totalRow: true });
        d.y += 10; d.ensure(40);
        d.wrap('Notes: Net quantity = final weighbridge net weight (gross − tare) of trucks that were approved and unloaded. Rejected trucks are listed with the weight recorded for them and are not part of the unloaded quantity. ' +
            'A vendor that supplied under more than one lot is shown once, with the lot-wise split' + (lotsShown.indexOf('LOT2/3') >= 0 ? ' (“Lot 2/3” = trucks booked before Lot 2 and Lot 3 were separated)' : '') + '. Prepared from the unloading department records; laboratory results are not part of this summary.', d.CW, 8, false)
            .forEach((ln, i) => d.pdf.text(ln, d.M, d.y + i * 10.5, { size: 8, color: '#6B7280' }));
        d.footers();
        return await d.pdf.build(password);
    }

    // ================= UNLOADING: ONE EXCEL FILE (Summary + Truck-wise details), locked with the action password =================
    // Two sheets in one workbook. The file is encrypted like Excel's own "Encrypt with Password" (lib/xlsx-crypt.js): Excel asks for the same
    // action password when it is opened. Nothing is shown on the screen.
    async function buildDayExcel(res, password) {
        if (typeof ExcelJS === 'undefined') throw new Error('The Excel library could not be loaded. Check the internet connection and try again.');
        if (!window.XlsxCrypt) throw new Error('The file-protection library (lib/xlsx-crypt.js) is not loaded.');
        const rows = res.rows, S = daySummaryData(rows), T = S.total;
        const mt = (kg) => Number(((Number(kg) || 0) / 1000).toFixed(3));
        const NAVY = 'FF1F2A5A', MID = 'FF3B4A85', LIGHT = 'FFEEF1FA', GREY = 'FFF3F4F6', GREEN = 'FF2E7D32', RED = 'FFC62828', PURPLE = 'FF6A1B9A', BLUE = 'FF1565C0';
        const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
        const bd = (st, argb) => { const b = { style: st, color: { argb: argb || 'FFB6BCC8' } }; return { top: b, left: b, bottom: b, right: b }; };
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Biomass Unloading Department'; wb.created = new Date();

        // ---------------- sheet 1: summary
        const sh = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
        const lots = S.shownLots, LC = lots.length;
        const W = [6, 38, 10, 10, 10, 10].concat(lots.map(() => 13), [14, 10]);          // rank, vendor, received, approved, unloaded, rejected, lots..., total, share
        W.forEach((w, i) => { sh.getColumn(i + 1).width = w; });
        const COLS = W.length;
        const put = (r, c1, c2, value, o) => {
            o = o || {};
            if (c2 > c1) sh.mergeCells(r, c1, r, c2);
            const cell = sh.getCell(r, c1);
            cell.value = value;
            cell.font = { name: 'Calibri', size: o.size || 11, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || 'FF111827' } };
            cell.alignment = { vertical: 'middle', horizontal: o.h || 'center', wrapText: o.wrap !== false };
            for (let c = c1; c <= c2; c++) { if (o.fill) sh.getCell(r, c).fill = fill(o.fill); if (o.border) sh.getCell(r, c).border = bd(o.border); }
            if (o.fmt) cell.numFmt = o.fmt;
        };
        let r = 1;
        sh.getRow(r).height = 34;
        put(r, 1, COLS - 3, 'BIOMASS RECEIPT & UNLOADING REPORT', { size: 20, bold: true, color: 'FFFFFFFF', fill: NAVY, h: 'left' });
        put(r, COLS - 2, COLS, 'DATE: ' + dmy(res.date), { size: 13, bold: true, color: 'FFFFFFFF', fill: NAVY, h: 'right' });
        r++; sh.getRow(r).height = 22;
        put(r, 1, COLS - 3, 'PLANT SUMMARY  —  Unloading Department', { size: 12, bold: true, color: 'FFFFFFFF', fill: MID, h: 'left' });
        put(r, COLS - 2, COLS, 'Generated: ' + (res.generated_at || '') + ' IST', { size: 9, color: 'FFFFFFFF', fill: MID, h: 'right' });
        r += 2;
        const avg = T.unloaded ? T.kg / T.unloaded : 0;
        const tiles = [['TRUCKS RECEIVED', T.received, NAVY, '0'], ['APPROVED', T.approved, GREEN, '0'], ['UNLOADED', T.unloaded, GREEN, '0'], ['REJECTED', T.rejected, RED, '0'], ['NET UNLOADED (MT)', mt(T.kg), PURPLE, '#,##0.00'], ['AVG WT / TRUCK (MT)', mt(avg), BLUE, '#,##0.00']];
        const per = Math.max(1, Math.floor(COLS / 6)); sh.getRow(r).height = 20; sh.getRow(r + 1).height = 36;
        tiles.forEach((t, i) => {
            const a = 1 + i * per, b = i === 5 ? COLS : a + per - 1;
            put(r, a, b, t[0], { size: 9, bold: true, color: 'FF374151', fill: GREY, border: 'thin' });
            put(r + 1, a, b, t[1], { size: 22, bold: true, color: t[2], border: 'thin', fmt: t[3] });
        });
        r += 3;
        const bar = (text, color) => { sh.getRow(r).height = 22; put(r, 1, COLS, text, { size: 12, bold: true, color: 'FFFFFFFF', fill: color || NAVY, h: 'left' }); r++; };
        bar('VENDOR-WISE SUMMARY — in descending order of net quantity unloaded');
        sh.getRow(r).height = 30;
        ['Rank', 'Vendor name', 'Received', 'Approved', 'Unloaded', 'Rejected'].concat(lots.map(l => lotLabel(l) + ' MT'), ['Total unloaded MT', '% share']).forEach((h, i) => put(r, i + 1, i + 1, h, { size: 10, bold: true, color: 'FFFFFFFF', fill: MID, border: 'thin' }));
        r++;
        S.vendors.forEach((v, i) => {
            sh.getRow(r).height = Math.max(18, 16 * Math.ceil(v.name.length / 38));
            const vals = [i + 1, v.name, v.received, v.approved, v.unloaded, v.rejected].concat(lots.map(l => v.lots[l].kg ? mt(v.lots[l].kg) : 0), [mt(v.kg), T.kg ? Number((v.kg / T.kg * 100).toFixed(2)) : 0]);
            vals.forEach((val, k) => {
                const cell = sh.getCell(r, k + 1); cell.value = val; cell.border = bd('thin'); cell.fill = fill(i % 2 ? 'FFF9FAFB' : 'FFFFFFFF');
                cell.font = { name: 'Calibri', size: 11, bold: k === 6 + LC, color: { argb: k === 5 && v.rejected ? RED : 'FF111827' } };
                cell.alignment = { vertical: 'middle', horizontal: k === 1 ? 'left' : 'center', wrapText: true };
                if (k >= 6 && k < 7 + LC) cell.numFmt = '#,##0.00;-#,##0.00;"-"';
                if (k === 7 + LC) cell.numFmt = '0.00"%"';
            });
            r++;
        });
        sh.getRow(r).height = 22;
        ['', 'TOTAL', T.received, T.approved, T.unloaded, T.rejected].concat(lots.map(l => mt(T.lots[l].kg)), [mt(T.kg), T.kg ? 100 : 0]).forEach((val, k) => {
            const cell = sh.getCell(r, k + 1); cell.value = val; cell.fill = fill(NAVY); cell.border = bd('thin', NAVY);
            cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } }; cell.alignment = { vertical: 'middle', horizontal: k === 1 ? 'left' : 'center' };
            if (k >= 6 && k < 7 + LC) cell.numFmt = '#,##0.00'; if (k === 7 + LC) cell.numFmt = '0.00"%"';
        });
        r += 2;
        // charts (pictures)
        bar('CONTRIBUTION OF EACH VENDOR AND EACH LOT TO THE UNLOADED BIOMASS');
        const items = S.vendors.filter(v => v.kg > 0).map(v => ({ label: v.name, value: v.kg }));
        let vItems = items;
        if (items.length > 9) { const rest = items.slice(9); vItems = items.slice(0, 9).concat([{ label: 'Others (' + rest.length + ' vendors)', value: rest.reduce((a, i) => a + i.value, 0), color: '#9CA3AF' }]); }
        const lotColor = { 'LOT2': '#0288D1', 'LOT3': '#1565C0', 'LOT4': '#6A1B9A', 'LOT2/3': '#00897B' };
        const lotItems = lots.map(l => ({ label: lotLabel(l), value: T.lots[l].kg, color: lotColor[l] })).filter(i => i.value > 0);
        const png = (cv) => cv.toDataURL('image/png').split(',')[1];
        const img1 = wb.addImage({ base64: png(drawPieImage(vItems, 'Unloaded biomass by vendor (MT share)', 700, 300, false)), extension: 'png' });
        const img2 = wb.addImage({ base64: png(drawPieImage(lotItems, 'Unloaded biomass by lot', 420, 300, true)), extension: 'png' });
        for (let k = 0; k < 16; k++) sh.getRow(r + k).height = 20;
        sh.addImage(img1, { tl: { col: 0.1, row: r - 1 + 0.2 }, ext: { width: 640, height: 275 } });
        sh.addImage(img2, { tl: { col: Math.min(COLS - 4, 7.5), row: r - 1 + 0.2 }, ext: { width: 380, height: 275 } });
        r += 16;
        // rejected trucks
        bar('REJECTED TRUCKS — weights are as weighed; they are NOT part of the unloaded quantity', RED);
        sh.getRow(r).height = 22;
        [['Sl.', 1, 1], ['Vendor name', 2, 2], ['Truck no.', 3, 4], ['Lot', 5, 5], ['Weighed MT', 6, 7], ['Remark', 8, COLS]].forEach(([h, a, b]) => put(r, a, Math.min(b, COLS), h, { size: 10, bold: true, color: 'FFFFFFFF', fill: RED, border: 'thin' }));
        r++;
        if (!S.rejected.length) { put(r, 1, COLS, 'No truck was rejected on this date.', { italic: true, color: 'FF6B7280', border: 'thin' }); r++; }
        S.rejected.forEach((x, i) => {
            sh.getRow(r).height = Math.max(18, 16 * Math.ceil(String(x.company_name).length / 38));
            const band = i % 2 ? 'FFFEF2F2' : 'FFFFFFFF';
            put(r, 1, 1, i + 1, { fill: band, border: 'thin' }); put(r, 2, 2, x.company_name, { fill: band, border: 'thin', h: 'left' }); put(r, 3, 4, x.truck_reg_number, { fill: band, border: 'thin' });
            put(r, 5, 5, lotLabel(S.lotOf(x)), { fill: band, border: 'thin' }); put(r, 6, 7, S.kg(x) > 0 ? mt(S.kg(x)) : '-', { fill: band, border: 'thin', fmt: '#,##0.00' });
            put(r, 8, COLS, S.isCancelled(x) ? 'QR cancelled' + (x.cancel_reason ? ': ' + x.cancel_reason : '') : 'Rejected', { fill: band, border: 'thin', size: 10, h: 'left' });
            r++;
        });
        r++;
        bar('LOT-WISE BREAKDOWN OF UNLOADED BIOMASS');
        sh.getRow(r).height = 28;
        [['Lot', 1, 2], ['Received', 3, 3], ['Approved', 4, 4], ['Unloaded', 5, 5], ['Rejected', 6, 6], ['Net MT', 7, 8], ['% share', 9, 9], ['Vendors', 10, 10]].forEach(([h, a, b]) => { if (a <= COLS) put(r, a, Math.min(b, COLS), h, { size: 10, bold: true, color: 'FFFFFFFF', fill: MID, border: 'thin' }); });
        r++;
        lots.forEach((l, i) => {
            const L = S.lots[l], f = i % 2 ? 'FFF9FAFB' : 'FFFFFFFF';
            [[lotLabel(l), 1, 2, 'left'], [L.received, 3, 3], [L.approved, 4, 4], [L.unloaded, 5, 5], [L.rejected, 6, 6], [mt(L.kg), 7, 8], [T.kg ? Number((L.kg / T.kg * 100).toFixed(2)) : 0, 9, 9], [S.lotVendors[l].size, 10, 10]].forEach(([v, a, b, h]) => {
                if (a <= COLS) put(r, a, Math.min(b, COLS), v, { fill: f, border: 'thin', h: h || 'center', bold: a === 1 || a === 7, fmt: a === 7 ? '#,##0.00' : (a === 9 ? '0.00"%"' : undefined) });
            });
            r++;
        });
        r += 1;
        sh.getRow(r).height = 40;
        put(r, 1, COLS, 'Notes: Net quantity = final weighbridge net weight (gross − tare) of trucks that were approved and unloaded. Rejected trucks are listed with the weight recorded for them and are not part of the unloaded quantity. ' +
            'A vendor that supplied under more than one lot is shown once, with the lot-wise split. Prepared from the unloading department records; laboratory results are not part of the summary sheet.', { size: 9, italic: true, color: 'FF6B7280', h: 'left' });
        sh.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.5, header: 0.2, footer: 0.25 } };
        sh.headerFooter = { oddFooter: '&LBiomass Receipt && Unloading Report ' + dmy(res.date) + ' - Confidential&RPage &P of &N' };

        // ---------------- sheet 2: truck-wise details
        const sd = wb.addWorksheet('Truck-wise details', { views: [{ state: 'frozen', ySplit: 4 }] });
        const cols = [['S.No.', 7], ['Truck No.', 15], ['Vendor', 34], ['Lot', 10], ['PO No.', 14], ['Gross Wt (kg)', 14], ['Tare Wt (kg)', 14], ['Net Wt (kg)', 14], ['Net Wt (MT)', 12],
                      ['Moisture %', 11], ['TM %', 10], ['ARB GCV (kcal/kg)', 14], ['Fineness %', 11], ['ARB Ash %', 10], ['ARB Sulphur % (Lot-4)', 13], ['ARB VM % (Lot-4)', 12], ['GCV / Ash from', 16], ['Result', 22]];
        sd.mergeCells(1, 1, 1, cols.length);
        Object.assign(sd.getCell(1, 1), { value: `Biomass Procurement — Truck-wise details for ${dmy(res.date)}` });
        sd.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }; sd.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'center' };
        sd.getRow(1).height = 28; for (let c = 1; c <= cols.length; c++) sd.getCell(1, c).fill = fill('FF059669');
        sd.mergeCells(2, 1, 2, cols.length);
        sd.getCell(2, 1).value = `Trucks: ${rows.length}    |    Generated: ${res.generated_at} IST`;
        sd.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF374151' } }; sd.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'center' };
        for (let c = 1; c <= cols.length; c++) sd.getCell(2, c).fill = fill('FFE5E7EB');
        sd.getRow(3).height = 6;
        cols.forEach(([h, w], i) => {
            const c = sd.getCell(4, i + 1); c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF111827');
            c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = bd('thin'); sd.getColumn(i + 1).width = w;
        });
        sd.getRow(4).height = 26;
        const numv = v => (v === null || v === undefined || v === '') ? null : Number(v);
        let rr = 5;
        rows.forEach((x, i) => {
            const rej = x.acceptance_status === 'REJECTED' || x.acceptance_status === 'CANCELLED';
            const na = rej ? ('N/A (' + x.acceptance_status + ')') : 'Pending';
            const w = v => Number(v) > 0 ? Number(v) : '-';
            const l4 = x.lot === 'LOT4';
            const vals = [i + 1, x.truck_reg_number, x.company_name, lotLabel(x.lot) || '-', x.po_number || '-', w(x.gross_weight), w(x.tare_weight), w(x.net_weight), Number(x.net_weight) > 0 ? Number((Number(x.net_weight) / 1000).toFixed(3)) : '-',
                          numv(x.moisture_pct) ?? na, numv(x.tm) ?? na, numv(x.gcv) ?? na, numv(x.fineness_value) ?? na, numv(x.ash) ?? na, l4 ? (numv(x.sulphur) ?? na) : '-', l4 ? (numv(x.vm) ?? na) : '-', x.gcv_source || '-',
                          x.acceptance_status === 'CANCELLED' ? ('QR CANCELLED: ' + (x.cancel_reason || '')) : x.acceptance_status];
            vals.forEach((v, k) => {
                const c = sd.getCell(rr, k + 1); c.value = v; c.border = bd('hair', 'FFD1D5DB');
                c.alignment = { vertical: 'middle', horizontal: (k === 1 || k === 2) ? 'left' : 'center', wrapText: k === 17 };
                if (typeof v === 'number' && k >= 5 && k <= 7) c.numFmt = '#,##0.###';
                if (rej) c.fill = fill('FFFEE2E2'); else if (rr % 2 === 0) c.fill = fill('FFF9FAFB');
            });
            rr++;
        });
        sd.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
        rr += 1;
        const acc = rows.filter(x => x.acceptance_status === 'ACCEPTED'), rej2 = rows.filter(x => x.acceptance_status === 'REJECTED' || x.acceptance_status === 'CANCELLED');
        const sumKg = a => a.reduce((s, x) => s + (Number(x.net_weight) || 0), 0);
        [['Total trucks', rows.length], ['Accepted / Rejected', `${acc.length} / ${rej2.length}`], ['Total net weight (MT)', mt(sumKg(rows))], ['Accepted net weight (MT)', mt(sumKg(acc))], ['Rejected net weight (MT)', mt(sumKg(rej2))]].forEach(([label, val]) => {
            sd.getCell(rr, 2).value = label; sd.getCell(rr, 2).font = { bold: true }; sd.getCell(rr, 3).value = val; sd.getCell(rr, 3).alignment = { horizontal: 'left' }; rr++;
        });
        sd.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

        const plain = new Uint8Array(await wb.xlsx.writeBuffer());
        return await window.XlsxCrypt.encrypt(plain, password);
    }

    // ================= UNLOADING: TRUCK-WISE DETAILS (every truck, weights and test results) =================
    async function buildDayDetailsPdf(res, password) {
        const rows = res.rows;
        const d = newReportDoc('BIOMASS DAILY REPORT — TRUCK-WISE DETAILS', dmy(res.date), rows.length + ' truck(s)  •  weights in kg  •  results as recorded', res.generated_at || '');
        d.header(true);
        const fx = (v, n) => (v === null || v === undefined || v === '') ? null : Number(v).toFixed(n);
        const wt = (v) => Number(v) > 0 ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-';
        const others = [['#', 22], ['Truck No.', 62], ['Lot / PO', 80], ['Gross', 44], ['Tare', 44], ['Net', 44], ['Moist. %', 34], ['TM %', 32], ['GCV', 34], ['Fine. %', 34], ['Ash %', 32], ['Sulph. %', 34], ['VM %', 30], ['GCV/Ash from', 48], ['Result', 66]];
        const vendorW = d.CW - others.reduce((a, c) => a + c[1], 0);
        const cols = others.slice(0, 2).map(c => ({ h: c[0], w: c[1], align: c[0] === 'Truck No.' ? 'left' : undefined })).concat([{ h: 'Vendor', w: vendorW, align: 'left' }], others.slice(2).map(c => ({ h: c[0], w: c[1] })));
        const RED = '#C62828', AMBER = '#B45309', GREEN = '#2E7D32';
        const body = rows.map((r, i) => {
            const rej = r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED';
            const cell = (v, n) => { const s = fx(v, n); return s !== null ? s : (rej ? { t: 'N/A', color: RED } : { t: 'Pend.', color: AMBER }); };
            const l4 = r.lot === 'LOT4';
            return [String(i + 1), { t: r.truck_reg_number, bold: true }, r.company_name, lotLabel(r.lot) + ' / ' + (r.po_number || '-'),
                wt(r.gross_weight), wt(r.tare_weight), { t: wt(r.net_weight), bold: true },
                cell(r.moisture_pct, 2), cell(r.tm, 2), cell(r.gcv, 0), cell(r.fineness_value, 2), cell(r.ash, 2), l4 ? cell(r.sulphur, 2) : '-', l4 ? cell(r.vm, 2) : '-', r.gcv_source || '-',
                r.acceptance_status === 'CANCELLED' ? { t: 'QR CANCELLED' + (r.cancel_reason ? ': ' + r.cancel_reason : ''), color: RED, bold: true } : { t: r.acceptance_status, bold: true, color: rej ? RED : r.acceptance_status === 'ACCEPTED' ? GREEN : AMBER }];
        });
        d.table(cols, body, { size: 7.4, headFill: '#111827', rowFill: (c, i) => /REJECTED|CANCELLED/.test(String((c[15] && c[15].t) || '')) ? '#FDECEC' : (i % 2 ? '#F6F7FA' : '#FFFFFF') });
        d.y += 8;
        d.ensure(14);
        d.pdf.text('Pend. = result not available yet.   N/A = not tested because the truck was rejected.   GCV / Ash come from the composite sample of the day, or from the bottom sample when one was taken.', d.M, d.y, { size: 7.2, color: '#6B7280' });
        d.y += 14;
        const acc = rows.filter(x => x.acceptance_status === 'ACCEPTED'), rej = rows.filter(x => x.acceptance_status === 'REJECTED' || x.acceptance_status === 'CANCELLED');
        const sum = (a) => a.reduce((s, x) => s + (Number(x.net_weight) || 0), 0);
        const mtS = (kg) => (kg / 1000).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
        d.ensure(30);
        d.tiles([{ label: 'TOTAL TRUCKS', value: rows.length }, { label: 'ACCEPTED / REJECTED', value: acc.length + ' / ' + rej.length },
                 { label: 'TOTAL NET WEIGHT (MT)', value: mtS(sum(rows)) }, { label: 'ACCEPTED NET (MT)', value: mtS(sum(acc)), color: GREEN }, { label: 'REJECTED NET (MT)', value: mtS(sum(rej)), color: RED }], 46);
        d.footers();
        return await d.pdf.build(password);
    }

    function initUnloadingScreen() {
        initDayReportCard();
        setupUnloadingCameraScanner();
        renderUnloadingLog();

        const btn = document.getElementById('btn-unloading-lookup');
        const input = document.getElementById('unloading-manual-input');
        if (btn) btn.onclick = () => lookupUnloadingStatus(input.value.trim());
        if (input) input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); lookupUnloadingStatus(input.value.trim()); }
        };

        const unloadingTare = document.getElementById('unloading-weight-tare');
        if (unloadingTare) {
            unloadingTare.oninput = calculateUnloadingNet;
        }

        const unloadingForm = document.getElementById('unloading-weight-form');
        if (unloadingForm) {
            unloadingForm.onsubmit = async function(e) {
                e.preventDefault();
                const id = document.getElementById('unloading-weight-truck-id').value;
                const gross = document.getElementById('unloading-weight-gross').value;
                const tare = unloadingTare.value;

                try {
                    const res = await window.BiomassAPI.updateWeighment(id, gross, tare);
                    if (res.success) {
                        alert('Final weight submitted and entry updated successfully.');
                        document.getElementById('unloading-result-card').style.display = 'none';
                        renderUnloadingLog();
                    } else {
                        alert('Submission failed: ' + res.message);
                    }
                } catch (err) {
                    alert('Communication error: ' + err.message);
                }
            };
        }
    }

    function calculateUnloadingNet() {
        const gross = Number(document.getElementById('unloading-weight-gross').value) || 0;
        const tare = Number(document.getElementById('unloading-weight-tare').value) || 0;
        const net = gross > tare ? (gross - tare) : 0;
        const netDisplay = document.getElementById('unloading-weight-net');
        if (netDisplay) {
            netDisplay.textContent = `${net.toLocaleString()} kg`;
        }
    }

    async function lookupUnloadingStatus(code) {
        if (!code) return;
        const card = document.getElementById('unloading-result-card');
        const banner = document.getElementById('unloading-status-banner');
        const body = document.getElementById('unloading-detail-body');
        card.style.display = 'block';
        banner.style.display = 'block';
        banner.className = 'alert';
        banner.textContent = 'Checking consignment status...';
        body.innerHTML = '';
        try {
            // Unloading works on the TRUCK (Truck ID / vehicle number / the truck QR printed on the weighment slip).
            // A sample-container QR is deliberately not accepted here: it must never lead to a supplier or vehicle.
            const trimmedCode = code.trim();
            const plainId = /^BSW(1F?|2):/.test(trimmedCode) ? await processScannedCode(trimmedCode) : trimmedCode;
            const res = await window.BiomassAPI.getUnloadingStatus(plainId);
            if (!res || res.success === false) throw new Error((res && res.message) || 'Truck not found.');

            const status = res.acceptance_status;
            const weightFormContainer = document.getElementById('unloading-weight-form-container');
            
            if (status === 'ACCEPTED') {
                banner.className = 'alert alert-success';
                banner.style.border = '2px solid #16a34a';
                banner.style.boxShadow = 'none';
                
                const isUnloaded = res.tare_weight !== null && res.tare_weight !== undefined && Number(res.tare_weight) > 0;
                if (isUnloaded) {
                    banner.innerHTML = `
                        <strong>✅ MATERIAL UNLOADED & TARE WEIGHED</strong><br>
                        Tare weight: <strong>${Number(res.tare_weight).toLocaleString()} kg</strong> | Net Delivered: <strong>${Number(res.net_weight).toLocaleString()} kg</strong>.<br>
                        <button type="button" class="btn btn-primary btn-sm mt-2" onclick="window.openTruckWeighmentSlip('${res.truck_id}')" style="background:#10b981; border:none; font-weight:bold;">🖨️ View & Print Weighment Slip</button>
                    `;
                } else {
                    banner.innerHTML = `
                        <strong>🚚 UNLOADING PERMITTED</strong><br>
                        ${res.moisture_limit === null || res.moisture_limit === undefined ? 'No moisture rejection applies to this consignment.' : `Moisture passed (<strong>${res.moisture_pct}%</strong> is below the ${res.moisture_limit}% limit).`} Proceed with biomass unloading.<br>
                        <small style="color:#cbd5e1;">Final tare weight will automatically confirm unloading when captured at exit weighbridge.</small><br>
                        <button type="button" class="btn btn-secondary btn-sm mt-2" onclick="window.openTruckWeighmentSlip('${res.truck_id}')">🖨️ View Inbound Weighment Slip</button>
                    `;
                }
                
                if (weightFormContainer) {
                    weightFormContainer.style.display = 'none';
                }
            } else {
                if (status === 'REJECTED') {
                    banner.className = 'alert alert-danger';
                    banner.style.border = '2px solid #dc2626';
                    banner.style.boxShadow = '0 0 12px #ef4444';
                    banner.innerHTML = `
                        <div style="font-size: 1.25rem; font-weight: 800; color: #ef4444; margin-bottom: 0.5rem; text-align: center; text-transform: uppercase;">
                            ⚠️ REJECTED CONSIGNMENT ⚠️
                        </div>
                        <div style="font-size: 1.1rem; font-weight: 700; margin-bottom: 0.5rem; text-align: center;">
                            TRUCK NO: <span style="background: #ef4444; color: white; padding: 0.2rem 0.6rem; border-radius: 4px; border: 1px solid #ffffff; font-size: 1.2rem; display: inline-block; margin-top: 0.25rem;">${esc(res.truck_reg_number)}</span>
                        </div>
                        <strong>UNLOADING STRICTLY FORBIDDEN</strong><br>
                        Moisture level is <strong>${res.moisture_pct}%</strong> (Maximum allowed: ${res.moisture_limit}%). Do not unload this truck. Weights are recorded exactly as weighed (Net: <strong>${Number(res.net_weight || 0).toLocaleString()} kg</strong>).<br>
                        <button type="button" class="btn btn-secondary btn-sm mt-2" onclick="window.openTruckWeighmentSlip('${res.truck_id}')" style="background:#dc2626; color:white; border:none;">🖨️ Print Rejection Slip</button>
                    `;
                } else if (status === 'CANCELLED') {
                    banner.className = 'alert alert-danger';
                    banner.style.border = '2px solid #6b7280';
                    banner.innerHTML = `<strong>🚫 QR CANCELLED — DO NOT UNLOAD</strong><br>${esc(res.cancel_reason || '')}`;
                } else {
                    banner.className = 'alert alert-warning';
                    banner.style.border = '2px solid #ca8a04';
                    banner.style.boxShadow = 'none';
                    banner.innerHTML = '<strong>PENDING — DO NOT UNLOAD</strong><br>Lab testing is not complete for this truck yet.';
                }
                
                if (weightFormContainer) {
                    weightFormContainer.style.display = 'none';
                }
            }

            const rows = [
                ['Truck ID', `<strong>${esc(res.truck_id)}</strong>`],
                ['Vehicle Reg.', status === 'REJECTED' ? `<span style="background: #ef4444; color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: bold; border: 1px solid white;">${esc(res.truck_reg_number)} (REJECTED)</span>` : `<strong>${esc(res.truck_reg_number)}</strong>`],
                ['Invoice / Challan No.', esc(res.invoice_no || res.challan_no || '-')],
                ['Driver', esc(res.driver_name)],
                ['Moisture %', res.moisture_pct === null ? 'Pending' : (status === 'REJECTED' ? `<strong style="color: #ef4444; font-size: 1.1rem;">${res.moisture_pct}% (Overlimit)</strong>` : `${res.moisture_pct}%`)],
                ['Fineness %', res.fineness_value === null ? 'Pending' : `${res.fineness_value}%`],
                ['Net Weight (kg)', res.net_weight],
                ['Acceptance Status', status === 'REJECTED' ? `<span class="badge badge-danger" style="animation: pulse 1s infinite; font-size: 0.9rem; padding: 0.25rem 0.5rem; display: inline-block;">REJECTED</span>` : `<span class="badge ${status === 'ACCEPTED' ? 'badge-success' : 'badge-warning'}">${status}</span>`]
            ];
            body.innerHTML = rows.map(r => `<tr><th style="text-align:left;">${r[0]}</th><td>${r[1]}</td></tr>`).join('');
        } catch (err) {
            banner.className = 'alert alert-danger';
            banner.textContent = err.message;
        }
    }

    // ================= SESSION ROUTING & CONTROL =================
    function routeSession() {
        // Stop any running camera streams or scanners first
        stopAllCameras();

        const user = window.BiomassAPI.getCurrentUser();
        
        // Hide all screens
        Object.values(screens).forEach(s => s.classList.remove('active'));

        if (!user) {
            appHeader.style.display = 'none';
            screens.login.classList.add('active');
            document.getElementById('login-username').value = '';
            document.getElementById('login-password').value = '';
            return;
        }

        if (user.device && user.device.lock && !user.device.verified) { appHeader.style.display = 'none'; showDeviceBlock(user.device); return; }
        const dbm = document.getElementById('device-block-modal'); if (dbm) dbm.style.display = 'none';

        // Setup Header
        appHeader.style.display = 'flex';
        displayUserName.textContent = user.name;
        displayUserRole.textContent = user.is_super ? 'superadmin' : user.role;

        // Redirect based on role
        if (user.role === 'admin' || user.role === 'entry' || user.role === 'weighment') {
            screens.admin.classList.add('active');
            initAdminDashboard(user.role);
        } else if (user.role === 'lab1' || user.role === 'lab1m' || user.role === 'lab1f') {
            screens.lab1.classList.add('active');
            initLab1Screen();
        } else if (user.role === 'unloading') {
            screens.unloading.classList.add('active');
            initUnloadingScreen();
        } else if (user.role === 'lab2') {
            screens.lab2.classList.add('active');
            initLab2Screen();
        }

        applyRoleBasedPrivileges();
    }

    function applyRoleBasedPrivileges() {
        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;
        
        const btnResetDb = document.getElementById('btn-settings-reset-db');
        if (btnResetDb) {
            if (role === 'admin') {
                btnResetDb.style.display = 'inline-block';
                btnResetDb.removeAttribute('disabled');
            } else {
                btnResetDb.style.display = 'none';
                btnResetDb.setAttribute('disabled', 'true');
            }
        }
        
        const tabBtnActivity = document.getElementById('tab-btn-activity');
        if (tabBtnActivity) {
            tabBtnActivity.style.display = (role === 'admin') ? 'flex' : 'none';
        }
    }

    // Every sign-out does a FULL PAGE RELOAD. This is a blind-testing control, not cosmetics: the app is a
    // single page, so without a reload the previous user's screens (supplier names, truck lists, an open weighment
    // slip...) would stay in the DOM and be visible to - or readable by - the next person who logs in on the
    // same terminal, e.g. a lab technician.
    function hardSignOut(flashMessage) {
        try { if (flashMessage) sessionStorage.setItem('BIOMASS_FLASH', flashMessage); } catch (e) { /* ignore */ }
        window.BiomassAPI.logout();
        window.location.reload();
    }

    // Bind Logout
    btnLogout.addEventListener('click', function() { hardSignOut(); });

    // ---- Session safety ------------------------------------------------------------------
    // There is deliberately NO inactivity sign-out: workers stay signed in until they press Logout.
    // (The session is kept in this device's storage and renewed in the background - see api.js.)
    // Fired by api.js when the Supabase token can no longer be refreshed.
    window.addEventListener('biomass-session-expired', function() {
        if (window.BiomassAPI.getCurrentUser() === null && screens.login.classList.contains('active')) return;
        hardSignOut('Your session has expired. Please sign in again.');
    });

    // Fired by api.js when the server refuses an action because this computer is not approved for the login (the lock was switched on, or the computer was revoked, while the person was working).
    let _devBlockBusy = false;
    window.addEventListener('biomass-device-blocked', async function() {
        if (_devBlockBusy) return;
        _devBlockBusy = true;
        try { const r = await window.BiomassAPI.deviceCheck(); if (r.lock && !r.verified) routeSession(); } finally { _devBlockBusy = false; }
    });

    // Handle Login Submit
    const loginForm = document.getElementById('login-form');
    const loginAlert = document.getElementById('login-alert');

    let __loaderWatchdog = null;
    window.showGlobalLoader = function(msg) {
        const loader = document.getElementById('global-loader');
        const text = document.getElementById('loader-message');
        if (text) text.textContent = msg || 'Loading Terminal Data...';
        if (loader) loader.style.display = 'flex';
        // MOBILE/APK FIX: never let the spinner trap the app forever
        if (__loaderWatchdog) clearTimeout(__loaderWatchdog);
        __loaderWatchdog = setTimeout(function() {
            const l = document.getElementById('global-loader');
            if (l && l.style.display !== 'none') {
                l.style.display = 'none';
                console.warn('Loader auto-dismissed after timeout.');
            }
        }, 30000);
    };

    window.hideGlobalLoader = function() {
        if (__loaderWatchdog) { clearTimeout(__loaderWatchdog); __loaderWatchdog = null; }
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    };

    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        loginAlert.style.display = 'none';
        
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const mfaGroup = document.getElementById('login-mfa-group');
        const inMfaStep = mfaGroup.style.display !== 'none';

        showGlobalLoader('Authenticating credentials & loading dashboard...');

        try {
            // The password goes to Supabase Auth over HTTPS (never hashed client-side, never put in a URL).
            const res = inMfaStep ? await window.BiomassAPI.loginMfa(document.getElementById('login-code').value) : await window.BiomassAPI.login(username, password);
            if (res.success) {
                mfaGroup.style.display = 'none'; document.getElementById('login-code').value = '';
                routeSession();
            } else if (res.mfa_required) {              // the password was right: now the 6-digit code
                mfaGroup.style.display = ''; document.getElementById('login-code').value = '';
                document.getElementById('btn-login-submit').textContent = 'Verify code and sign in';
                document.getElementById('login-code').focus();
            } else {
                loginAlert.textContent = res.message;
                loginAlert.style.display = 'flex';
            }
        } catch (err) {
            loginAlert.textContent = 'Connection error: ' + err.message;
            loginAlert.style.display = 'flex';
        } finally {
            hideGlobalLoader();
        }
    });

    document.getElementById('login-mfa-cancel').onclick = (e) => {
        e.preventDefault();
        window.BiomassAPI.cancelMfa();
        document.getElementById('login-mfa-group').style.display = 'none'; document.getElementById('login-code').value = '';
        document.getElementById('login-password').value = ''; document.getElementById('btn-login-submit').textContent = 'Sign In Securely';
        loginAlert.style.display = 'none';
    };

    // Helper: Stop camera streams and QR readers
    async function stopAllCameras() {
        if (activeCameraStream) {
            activeCameraStream.getTracks().forEach(track => track.stop());
            activeCameraStream = null;
        }
        if (typeof stopScaleCamera === 'function') {
            stopScaleCamera();
        }
        await stopAllSharedScanners();
        const camPanel = document.getElementById('camera-stream-panel');
        if (camPanel) camPanel.style.display = 'none';
    }

    // ================= ADMIN & ENTRY DASHBOARD CONTROLLERS =================
    let companiesSet = new Set();
    let companyRecords = [];       // [{name, po_number, lot}] - one entry per vendor + PO + lot
    const companyLabel = (r) => `${r.name} (PO ${r.po_number || 'not set'} \u00B7 ${lotLabel(r.lot)})`;
    const normName = (v) => stripMs(v).toLowerCase();

    // What did the operator pick / type in the supplier box?
    //   exact    : an entry chosen from the list  -> its name, PO and lot
    //   one      : a typed name that exists under exactly one lot (the lot filter above the box counts)
    //   ambiguous: a typed name that exists under more than one lot (must choose from the list)
    //   otherlot : the name exists, but not under the lot chosen in the filter
    //   new      : a name that is not in the list (the operator must choose its lot)
    let vendorLotFilter = '';          // the constant filter above the supplier box: '' = all lots
    function resolveVendorInput(val) {
        const v = String(val || '').trim();
        const exact = companyRecords.find(r => companyLabel(r) === v);
        if (exact) return { kind: 'exact', rec: exact };
        const allSame = companyRecords.filter(r => normName(r.name) === normName(v));
        const same = vendorLotFilter ? allSame.filter(r => lotMatches(r.lot, vendorLotFilter)) : allSame;
        if (same.length === 1) return { kind: 'one', rec: same[0] };
        if (same.length > 1) return { kind: 'ambiguous', recs: same };
        if (allSame.length) return { kind: 'otherlot', recs: allSame };
        return { kind: 'new' };
    }
    function updateVendorInfo() {
        const input = document.getElementById('reg-company'), box = document.getElementById('reg-vendor-info'), lotGrp = document.getElementById('reg-lot-group');
        if (!input || !box) return;
        const v = input.value.trim();
        if (lotGrp) lotGrp.style.display = 'none';
        if (!v) { box.style.display = 'none'; return; }
        const r = resolveVendorInput(v);
        box.style.display = 'block';
        if (r.kind === 'exact' || r.kind === 'one') {
            const hasBoth = companyRecords.filter(x => normName(x.name) === normName(r.rec.name)).length > 1;
            box.style.background = r.rec.lot === 'LOT4' ? 'rgba(59,130,246,0.18)' : 'rgba(16,185,129,0.15)';
            box.style.border = '1px solid ' + (r.rec.lot === 'LOT4' ? '#3b82f6' : '#10b981');
            box.innerHTML = `Selected: <strong>${esc(r.rec.name)}</strong> &mdash; PO <strong>${esc(r.rec.po_number || 'not set')}</strong> &mdash; <strong>${esc(lotLabel(r.rec.lot))}</strong>` +
                (hasBoth ? '<br><span style="color:#fbbf24;">This vendor also exists under another Lot / PO &mdash; check that this is the right one.</span>' : '');
        } else if (r.kind === 'ambiguous') {
            box.style.background = 'rgba(245,158,11,0.18)'; box.style.border = '1px solid #f59e0b';
            box.innerHTML = '⚠️ This vendor exists under more than one Lot / PO. <strong>Pick the right one from the list</strong> or press the Lot buttons above the box.';
        } else if (r.kind === 'otherlot') {
            box.style.background = 'rgba(245,158,11,0.18)'; box.style.border = '1px solid #f59e0b';
            box.innerHTML = `⚠️ This vendor is <strong>not under ${esc(lotLabel(vendorLotFilter))}</strong>. It exists as: ` + r.recs.map(x => `<strong>${esc(lotLabel(x.lot))}</strong> (PO ${esc(x.po_number || 'not set')})`).join(', ') +
                '. Press <strong>All</strong> or the right lot above the box.';
        } else {
            box.style.background = 'rgba(148,163,184,0.15)'; box.style.border = '1px solid #94a3b8';
            box.innerHTML = 'New supplier (not in the list). Choose its Lot below.';
            if (lotGrp) lotGrp.style.display = '';
            const lotSel = document.getElementById('reg-lot');
            if (lotSel && vendorLotFilter) lotSel.value = vendorLotFilter;      // the filter above the box decides the lot of a new supplier
        }
    }

    // Wide, searchable supplier list (the browser's own drop-down cannot show the whole "NAME (PO ... - LOT)" text)
    let vendorShown = [], vendorActive = -1;
    function renderVendorList(showAll) {
        const box = document.getElementById('reg-vendor-list'), input = document.getElementById('reg-company');
        if (!box || !input) return;
        const q = showAll ? '' : stripMs(input.value.replace(/\s*\(PO .*$/, '')).toLowerCase();
        vendorShown = companyRecords.filter(r => lotMatches(r.lot, vendorLotFilter) && (!q || (stripMs(r.name) + ' ' + r.name + ' ' + (r.po_number || '')).toLowerCase().includes(q))).slice(0, 300);
        vendorActive = -1;
        box.innerHTML = vendorShown.length
            ? vendorShown.map((r, i) => `<div class="vendor-item" data-i="${i}"><span class="vendor-name">${esc(r.name)}</span>` +
                `<span class="vendor-meta"><span class="lot-tag ${lotCls(r.lot)}">${esc(lotLabel(r.lot))}</span> &nbsp;PO ${esc(r.po_number || 'not set')}</span></div>`).join('')
            : '<div class="vendor-empty">No vendor matches' + (vendorLotFilter ? ' under ' + esc(lotLabel(vendorLotFilter)) : '') + '. You can still type a new supplier name.</div>';
    }
    function showVendorList(showAll) { const box = document.getElementById('reg-vendor-list'); if (box) { renderVendorList(showAll); box.style.display = 'block'; } }
    function hideVendorList() { const box = document.getElementById('reg-vendor-list'); if (box) box.style.display = 'none'; }
    function pickVendor(i) {
        const rec = vendorShown[i], input = document.getElementById('reg-company');
        if (!rec || !input) return;
        input.value = companyLabel(rec);
        hideVendorList();
        updateVendorInfo();
    }
    (function wireVendorInput() {
        const input = document.getElementById('reg-company'), box = document.getElementById('reg-vendor-list'), filter = document.getElementById('reg-lot-filter');
        if (!input || !box) return;
        input.addEventListener('input', () => { updateVendorInfo(); showVendorList(false); });
        input.addEventListener('change', updateVendorInfo);
        input.addEventListener('focus', () => showVendorList(false));
        input.addEventListener('blur', () => setTimeout(hideVendorList, 180));
        input.addEventListener('keydown', (e) => {
            const open = box.style.display !== 'none';
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (!open) showVendorList(false);
                if (!vendorShown.length) return;
                e.preventDefault();
                vendorActive = (vendorActive + (e.key === 'ArrowDown' ? 1 : -1) + vendorShown.length) % vendorShown.length;
                [...box.querySelectorAll('.vendor-item')].forEach((el, i) => el.classList.toggle('active', i === vendorActive));
                const act = box.querySelector('.vendor-item.active'); if (act) act.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && open && vendorActive >= 0) {
                e.preventDefault(); pickVendor(vendorActive);
            } else if (e.key === 'Escape') { hideVendorList(); }
        });
        box.addEventListener('mousedown', (e) => {                    // mousedown: it fires before the input loses focus
            const it = e.target.closest('.vendor-item');
            if (it) { e.preventDefault(); pickVendor(Number(it.getAttribute('data-i'))); }
        });
        if (filter) filter.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-lot]');
            if (!b) return;
            vendorLotFilter = b.getAttribute('data-lot') || '';
            [...filter.querySelectorAll('button')].forEach(x => x.classList.toggle('active', x === b));
            updateVendorInfo();
            showVendorList(false);
            input.focus();
        });
    })();

    function initAdminDashboard(role) {
        const tabs = document.querySelectorAll('#screen-admin .tab-btn');
        const tabContents = document.querySelectorAll('#screen-admin .tab-content');
        const cu = window.BiomassAPI.getCurrentUser();
        const isSuper = !!(cu && cu.is_super);

        // Apply menu item visibility based on role (Entry Operator sees ONLY registration, Weighment sees ONLY weighment)
        tabs.forEach(tab => {
            const dataTab = tab.getAttribute('data-tab');
            if (role === 'entry') {
                if (dataTab !== 'admin-register' && dataTab !== 'admin-bottom') {
                    tab.style.display = 'none';
                } else {
                    tab.style.display = 'flex';
                }
            } else if (role === 'weighment') {
                if (dataTab !== 'admin-weighment') {
                    tab.style.display = 'none';
                } else {
                    tab.style.display = 'flex';
                }
            } else if (isSuper) {
                // the Super Admin login has NO Admin features: its own console + the (read-only) audit log
                tab.style.display = (dataTab.startsWith('super-') || dataTab === 'admin-activity') ? 'flex' : 'none';
            } else {
                tab.style.display = dataTab.startsWith('super-') ? 'none' : 'flex'; // admin sees everything except the Super Admin console
            }
        });

        // Force other tab contents to hide completely
        tabContents.forEach(content => {
            const id = content.getAttribute('id');
            if (role === 'entry') {
                if (id !== 'tab-admin-register' && id !== 'tab-admin-bottom') {
                    content.style.setProperty('display', 'none', 'important');
                } else {
                    content.style.display = '';
                }
            } else if (role === 'weighment') {
                if (id !== 'tab-admin-weighment') {
                    content.style.setProperty('display', 'none', 'important');
                } else {
                    content.style.display = '';
                }
            } else {
                content.style.display = ''; // reset to default active rules for Admin
            }
        });

        // If Entry role, force the registration tab active and hide others
        if (role === 'entry') {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            const regTab = document.querySelector('#screen-admin .tab-btn[data-tab="admin-register"]');
            if (regTab) {
                regTab.classList.add('active');
                document.getElementById('tab-admin-register').classList.add('active');
            }
        }

        // If Weighment role, force the weighment tab active and hide others
        if (role === 'weighment') {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            const weighTab = document.querySelector('#screen-admin .tab-btn[data-tab="admin-weighment"]');
            if (weighTab) {
                weighTab.classList.add('active');
                document.getElementById('tab-admin-weighment').classList.add('active');
            }
            // MOBILE/APK FIX: tab clicks are blocked for this role, so load the data here
            renderWeighmentLog();
        }

        if (isSuper) {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            const first = document.getElementById('tab-btn-sx-inspector');
            if (first) first.classList.add('active');
            document.getElementById('tab-super-inspector').classList.add('active');
            const lbl = document.getElementById('activity-tab-label');
            if (lbl) lbl.textContent = '📜 Audit Log';
            initSuperConsole();
        }

        if ((role === 'admin' && !isSuper) || role === 'entry') {
            loadRecentRegistrations();
            initBottomSamples();
        }

        if (role === 'admin') initAuditButtons();
        if (role === 'admin' && !isSuper) {
            refreshSuperAlert();
            if (!window.__superAlertTimer) window.__superAlertTimer = setInterval(() => { if (!document.hidden) refreshSuperAlert(); }, 60000);
        }

        if (role === 'admin' && !isSuper) {
            autoFreeStorageIfEnabled();
            const activeTab = document.querySelector('#screen-admin .tab-btn.active');
            const dataTab = activeTab ? activeTab.getAttribute('data-tab') : 'admin-dashboard';
            if (dataTab === 'admin-dashboard') {
                initExecutiveDashboard();
            }
        }

        tabs.forEach(tab => {
            tab.removeEventListener('click', handleTabClick);
            tab.addEventListener('click', handleTabClick);
        });

        function handleTabClick(e) {
            // SECURITY: Weighment never switches tabs; Entry may only switch between Truck Registration and Bottom Samples
            if (role === 'weighment') {
                e.preventDefault();
                return;
            }
            if (role === 'entry') {
                const dt = e.currentTarget.getAttribute('data-tab');
                if (dt !== 'admin-register' && dt !== 'admin-bottom') { e.preventDefault(); return; }
            }

            const clickedTab = e.currentTarget;
            const targetContentId = `tab-${clickedTab.getAttribute('data-tab')}`;

            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            clickedTab.classList.add('active');
            const targetEl = document.getElementById(targetContentId);
            if (targetEl) targetEl.classList.add('active');

            // Hook for refreshing specific tabs on click
            if (targetContentId === 'tab-admin-dashboard') {
                initExecutiveDashboard();
            } else if (targetContentId === 'tab-admin-register') {
                if (role === 'admin') {
                    initAdminQrLookupTab();
                } else if (role === 'entry') {
                    loadRecentRegistrations();
                }
            } else if (targetContentId === 'tab-admin-bottom') {
                renderBottomList();
            } else if (targetContentId === 'tab-admin-weighment') {
                renderWeighmentLog();
            } else if (targetContentId === 'tab-admin-reports') {
                loadReportSelectors();
            } else if (targetContentId === 'tab-admin-inspector') {
                initAdminInspectorTab();
            } else if (targetContentId === 'tab-admin-referee') {
                loadRefereeChallengeTable();
            } else if (targetContentId === 'tab-admin-vendors') {
                initVendorsTab();
            } else if (targetContentId === 'tab-admin-training') {
                initReaderTrainingTab();
            } else if (targetContentId === 'tab-super-inspector') {
                initSuperConsole();
            } else if (targetContentId === 'tab-super-tools') {
                renderSuperTools();
            } else if (targetContentId === 'tab-super-health') {
                if (!document.getElementById('sx-health-body').innerHTML.trim()) renderSuperHealth();
            } else if (targetContentId === 'tab-super-ips') {
                renderSuperIps();
            } else if (targetContentId === 'tab-super-logins') {
                renderSuperLogins();
            } else if (targetContentId === 'tab-super-passwords') {
                renderSuperPasswords();
            } else if (targetContentId === 'tab-super-security') {
                renderSuperSecurity();
            } else if (targetContentId === 'tab-admin-activity') {
                renderActivityLogTab();
                refreshSuperAlert();
            } else if (targetContentId === 'tab-admin-settings') {
                initStorageCard();
                initMixResetCard();
                renderMfaBox(document.getElementById('mfa-admin-box'), false);
            }
        }

        // Initialize Registration view options
        loadSupplierDataLists();
        setupRegistrationCamera();
    }

    async function initAdminQrLookupTab() {
        const adminLookupCard = document.getElementById('admin-qr-lookup-card');
        const recentRegCard = document.getElementById('recent-registrations-card');
        if (adminLookupCard) adminLookupCard.style.display = 'block';
        if (recentRegCard) recentRegCard.style.display = 'none';
        try {
            const trucks = await window.BiomassAPI.getTrucks();
            setupAdminQrLookup(trucks);
        } catch (err) {
            console.error('Failed to initialize Admin QR lookup:', err);
        }
    }

    // ================= ADMIN: REFEREE CHALLENGE TAB =================
    let allRefereeCompositeBatches = [];

    async function loadRefereeChallengeTable() {
        const tbody = document.getElementById('referee-challenge-table-body');
        const countSpan = document.getElementById('referee-records-count');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading composite lot history...</td></tr>';

        try {
            const batches = await window.BiomassAPI.getCompositeBatches();
            allRefereeCompositeBatches = batches;
            renderRefereeTableRows(batches);
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger); padding: 1.5rem;">Failed to load composite history: ${esc(err.message)}</td></tr>`;
        }
    }

    function renderRefereeTableRows(batches) {
        const tbody = document.getElementById('referee-challenge-table-body');
        const countSpan = document.getElementById('referee-records-count');
        if (!tbody) return;

        const searchVal = (document.getElementById('referee-search-input')?.value || '').trim().toLowerCase();
        
        let filtered = batches;
        if (searchVal) {
            filtered = batches.filter(b => {
                const group = String(b.daily_group_code || '').toLowerCase();
                const ref = String(b.composite_ref_id || '').toLowerCase();
                const company = String(b.company_name || '').toLowerCase();
                const date = String(b.date || '').toLowerCase();
                return group.includes(searchVal) || ref.includes(searchVal) || company.includes(searchVal) || date.includes(searchVal);
            });
        }

        if (countSpan) countSpan.textContent = `Showing ${filtered.length} composite lots`;
        tbody.innerHTML = '';

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No matching composite lots found.</td></tr>';
            return;
        }

        filtered.forEach(batch => {
            const tr = document.createElement('tr');

            const refId = batch.composite_ref_id || batch.daily_group_code || 'N/A';
            const groupCode = batch.daily_group_code || refId;
            const companyName = batch.company_name || 'N/A';
            const sampleDate = batch.date || 'N/A';

            // 1. NTPC GCV
            const ntpcGcv = (batch.gcv_value !== null && batch.gcv_value !== undefined && batch.gcv_value !== "") 
                ? `<strong>${batch.gcv_value}</strong> kcal/kg` 
                : '<span style="color: #94a3b8; font-style: italic;">Pending Lab 2</span>';

            // 2. Vendor GCV
            const hasVendorGcv = (batch.vendor_gcv !== null && batch.vendor_gcv !== undefined && batch.vendor_gcv !== "");
            let vendorGcvHtml = '';
            if (hasVendorGcv) {
                vendorGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="number" value="${batch.vendor_gcv}" disabled style="width: 100px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid #cbd5e1; background: var(--bg-card); font-weight: bold; color: var(--text-color);">
                        <span class="badge badge-success" style="font-size: 0.75rem;">Locked</span>
                    </div>
                `;
            } else {
                vendorGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" id="input-vendor-gcv-${refId}" placeholder="e.g. 4300" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color);">
                        <button class="btn btn-primary btn-sm btn-save-vendor-gcv" data-ref-id="${refId}" style="padding: 0.35rem 0.6rem; font-size: 0.8rem;">Save</button>
                    </div>
                `;
            }

            // 3. Challenge Status & Trigger Button
            const isChallenged = (batch.referee_status === 'CHALLENGED' || batch.referee_status === 'RESOLVED');
            const isResolved = (batch.referee_status === 'RESOLVED' || (batch.referee_gcv !== null && batch.referee_gcv !== undefined && batch.referee_gcv !== ""));

            let challengeBtnHtml = '';
            if (!hasVendorGcv) {
                challengeBtnHtml = '<span style="color: #94a3b8; font-size: 0.85rem; font-style: italic;">Enter Vendor GCV first</span>';
            } else if (!isChallenged) {
                challengeBtnHtml = `
                    <button class="btn btn-warning btn-sm btn-trigger-challenge" data-ref-id="${refId}" style="background: #ea580c; border: none; color: white; font-weight: bold; padding: 0.4rem 0.75rem;">
                        ⚖️ Challenge Referee
                    </button>
                `;
            } else {
                challengeBtnHtml = `<span class="badge badge-warning" style="background: #f59e0b; color: white; font-weight: bold;">Referee Challenged</span>`;
            }

            // 4. Referee GCV
            let refereeGcvHtml = '';
            if (isResolved) {
                refereeGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="number" value="${batch.referee_gcv}" disabled style="width: 100px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid #10b981; background: rgba(16, 185, 129, 0.1); font-weight: bold; color: #047857;">
                        <span class="badge badge-success" style="font-size: 0.75rem;">Locked</span>
                    </div>
                `;
            } else if (isChallenged) {
                refereeGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" id="input-referee-gcv-${refId}" placeholder="e.g. 4320" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color);">
                        <button class="btn btn-success btn-sm btn-save-referee-gcv" data-ref-id="${refId}" style="padding: 0.35rem 0.6rem; font-size: 0.8rem; background: #10b981; border: none;">Save</button>
                    </div>
                `;
            } else {
                refereeGcvHtml = '<input type="number" disabled placeholder="Locked" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); opacity: 0.5;">';
            }

            // 5. Overall Status Badge
            let statusBadgeHtml = '';
            if (isResolved) {
                statusBadgeHtml = '<span class="badge badge-success" style="background: #10b981; color: white;">Referee Resolved</span>';
            } else if (isChallenged) {
                statusBadgeHtml = '<span class="badge badge-warning" style="background: #f59e0b; color: white;">Challenge Pending</span>';
            } else if (hasVendorGcv) {
                statusBadgeHtml = '<span class="badge badge-info" style="background: #3b82f6; color: white;">Ready for Challenge</span>';
            } else {
                statusBadgeHtml = '<span class="badge badge-pending" style="background: #64748b; color: white;">Pending Vendor GCV</span>';
            }

            tr.innerHTML = `
                <td><span class="badge badge-referee" style="font-weight: bold; font-size: 0.9rem;">${esc(groupCode)}</span></td>
                <td><strong>${esc(companyName)}</strong></td>
                <td>${sampleDate}</td>
                <td>${ntpcGcv}</td>
                <td>${vendorGcvHtml}</td>
                <td>${challengeBtnHtml}</td>
                <td>${refereeGcvHtml}</td>
                <td>${statusBadgeHtml}</td>
            `;

            tbody.appendChild(tr);
        });

        // Attach Event Listeners
        document.querySelectorAll('.btn-save-vendor-gcv').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const valInput = document.getElementById(`input-vendor-gcv-${refId}`);
                const val = valInput ? valInput.value.trim() : '';

                if (!val || isNaN(val) || Number(val) <= 0) {
                    alert('Please enter a valid Vendor GCV value (kcal/kg).');
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.textContent = 'Saving...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { vendorGcv: Number(val) });
                    alert(`Vendor GCV (${val} kcal/kg) saved and locked successfully!`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to save Vendor GCV: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            };
        });

        document.querySelectorAll('.btn-trigger-challenge').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const confirmChoice = confirm(`Are you sure you want to flag Mixing Group / Lot "${refId}" for REFEREE CHALLENGE?\n\nThis will unlock the Referee GCV field for entering third-party test results.`);
                if (!confirmChoice) return;

                try {
                    btn.disabled = true;
                    btn.textContent = 'Challenging...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { refereeStatus: 'CHALLENGED' });
                    alert(`Lot "${refId}" is now flagged for Referee Challenge! You can now enter the third-party Referee GCV.`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to trigger Referee Challenge: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = '⚖️ Challenge Referee';
                }
            };
        });

        document.querySelectorAll('.btn-save-referee-gcv').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const valInput = document.getElementById(`input-referee-gcv-${refId}`);
                const val = valInput ? valInput.value.trim() : '';

                if (!val || isNaN(val) || Number(val) <= 0) {
                    alert('Please enter a valid Referee GCV value (kcal/kg).');
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.textContent = 'Saving...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { refereeGcv: Number(val), refereeStatus: 'RESOLVED' });
                    alert(`Referee GCV (${val} kcal/kg) saved and locked successfully! Lot challenge is now resolved.`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to save Referee GCV: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            };
        });
    }

    document.getElementById('btn-refresh-referee')?.addEventListener('click', loadRefereeChallengeTable);
    document.getElementById('referee-search-input')?.addEventListener('input', () => {
        renderRefereeTableRows(allRefereeCompositeBatches);
    });

    // Re-populates a supplier <select> with only the companies that actually had a truck entry on
    // `dateStr` (empty dateStr = every known supplier). Keeps the current selection if still valid.
    async function filterSuppliersByDate(selectId, dateStr, placeholderHtml) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const prevVal = sel.value;
        try {
            let names;
            if (dateStr) {
                const trucks = await window.BiomassAPI.getTrucks({ fromDate: dateStr, toDate: dateStr });
                names = Array.from(new Set(trucks.map(t => t.company_name).filter(Boolean))).sort();
            } else {
                names = Array.from(companiesSet).sort();
            }
            sel.innerHTML = placeholderHtml;
            names.forEach(n => {
                const o = document.createElement('option');
                o.value = n;
                o.textContent = n;
                sel.appendChild(o);
            });
            if (names.includes(prevVal)) sel.value = prevVal;
        } catch (e) {
            console.error('Failed to filter suppliers by date:', e);
        }
    }
    document.getElementById('report-select-date')?.addEventListener('change', function() {
        filterSuppliersByDate('report-select-company', this.value, '<option value="">-- Choose Supplier --</option>');
    });
    document.getElementById('comm-report-date')?.addEventListener('change', function() {
        filterSuppliersByDate('comm-report-company', this.value, '<option value="ALL">All Suppliers / Consolidated</option>');
    });

    async function loadSupplierDataLists() {
        try {
            const compSelect = document.getElementById('comp-select-company');
            const reportSelect = document.getElementById('report-select-company');
            const commSelect = document.getElementById('comm-report-company');
            
            const prevCompVal = compSelect ? compSelect.value : '';
            const prevReportVal = reportSelect ? reportSelect.value : '';
            const prevCommVal = commSelect ? commSelect.value : '';

            const companies = await window.BiomassAPI.getCompanies();
            companies.forEach(c => companiesSet.add(c));
            
            const sortedCompanies = Array.from(companiesSet).sort();

            const datalist = document.getElementById('companies-list');
            datalist.innerHTML = '';
            // The supplier list shows each vendor with its PO and lot in brackets (a vendor can exist under both lots)
            try { companyRecords = await window.BiomassAPI.getCompaniesDetailed(); } catch (e) { companyRecords = []; }
            
            if (compSelect) compSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';
            if (reportSelect) reportSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';
            if (commSelect) commSelect.innerHTML = '<option value="ALL">All Suppliers / Consolidated</option>';

            renderVendorList();
            sortedCompanies.forEach(company => {
                // (datalist options are built from companyRecords above)

                // Dropdown options
                if (compSelect) {
                    const opt1 = document.createElement('option');
                    opt1.value = company;
                    opt1.textContent = company;
                    compSelect.appendChild(opt1);
                }

                if (reportSelect) {
                    const opt2 = document.createElement('option');
                    opt2.value = company;
                    opt2.textContent = company;
                    reportSelect.appendChild(opt2);
                }

                if (commSelect) {
                    const opt3 = document.createElement('option');
                    opt3.value = company;
                    opt3.textContent = company;
                    commSelect.appendChild(opt3);
                }
            });

            // Preserve selections
            if (compSelect && prevCompVal) compSelect.value = prevCompVal;
            if (reportSelect && prevReportVal) reportSelect.value = prevReportVal;
            if (commSelect && prevCommVal) commSelect.value = prevCommVal;

            const commDateInput = document.getElementById('comm-report-date');
            if (commDateInput && !commDateInput.value) {
                commDateInput.value = window.BiomassAPI.todayIST();
            }
            if (commDateInput && commDateInput.value) {
                await filterSuppliersByDate('comm-report-company', commDateInput.value, '<option value="ALL">All Suppliers / Consolidated</option>');
            }
        } catch (e) {
            console.error('Failed to load companies list:', e);
        }
    }

    async function loadRecentRegistrations() {
        const user = window.BiomassAPI.getCurrentUser();
        if (!user) return;
        
        const tbody = document.getElementById('recent-reg-table-body');
        const cardTitle = document.getElementById('recent-reg-card-title');
        const adminLookupCard = document.getElementById('admin-qr-lookup-card');
        const recentRegCard = document.getElementById('recent-registrations-card');

        // Admin: strictly remove/hide the recent registrations table from the entry tab, show historical QR search station
        if (user.role === 'admin') {
            if (recentRegCard) recentRegCard.style.display = 'none';
            if (adminLookupCard) {
                adminLookupCard.style.display = 'block';
                try {
                    const trucks = await window.BiomassAPI.getTrucks();
                    setupAdminQrLookup(trucks);
                } catch (err) {
                    console.error('Failed to load trucks for admin QR lookup:', err);
                }
            }
            return;
        }

        // Entry operator: show today's registrations table, hide admin QR lookup station
        if (adminLookupCard) adminLookupCard.style.display = 'none';
        if (recentRegCard) recentRegCard.style.display = 'block';
        if (cardTitle) cardTitle.textContent = "Today's Registered Trucks (Gate Entry)";
        if (!tbody) return;

        try {
            const trucks = await window.BiomassAPI.getTrucks();
            const todayStr = window.BiomassAPI.formatLocalYYYYMMDD(new Date());
            
            // Strictly today's registered trucks for entry operator
            let filtered = trucks.filter(t => t.entry_date === todayStr);
            
            // Sort newest registrations first
            filtered.sort((a, b) => {
                const dateA = new Date(a.entry_date + 'T' + (a.entry_time || '00:00'));
                const dateB = new Date(b.entry_date + 'T' + (b.entry_time || '00:00'));
                return dateB - dateA;
            });
            
            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No registered trucks found for today (${todayStr}).</td></tr>`;
                return;
            }
            
            tbody.innerHTML = '';
            filtered.forEach(truck => {
                const tr = document.createElement('tr');
                
                const chNo = truck.invoice_no || truck.challan_no || '-';
                // Deliberately NO sample barcode, mixing group, QR view or reprint here: once the label has been
                // printed at registration, only the Admin login can look a sample QR up (blind-testing rule).
                tr.innerHTML = `
                    <td style="font-weight: bold;">${esc(truck.truck_id)}</td>
                    <td>${esc(truck.entry_date)} ${esc((truck.entry_time || '').substring(0, 5))}</td>
                    <td>${esc(truck.company_name)}</td>
                    <td>${esc(truck.truck_reg_number)}</td>
                    <td><span style="font-family: monospace;">${esc(chNo)}</span></td>
                    <td>${esc(truck.driver_name)}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (err) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger);">Failed to load recent registrations: ${esc(err.message)}</td></tr>`;
        }
    }

    function setupAdminQrLookup(trucks) {
        const dateInput = document.getElementById('admin-lookup-date');
        const supplierSelect = document.getElementById('admin-lookup-supplier');
        const truckSelect = document.getElementById('admin-lookup-truck');
        const btnSubmit = document.getElementById('btn-admin-lookup-submit');
        const btnClearDate = document.getElementById('btn-admin-lookup-clear-date');
        const countSpan = document.getElementById('admin-lookup-count');
        const resultPanel = document.getElementById('admin-lookup-result');
        const truckInfoDiv = document.getElementById('admin-lookup-truck-info');
        const btnPrint = document.getElementById('btn-admin-lookup-print');
        const btnDownload = document.getElementById('btn-admin-lookup-download');

        if (!dateInput || !supplierSelect || !truckSelect || !btnSubmit) return;

        // Intelligent default date: if today has trucks, choose today; otherwise choose latest recorded date
        if (!dateInput.value) {
            const todayStr = window.BiomassAPI.formatLocalYYYYMMDD(new Date());
            const hasToday = trucks && trucks.some(t => t.entry_date === todayStr);
            if (hasToday) {
                dateInput.value = todayStr;
            } else if (trucks && trucks.length > 0) {
                const dates = trucks.map(t => t.entry_date).filter(Boolean).sort().reverse();
                dateInput.value = dates[0] || '';
            } else {
                dateInput.value = '';
            }
        }

        function refreshLookupDropdowns() {
            const chosenDate = dateInput.value;
            const dateTrucks = chosenDate ? trucks.filter(t => t.entry_date === chosenDate) : trucks;
            
            if (countSpan) {
                countSpan.textContent = `(${dateTrucks.length} record${dateTrucks.length === 1 ? '' : 's'}${chosenDate ? ' on ' + chosenDate : ' total'})`;
            }

            const suppliers = [...new Set(dateTrucks.map(t => t.company_name).filter(Boolean))].sort();
            const prevSupplier = supplierSelect.value;
            supplierSelect.innerHTML = `<option value="ALL">All Suppliers on Date (${suppliers.length})</option>`;
            suppliers.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s;
                opt.textContent = s;
                supplierSelect.appendChild(opt);
            });
            if (suppliers.includes(prevSupplier)) {
                supplierSelect.value = prevSupplier;
            } else {
                supplierSelect.value = 'ALL';
            }

            refreshTruckDropdown();
        }

        function refreshTruckDropdown() {
            const chosenDate = dateInput.value;
            const chosenSupplier = supplierSelect.value;
            let list = chosenDate ? trucks.filter(t => t.entry_date === chosenDate) : trucks;
            if (chosenSupplier && chosenSupplier !== 'ALL') {
                list = list.filter(t => t.company_name === chosenSupplier);
            }

            // Sort newest first
            list.sort((a, b) => {
                const dateA = (a.entry_date || '') + 'T' + (a.entry_time || '00:00');
                const dateB = (b.entry_date || '') + 'T' + (b.entry_time || '00:00');
                return dateB.localeCompare(dateA);
            });

            truckSelect.innerHTML = `<option value="">-- Select Truck (${list.length} found) --</option>`;
            list.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.truck_id;
                const ch = t.invoice_no || t.challan_no || '';
                const reg = t.truck_reg_number || t.truck_id;
                const dateTag = (!chosenDate && t.entry_date) ? ` [${t.entry_date}]` : '';
                opt.textContent = `${reg} | ${t.company_name || 'Unknown'} ${ch ? '('+ch+')' : ''}${dateTag}`;
                truckSelect.appendChild(opt);
            });
        }

        dateInput.onchange = refreshLookupDropdowns;
        supplierSelect.onchange = refreshTruckDropdown;

        if (btnClearDate) {
            btnClearDate.onclick = function(e) {
                e.preventDefault();
                dateInput.value = '';
                refreshLookupDropdowns();
            };
        }

        refreshLookupDropdowns();

        btnSubmit.onclick = async function() {
            const truckId = truckSelect.value;
            if (!truckId) {
                alert('Please select a truck from the dropdown list.');
                return;
            }
            const truck = trucks.find(t => t.truck_id === truckId);
            if (!truck) {
                alert('Truck record not found.');
                return;
            }

            if (truckInfoDiv) {
                truckInfoDiv.innerHTML = `
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem;">
                        <div><strong>Truck ID:</strong> <span style="font-family: monospace; color: #60a5fa;">${truck.truck_id}</span></div>
                        <div><strong>Vehicle Number:</strong> <span style="font-weight: bold; color: white;">${esc(truck.truck_reg_number || '-')}</span></div>
                        <div><strong>Biomass Supplier:</strong> <span style="color: #cbd5e1;">${esc(truck.company_name || '-')}</span></div>
                        <div><strong>Driver Name:</strong> <span style="color: #cbd5e1;">${esc(truck.driver_name || '-')}</span></div>
                        <div><strong>Challan / Invoice:</strong> <span style="font-family: monospace; color: #cbd5e1;">${esc(truck.invoice_no || truck.challan_no || '-')}</span></div>
                        <div><strong>Registration Date/Time:</strong> <span style="color: #cbd5e1;">${truck.entry_date} ${truck.entry_time || ''}</span></div>
                        <div><strong>Sample-1 Opaque Barcode:</strong> <span style="font-family: monospace; color: #10b981;">${truck.sample1_barcode_id}</span></div>
                        <div><strong>Daily Group Code:</strong> <span class="badge badge-complete">${truck.daily_group_code || 'N/A'}</span></div>
                    </div>
                `;
            }

            const encrypted = await encryptPayload(truck.sample1_barcode_id);
            const canvasTarget = document.getElementById('qr-canvas-admin-lookup');
            if (canvasTarget) {
                QRCode.toCanvas(canvasTarget, encrypted, {
                    errorCorrectionLevel: 'M',
                    width: 246,
                    margin: 4
                }, function(err) {
                    if (err) console.error('QR canvas rendering error:', err);
                });
            }

            if (btnPrint) {
                // same label as the Entry login prints (QR + date, no serial number, 4x6 / 50x50 mm format)
                btnPrint.onclick = () => window.printSampleLabel(truck.sample1_barcode_id, truck.entry_date);
            }

            if (btnDownload) {
                btnDownload.onclick = function() {
                    downloadQrAsPng('#qr-canvas-admin-lookup', `Sample_1_${truck.sample1_barcode_id}`, dmy(truck.entry_date), truck.sample1_barcode_id, false);
                };
            }

            if (resultPanel) {
                resultPanel.style.display = 'block';
                resultPanel.scrollIntoView({ behavior: 'smooth' });
            }
        };
    }

    // --- Admin: Camera Capture integration ---
    function setupRegistrationCamera() {
        const btnTrigger = document.getElementById('btn-trigger-camera');
        const btnSnap = document.getElementById('btn-snap-photo');
        const btnCancel = document.getElementById('btn-cancel-photo');
        const btnDelete = document.getElementById('btn-delete-photo');
        const videoFeed = document.getElementById('webcam-feed');
        
        const cameraPanel = document.getElementById('camera-stream-panel');
        const previewPanel = document.getElementById('captured-preview-panel');
        const photoStatus = document.getElementById('photo-status');
        const capturedImg = document.getElementById('captured-image-img');

        function stopCameraStream() {
            if (activeCameraStream) {
                activeCameraStream.getTracks().forEach(track => track.stop());
                activeCameraStream = null;
            }
            if (cameraPanel) cameraPanel.style.display = 'none';
        }

        if (btnTrigger) {
            btnTrigger.onclick = async function() {
                try {
                    if (previewPanel) previewPanel.style.display = 'none';
                    if (cameraPanel) cameraPanel.style.display = 'block';
                    
                    activeCameraStream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'environment', width: 640, height: 480 }
                    });
                    if (videoFeed) videoFeed.srcObject = activeCameraStream;
                } catch (err) {
                    console.error('Webcam access error:', err);
                    alert('Could not start webcam stream. Please make sure camera permissions are enabled.');
                    if (cameraPanel) cameraPanel.style.display = 'none';
                }
            };
        }

        if (btnSnap) {
            btnSnap.onclick = function() {
                if (!activeCameraStream || !videoFeed) return;

                const canvas = document.createElement('canvas');
                canvas.width = videoFeed.videoWidth || 640;
                canvas.height = videoFeed.videoHeight || 480;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(videoFeed, 0, 0, canvas.width, canvas.height);
                
                // Compress image to JPEG
                capturedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.7);
                
                if (capturedImg) capturedImg.src = capturedPhotoBase64;
                if (previewPanel) previewPanel.style.display = 'block';
                
                if (photoStatus) {
                    photoStatus.textContent = 'Photo Attached';
                    photoStatus.classList.remove('badge-pending');
                    photoStatus.classList.add('badge-complete');
                }

                stopCameraStream();
            };
        }

        if (btnCancel) {
            btnCancel.onclick = stopCameraStream;
        }

        if (btnDelete) {
            btnDelete.onclick = function() {
                capturedPhotoBase64 = '';
                if (capturedImg) capturedImg.src = '';
                if (previewPanel) previewPanel.style.display = 'none';
                if (photoStatus) {
                    photoStatus.textContent = 'No Photo Attached';
                    photoStatus.classList.remove('badge-complete');
                    photoStatus.classList.add('badge-pending');
                }
            };
        }
    }

    // Read-back dialog shown before a truck is saved; resolves true only when the operator presses the confirm button
    function confirmRegistrationDetails(data, isNewSupplier) {
        return new Promise((resolve) => {
            const modal = document.getElementById('regconfirm-modal'), rows = document.getElementById('regconfirm-rows'), warn = document.getElementById('regconfirm-warn');
            const okBtn = document.getElementById('btn-regconfirm-ok'), backBtn = document.getElementById('btn-regconfirm-back');
            const line = (k, v, strong) => `<div style="color:#94a3b8;">${k}</div><div style="${strong ? 'font-weight:800; font-size:1.15rem; letter-spacing:0.5px;' : 'font-weight:600;'} word-break:break-word;">${v}</div>`;
            const lotTxt = esc(lotLabel(data.lot)) + (isNewSupplier ? ' <span style="color:#fbbf24; font-weight:600;">(new supplier)</span>' : '');
            rows.innerHTML = line('Supplier', esc(data.company_name)) + line('Lot', lotTxt) + line('PO number', esc(data.po_number || '-')) +
                line('Truck number', esc(data.truck_reg_number), true) + line('Driver', esc(data.driver_name)) + line('Invoice / Challan', esc(data.invoice_no)) +
                line('Photo', data.photo_url ? '<span style="color:#10b981;">&#10003; attached</span>' : '<span style="color:#fbbf24;">no photo attached</span>');
            const notes = [];
            if (isNewSupplier) notes.push('This supplier is not in the vendor list and will be created under ' + lotLabel(data.lot) + '. Check the spelling.');
            if (!data.photo_url) notes.push('No driver / truck photo is attached.');
            warn.style.display = notes.length ? 'block' : 'none'; warn.innerHTML = notes.map(n => '&bull; ' + esc(n)).join('<br>');
            const done = (v) => { modal.style.display = 'none'; okBtn.onclick = null; backBtn.onclick = null; resolve(v); };
            okBtn.onclick = () => done(true);
            backBtn.onclick = () => done(false);
            modal.style.display = 'flex';
            backBtn.focus();          // Enter must not confirm by accident
        });
    }

    // Which version of the app is this page? (the ?v= of its own script) - shown small in the corner; a page left open for days checks for a newer one
    const APP_VERSION = (() => { const s = document.querySelector('script[src*="app.js"]'); const m = s && /[?&]v=([^&]+)/.exec(s.getAttribute('src')); return m ? m[1] : 'unknown'; })();
    (function showAppVersion() {
        const tag = document.createElement('div');
        tag.id = 'app-version-tag'; tag.textContent = 'version ' + APP_VERSION;
        tag.style.cssText = 'position:fixed; right:8px; bottom:4px; font-size:0.65rem; color:#94a3b8; opacity:0.7; z-index:50; pointer-events:none;';
        document.body.appendChild(tag);
    })();
    let versionWarned = false;
    async function checkForNewVersion() {
        if (versionWarned) return;
        try {
            const html = await (await fetch('index.html?nc=' + Date.now(), { cache: 'no-store' })).text();
            const m = /app\.js\?v=([^"&]+)/.exec(html);
            if (!m || m[1] === APP_VERSION) return;
            versionWarned = true;
            const bar = document.createElement('div');
            bar.style.cssText = 'position:fixed; left:0; right:0; bottom:0; z-index:99999; background:#b45309; color:#fff; padding:0.7rem 1rem; display:flex; gap:1rem; align-items:center; justify-content:center; flex-wrap:wrap; font-weight:600;';
            bar.innerHTML = 'A newer version of the app is available (' + m[1] + '; this page runs ' + APP_VERSION + '). ';
            const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary btn-sm'; b.textContent = 'Reload now';
            b.onclick = () => location.reload(); bar.appendChild(b);
            document.body.appendChild(bar);
        } catch (e) { /* offline: try again later */ }
    }
    setTimeout(checkForNewVersion, 20000);
    setInterval(checkForNewVersion, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });

    // Coming back to a page that was left open: reload the vendor list so an outdated list is not shown at the gate
    let lastVendorRefresh = Date.now();
    document.addEventListener('visibilitychange', async () => {
        const box = document.getElementById('reg-company');
        if (document.visibilityState !== 'visible' || !box || !box.offsetParent || Date.now() - lastVendorRefresh < 30000) return;
        lastVendorRefresh = Date.now();
        try { companyRecords = await window.BiomassAPI.getCompaniesDetailed(); renderVendorList(); updateVendorInfo(); } catch (e) { /* keep the list we have */ }
    });

    // --- Admin: Handle Truck Registration Submit ---
    const truckRegForm = document.getElementById('truck-reg-form');
    if (truckRegForm) {
        truckRegForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const vehicle = document.getElementById('reg-vehicle').value.trim();
            if (!vehicle) {
                alert('Please enter a vehicle registration number.');
                return;
            }

            // The vendor list may have changed since this page was loaded (sheet upload, retired vendor): load it again now and make sure
            // the vendor the operator picked still exists with the same lot / PO, otherwise nothing is saved.
            {
                const typed = document.getElementById('reg-company').value;
                const picked = resolveVendorInput(typed).rec || null;
                try { companyRecords = await window.BiomassAPI.getCompaniesDetailed(); renderVendorList(); }
                catch (listErr) { alert('The vendor list could not be refreshed, so nothing was saved: ' + (listErr && listErr.message ? listErr.message : listErr)); return; }
                if (picked && !companyRecords.some(r => r.name === picked.name && r.lot === picked.lot && (r.po_number || '') === (picked.po_number || ''))) {
                    document.getElementById('reg-company').value = '';
                    updateVendorInfo();
                    alert('The vendor list was updated by the administrator after this page was loaded, and "' + picked.name + '" (' + lotLabel(picked.lot) + ') is no longer available as chosen.\n\nNothing was saved. Please choose the vendor again from the list.');
                    return;
                }
            }

            // Duplicate vehicle guard: Warn operator if vehicle is already in the yard without outbound tare weight
            try {
                const dup = await window.BiomassAPI.checkDuplicateVehicle(vehicle);
                if (dup && dup.duplicate) {
                    const confirmDup = confirm(`⚠️ DUPLICATE VEHICLE DETECTED:\nVehicle "${vehicle}" is already recorded in the yard today (Truck ID: ${dup.truck_id}) without outbound tare weight.\n\nDo you want to proceed and register another entry for this vehicle?`);
                    if (!confirmDup) return;
                }
            } catch (dupErr) {
                console.warn('Duplicate check warning:', dupErr);
            }

            const vend = resolveVendorInput(document.getElementById('reg-company').value);
            if (vend.kind === 'ambiguous') {
                alert('This vendor exists under more than one Lot / PO.\n\nPick the correct entry from the supplier list, or press a Lot button above the supplier box.');
                return;
            }
            if (vend.kind === 'otherlot') {
                alert('This vendor is not under ' + vendorLotFilter + '.\n\nPress All or the right lot above the supplier box, then pick the vendor from the list.');
                return;
            }
            let regLot = '', regPo = '', regName = document.getElementById('reg-company').value.trim();
            if (vend.kind === 'new') {
                regLot = document.getElementById('reg-lot').value || vendorLotFilter;
                if (!regLot) { alert('This is a new supplier. Please choose its Lot (Lot 2, Lot 3 or Lot 4).'); return; }
            } else {
                regName = vend.rec.name; regLot = vend.rec.lot; regPo = vend.rec.po_number || '';
                const both = companyRecords.filter(x => normName(x.name) === normName(vend.rec.name)).length > 1;
                if (both && !confirm(`Please verify before registering:\n\nVendor: ${vend.rec.name}\nPO number: ${vend.rec.po_number || 'not set'}\nLot: ${vend.rec.lot}\n\nIs this the correct Lot / PO for this truck?`)) return;
            }

            const data = {
                company_name: regName,
                lot: regLot,
                po_number: regPo,
                driver_name: document.getElementById('reg-driver').value.trim(),
                truck_reg_number: vehicle,
                invoice_no: document.getElementById('reg-invoice').value.trim(),
                gross_weight: 0,
                tare_weight: 0,
                photo_url: capturedPhotoBase64
            };

            // Second look before anything is saved: the operator reads the details back and confirms
            if (!(await confirmRegistrationDetails(data, vend.kind === 'new'))) return;

            try {
                const truck = await window.BiomassAPI.registerTruck(data);
                
                if (data.company_name) {
                    companiesSet.add(data.company_name);
                }

                // Opaque barcode generated (Mixing Group text omitted for blinding)
                const groupDisp = document.getElementById('s1-group-code-display');
                if (groupDisp) groupDisp.style.display = 'none';

                // Generate Secure Encrypted Payload
                const encrypted = await encryptPayload(truck.sample1_barcode_id);

                // Render QR Code onto the Canvas
                const s1Canvas = document.getElementById('qr-canvas-s1');
                if (s1Canvas) {
                    QRCode.toCanvas(s1Canvas, encrypted, {
                        errorCorrectionLevel: 'M',
                        width: 246,
                        margin: 4
                    }, function(err) {
                        if (err) console.error('QR code generation failed:', err);
                    });
                }

                const resBox = document.getElementById('admin-barcodes-result');
                if (resBox) resBox.style.display = 'block';
                
                // Attach print & download triggers (Only S1 QR)
                setupBarcodePrintTriggers(truck.sample1_barcode_id, truck.daily_group_code, truck.entry_date);

                // Clean registration form (the reset also clears the auto-print tick: put it back from the saved setting)
                truckRegForm.reset();
                updateVendorInfo();
                const autoBoxAfterReset = document.getElementById('auto-print-label');
                if (autoBoxAfterReset) { try { autoBoxAfterReset.checked = localStorage.getItem('BIOMASS_AUTOPRINT_LABEL') === '1'; } catch (e) { /* ignore */ } }
                
                // Directly and safely reset photo state
                capturedPhotoBase64 = '';
                const capturedImg = document.getElementById('captured-image-img');
                if (capturedImg) capturedImg.src = '';
                const previewPanel = document.getElementById('captured-preview-panel');
                if (previewPanel) previewPanel.style.display = 'none';
                const photoStatus = document.getElementById('photo-status');
                if (photoStatus) {
                    photoStatus.textContent = 'No Photo Attached';
                    photoStatus.classList.remove('badge-complete');
                    photoStatus.classList.add('badge-pending');
                }

                loadSupplierDataLists(); 
                
                const curUser = window.BiomassAPI.getCurrentUser();
                if (curUser && curUser.role === 'admin') {
                    initAdminQrLookupTab();
                } else {
                    loadRecentRegistrations();
                }
                
                alert('Truck registered successfully! Encrypted QR code generated.');
                // Optional: send the label straight to the printer (setting is remembered on this device)
                const autoBox = document.getElementById('auto-print-label');
                if (autoBox && autoBox.checked && typeof window.__printSampleLabelNow === 'function') window.__printSampleLabelNow();
            } catch (err) {
                console.error('Registration failed:', err);
                alert('Registration failed: ' + (err && err.message ? err.message : err));
            }
        });
    }

    (function initAutoPrintSetting() {
        const box = document.getElementById('auto-print-label');
        if (!box) return;
        try { box.checked = localStorage.getItem('BIOMASS_AUTOPRINT_LABEL') === '1'; } catch (e) { /* storage blocked: stays off */ }
        box.addEventListener('change', function () { try { localStorage.setItem('BIOMASS_AUTOPRINT_LABEL', box.checked ? '1' : '0'); } catch (e) { /* ignore */ } });
    })();

    // Print one sample label: QR + the sample date (DD-MM-YYYY) only. The serial number (S1-...) is deliberately NOT printed under the QR.
    window.printSampleLabel = async function(s1Id, dateStr) {
        const printContainer = document.getElementById('print-section');
        const encrypted = await encryptPayload(s1Id);
        if (printContainer) {
            printContainer.innerHTML = `
                <div class="print-label-view print-label-50mm" style="text-align: center;">
                    <canvas id="print-qr-target"></canvas>
                    <div style="font-family: monospace; font-size: 9pt; font-weight: 800; margin-top: 0.5mm; color: #000;">${esc(dmy(dateStr))}</div>
                </div>
            `;
        }
        const printTarget = document.getElementById('print-qr-target');
        if (printTarget) {
            QRCode.toCanvas(printTarget, encrypted, { errorCorrectionLevel: 'M', width: 410, margin: 4 }, function(err) {
                if (err) console.error(err);
                document.body.classList.add('printing-label'); setLabelPageSize(true);
                setTimeout(() => {
                    window.print();
                    document.body.classList.remove('printing-label'); setLabelPageSize(false);
                }, 250);
            });
        }
    };

    // Helper: set print & download layout trigger buttons (Strict 50mm x 50mm Thermal Label)
    function setupBarcodePrintTriggers(s1Id, dailyGroupCode, dateStr) {
        const btnPrint = document.getElementById('btn-print-s1');
        const btnDownload = document.getElementById('btn-download-s1');
        const printNow = () => window.printSampleLabel(s1Id, dateStr);
        if (btnPrint) btnPrint.onclick = printNow;
        window.__printSampleLabelNow = printNow;      // used by "print automatically after registering"

        // Download as PNG button
        if (btnDownload) {
            btnDownload.onclick = function() {
                downloadQrAsPng('#qr-canvas-s1', `Sample_1_${s1Id}`, dmy(dateStr), s1Id);
            };
        }
    }

    // --- Admin & Weighbridge: Weighment Log & Date Filtering ---
    let currentWeighFilter = 'recent'; // Default to Today + Yesterday
    const searchWeighInput = document.getElementById('weigh-search');
    if (searchWeighInput) searchWeighInput.addEventListener('input', renderWeighmentLog);

    const btnWeighToday = document.getElementById('btn-weigh-filter-today');
    const btnWeighRecent = document.getElementById('btn-weigh-filter-recent');
    const btnWeighAll = document.getElementById('btn-weigh-filter-all');

    function updateWeighFilterButtons(activeBtn) {
        [btnWeighToday, btnWeighRecent, btnWeighAll].forEach(b => {
            if (b) b.classList.remove('active');
        });
        if (activeBtn) activeBtn.classList.add('active');
    }

    if (btnWeighToday) {
        btnWeighToday.onclick = () => {
            currentWeighFilter = 'today';
            updateWeighFilterButtons(btnWeighToday);
            renderWeighmentLog();
        };
    }
    if (btnWeighRecent) {
        btnWeighRecent.onclick = () => {
            currentWeighFilter = 'recent';
            updateWeighFilterButtons(btnWeighRecent);
            renderWeighmentLog();
        };
    }
    if (btnWeighAll) {
        btnWeighAll.onclick = () => {
            currentWeighFilter = 'all';
            updateWeighFilterButtons(btnWeighAll);
            renderWeighmentLog();
        };
    }

    async function renderWeighmentLog() {
        const tbody = document.getElementById('table-weighment-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">Loading trucks...</td></tr>';
        if (window.showGlobalLoader) window.showGlobalLoader('Fetching Weighment Log...');
        
        try {
            const trucks = await window.BiomassAPI.getTrucks(currentWeighFilter);
            const filter = searchWeighInput ? searchWeighInput.value.toLowerCase().trim() : '';
            tbody.innerHTML = '';

            const filtered = trucks.filter(t => {
                const id = String(t.truck_id || '').toLowerCase();
                const reg = String(t.truck_reg_number || '').toLowerCase();
                // Search is by truck id / vehicle number only: the supplier is not shown in this table, so it must not filter it either
                const matchesSearch = id.includes(filter) || reg.includes(filter);

                const hasTareWeight = t.tare_weight !== null && t.tare_weight !== undefined && t.tare_weight !== '' && Number(t.tare_weight) > 0;
                // If filter is 'all', show completed as well; otherwise show pending
                if (currentWeighFilter === 'all') return matchesSearch;
                return matchesSearch && !hasTareWeight;
            });

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">No pending truck entries found for this filter.</td></tr>';
                return;
            }

            filtered.slice().reverse().forEach(truck => {
                const tr = document.createElement('tr');
                
                const hasPhoto = truck.has_photo || !!truck.photo_url;
                const photoHtml = hasPhoto 
                    ? `<span style="font-size:0.75rem; color:#10b981; font-weight:bold;">📸 Attached</span>`
                    : '<span style="font-size: 0.75rem; color: #f87171;">No Photo</span>';

                const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
                const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);

                const chNo = truck.invoice_no || truck.challan_no || '-';
                const hasGross = truck.gross_weight !== null && truck.gross_weight !== undefined && Number(truck.gross_weight) > 0;
                const hasTare = truck.tare_weight !== null && truck.tare_weight !== undefined && Number(truck.tare_weight) > 0;
                const hasMoisture = truck.moisture_pct !== null && truck.moisture_pct !== undefined;

                let stageBadge = '';
                if (hasGross && hasTare) {
                    stageBadge = `<span class="badge badge-success" style="background:#10b981; color:#fff; padding:2px 6px; font-size:0.75rem;">Complete</span>`;
                } else if (hasGross) {
                    stageBadge = `<span class="badge" style="background:#3b82f6; color:#fff; padding:2px 6px; font-size:0.75rem;">Phase 2: Tare Due</span>`;
                } else {
                    stageBadge = `<span class="badge" style="background:#f59e0b; color:#fff; padding:2px 6px; font-size:0.75rem;">Phase 1: Gross Due</span>`;
                }

                let weighActionBtn = '';
                if (truck.acceptance_status === 'REJECTED' || truck.acceptance_status === 'CANCELLED') {
                    // A rejected truck still needs its exit (tare) weight recorded once - but once that's
                    // done it is COMPLETE like any other truck; it must not keep offering "Record Exit Tare".
                    if (hasTare) {
                        weighActionBtn = `
                            <button class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${truck.truck_id}')" title="View & Print Rejection Slip">🖨️ Print Slip</button>
                        `;
                    } else {
                        weighActionBtn = `
                            <button class="btn btn-danger btn-sm" onclick="window.triggerWeighmentEdit('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">⛔ Record Exit Tare</button>
                            <button class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${truck.truck_id}')" title="Print Rejection Slip" style="margin-left:4px;">🖨️</button>
                        `;
                    }
                } else if (!hasGross) {
                    weighActionBtn = `
                        <button class="btn btn-secondary btn-sm" onclick="window.triggerWeighmentEdit('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">⚖️ Record Gross</button>
                    `;
                } else if (!hasMoisture) {
                    weighActionBtn = `
                        <button class="btn btn-secondary btn-sm" disabled title="Waiting for Lab 1 moisture result" style="opacity:0.55; cursor:not-allowed;">⏳ Lab 1 Pending</button>
                        <button class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${truck.truck_id}')" title="Print Inbound Slip" style="margin-left:4px;">🖨️</button>
                    `;
                } else if (hasTare) {
                    weighActionBtn = `
                        <button class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${truck.truck_id}')" title="View & Print Final Weighment Slip">🖨️ Print Slip</button>
                    `;
                } else {
                    weighActionBtn = `
                        <button class="btn btn-primary btn-sm" onclick="window.triggerWeighmentEdit('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">⚖️ Record Final Tare</button>
                        <button class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${truck.truck_id}')" title="Print Slip" style="margin-left:4px;">🖨️</button>
                    `;
                }

                tr.innerHTML = `
                    <td><strong>${esc(truck.truck_id)}</strong></td>
                    <td>${dateStr} ${timeStr}</td>
                    <td><span style="font-family: monospace;">${esc(truck.truck_reg_number)}</span></td>
                    <td><span style="font-family: monospace;">${esc(chNo)}</span></td>
                    <td>${truck.gross_weight ? Number(truck.gross_weight).toLocaleString() : '-'}</td>
                    <td>${truck.tare_weight ? Number(truck.tare_weight).toLocaleString() : '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${truck.net_weight ? Number(truck.net_weight).toLocaleString() : '-'}</td>
                    <td style="text-align: center;">${stageBadge}</td>
                    <td style="text-align: center;">${photoHtml}</td>
                    <td>${weighActionBtn}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger);">Failed to load: ${esc(e.message)}</td></tr>`;
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    }

    // --- Unloading Bay Table ---
    const searchUnloadingInput = document.getElementById('search-unloading-input');
    if (searchUnloadingInput) {
        searchUnloadingInput.addEventListener('input', renderUnloadingLog);
    }

    // Bottom sampling (Unloading): the button only opens a password prompt; the server checks the password every time.
    function bottomButtonHtml(truck) {
        if (truck.acceptance_status === 'CANCELLED') return `<small style="color:#94a3b8;">Reason: ${esc(truck.cancel_reason || '')}</small>`;
        if (truck.acceptance_status === 'REJECTED') return '';
        if (truck.bottom_request === 'REQUESTED') return ' <span class="badge badge-warning" style="background:#f59e0b; color:#fff; padding:4px 8px; border-radius:4px;">🧪 Bottom sample requested</span>';
        if (truck.bottom_request === 'GENERATED') return ' <span class="badge badge-success" style="background:#0ea5e9; color:#fff; padding:4px 8px; border-radius:4px;">🧪 Bottom sample taken</span>';
        const cancelBtn = ` <button type="button" class="btn btn-secondary btn-sm" style="margin-left:4px; border-color:#ef4444; color:#fca5a5;" onclick="window.openCancelQr('${esc(truck.truck_id)}', '${String(truck.truck_reg_number || '').replace(/[^A-Za-z0-9 \-]/g, '')}')" title="Cancel this truck's sample QR (documents inconsistent / poor quality)">🚫 Cancel QR</button>`;
        return cancelBtn + ` <button type="button" class="btn btn-secondary btn-sm" style="margin-left:4px;" onclick="window.openBottomRequest('${esc(truck.truck_id)}', '${String(truck.truck_reg_number || '').replace(/[^A-Za-z0-9 \-]/g, '')}')" title="Ask the chemistry team to test this truck separately">🧪 Bottom sample</button>`;
    }
    window.openCancelQr = function(truckId, reg) {
        const modal = document.getElementById('cancel-qr-modal');
        const sel = document.getElementById('cancel-qr-reason'), note = document.getElementById('cancel-qr-note'), pw = document.getElementById('cancel-qr-pw');
        const msg = document.getElementById('cancel-qr-msg'), send = document.getElementById('btn-cancel-qr-send'), need = document.getElementById('cancel-qr-need');
        document.getElementById('cancel-qr-truck').textContent = reg || truckId;
        sel.value = 'DOCUMENTS'; note.value = ''; pw.value = ''; msg.textContent = ''; send.disabled = true; need.textContent = '';
        modal.style.display = 'flex';
        pw.focus();
        const refresh = () => { send.disabled = pw.value.length === 0; need.textContent = sel.value === 'OTHER' ? '(required for Other)' : ''; };
        pw.oninput = refresh; sel.onchange = refresh;
        pw.onkeydown = (e) => { if (e.key === 'Enter' && !send.disabled) send.click(); };
        document.getElementById('btn-cancel-qr-close').onclick = () => { pw.value = ''; modal.style.display = 'none'; };
        send.onclick = async () => {
            if (sel.value === 'OTHER' && note.value.trim().length < 3) { msg.style.color = '#ef4444'; msg.textContent = 'Please write the reason in the comment box.'; return; }
            if (!confirm(`Cancel the QR of truck ${reg || truckId}?\n\nReason: ${sel.options[sel.selectedIndex].text}${note.value.trim() ? '\nComment: ' + note.value.trim() : ''}\n\nThis cannot be undone here.`)) return;
            send.disabled = true; msg.style.color = ''; msg.textContent = 'Checking...';
            try {
                const res = await window.BiomassAPI.cancelQr(truckId, sel.value, note.value, pw.value);
                if (res && res.success) {
                    pw.value = ''; modal.style.display = 'none';
                    alert('The QR of truck ' + (reg || truckId) + ' was cancelled: ' + res.cancel_reason);
                    renderUnloadingLog();
                } else { msg.style.color = '#ef4444'; msg.textContent = (res && res.message) || 'Nothing was changed.'; pw.value = ''; pw.focus(); }
            } catch (err) { msg.style.color = '#ef4444'; msg.textContent = err.message || String(err); }
        };
    };
    window.openBottomRequest = function(truckId, reg) {
        const modal = document.getElementById('bottom-req-modal');
        const pw = document.getElementById('bottom-req-pw'), reason = document.getElementById('bottom-req-reason');
        const msg = document.getElementById('bottom-req-msg'), send = document.getElementById('btn-bottom-req-send');
        document.getElementById('bottom-req-truck').textContent = reg || truckId;
        pw.value = ''; reason.value = ''; msg.textContent = ''; send.disabled = true;
        modal.style.display = 'flex';
        pw.focus();
        pw.oninput = () => { send.disabled = pw.value.length === 0; };
        pw.onkeydown = (e) => { if (e.key === 'Enter' && !send.disabled) send.click(); };
        document.getElementById('btn-bottom-req-cancel').onclick = () => { pw.value = ''; modal.style.display = 'none'; };
        send.onclick = async () => {
            send.disabled = true; msg.style.color = ''; msg.textContent = 'Checking...';
            try {
                const res = await window.BiomassAPI.requestBottomSample(truckId, pw.value, reason.value);
                if (res && res.success) {
                    pw.value = ''; modal.style.display = 'none';
                    alert('Bottom sample request sent to the Entry desk for truck ' + (reg || truckId) + '.');
                    renderUnloadingLog();
                } else {
                    msg.style.color = '#ef4444'; msg.textContent = (res && res.message) || 'The request was not sent.';
                    pw.value = ''; pw.focus();
                }
            } catch (err) {
                msg.style.color = '#ef4444'; msg.textContent = err.message || String(err);
            }
        };
    };

    async function renderUnloadingLog() {
        const tbody = document.getElementById('table-unloading-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">Loading unloading entries...</td></tr>';
        if (window.showGlobalLoader) window.showGlobalLoader('Fetching Unloading Clearances...');
        
        try {
            const trucks = await window.BiomassAPI.getTrucks('today');
            const filter = searchUnloadingInput ? searchUnloadingInput.value.toLowerCase().trim() : '';
            tbody.innerHTML = '';

            const filtered = trucks.filter(t => {
                const id = String(t.truck_id || '').toLowerCase();
                const driver = String(t.driver_name || '').toLowerCase();
                const reg = String(t.truck_reg_number || '').toLowerCase();
                const ch = String(t.invoice_no || t.challan_no || '').toLowerCase();
                return id.includes(filter) || driver.includes(filter) || reg.includes(filter) || ch.includes(filter);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="9" style="text-align: center;">No matching truck entries found for today.</td></tr>`;
                return;
            }

            filtered.slice().reverse().forEach(truck => {
                const tr = document.createElement('tr');
                
                const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
                const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);
                const gross = Number(truck.gross_weight) || 0;
                const tare = Number(truck.tare_weight) || 0;
                const isUnloaded = tare > 0;
                const net = (gross > 0 && tare > 0 && gross > tare) ? (gross - tare) : (Number(truck.net_weight) || 0);
                const moistureStr = (truck.moisture_pct !== null && truck.moisture_pct !== undefined) ? `${truck.moisture_pct}%` : 'Pending';
                const chNo = truck.invoice_no || truck.challan_no || '-';

                let statusBadge = '';
                if (truck.acceptance_status === 'REJECTED') {
                    statusBadge = `<span class="badge badge-danger" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">⛔ REJECTED</span>`;
                    tr.style.background = 'rgba(239, 68, 68, 0.12)';
                } else if (truck.acceptance_status === 'CANCELLED') {
                    statusBadge = `<span class="status-cancelled">🚫 QR CANCELLED</span>`;
                    tr.style.background = 'rgba(107, 114, 128, 0.18)';
                } else if (truck.acceptance_status === 'ACCEPTED') {
                    if (isUnloaded) {
                        statusBadge = `<span class="badge badge-success" style="background:#10b981; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ UNLOADED</span>`;
                    } else {
                        statusBadge = `<span class="badge badge-primary" style="background:#3b82f6; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">🚚 UNLOADING IN PROGRESS</span>`;
                    }
                } else {
                    statusBadge = `<span class="badge badge-warning" style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px;">⏳ Awaiting Lab 1</span>`;
                }

                tr.innerHTML = `
                    <td>${dateStr} ${timeStr}</td>
                    <td><span style="font-family: monospace; font-weight: bold;">${esc(truck.truck_reg_number)}</span></td>
                    <td><span style="font-family: monospace;">${esc(chNo)}</span></td>
                    <td>${gross > 0 ? gross.toLocaleString() : '-'}</td>
                    <td>${tare > 0 ? tare.toLocaleString() : '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${tare > 0 ? net.toLocaleString() : '-'}</td>
                    <td>${moistureStr}</td>
                    <td>${statusBadge}</td>
                    <td><button type="button" class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${esc(truck.truck_id)}')" title="View & Print Slip">🖨️ Slip</button>
                        ${bottomButtonHtml(truck)}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger);">Failed to load unloading log: ${esc(e.message)}</td></tr>`;
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    }

    // --- Weighment Slip: 3-Signature Printout ---
    // This used to open an on-screen review modal FIRST, and only then a separate print-ready
    // preview when the operator clicked Print inside it - two near-identical screens showing the
    // same slip before anything actually printed. Now it goes straight to the one print-ready
    // preview (printDocumentInFrame, below), which already has its own Close/Print controls, so
    // there is exactly one preview screen instead of two.
    window.openTruckWeighmentSlip = async function(truckId) {
        try {
            const truck = await window.BiomassAPI.getTruckById(truckId);
            if (!truck) throw new Error('Truck record not found.');

            const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
            const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);
            const gross = Number(truck.gross_weight) || 0;
            const tare = Number(truck.tare_weight) || 0;
            const net = (gross > 0 && tare > 0 && gross > tare) ? (gross - tare) : (Number(truck.net_weight) || 0);
            const moisture = truck.moisture_pct !== null && truck.moisture_pct !== undefined ? `${truck.moisture_pct}%` : 'Pending';
            const status = truck.acceptance_status || 'PENDING';

            // Truck-level QR (encodes the TRUCK ID only). The unloading bay scans this. It is a different code from the
            // sample-container QR, which never resolves to a truck or supplier outside the Admin login.
            let truckQrImg = '';
            try {
                const truckToken = await encryptPayload(truck.truck_id);
                const qrUrl = await new Promise(resolve => QRCode.toDataURL(truckToken, { width: 330, margin: 3, errorCorrectionLevel: 'M' }, (e, u) => resolve(e ? '' : u)));
                if (qrUrl) truckQrImg = `<img src="${qrUrl}" alt="Truck QR" style="width: 110px; height: 110px; float: right; margin-left: 0.75rem; image-rendering: pixelated;">`;
            } catch (qrErr) { console.warn('Truck QR not rendered:', qrErr); }

            const bodyHtml = `
                <div class="print-slip-container">
                    <div class="slip-header">
                        ${truckQrImg}
                        <h2 class="slip-title">BIOMASS CONSIGNMENT WEIGHMENT SLIP</h2>
                        <div class="slip-subtitle">Quality & Material Gate Receipt</div>
                    </div>

                    <div class="slip-grid">
                        <div class="slip-cell">
                            <label>Truck ID / Challan</label>
                            <div class="slip-val">${esc(truck.truck_id)} / ${esc(truck.invoice_no || truck.challan_no || 'N/A')}</div>
                        </div>
                        <div class="slip-cell">
                            <label>Date & Inbound Time</label>
                            <div class="slip-val">${dateStr} ${timeStr}</div>
                        </div>
                        <div class="slip-cell">
                            <label>Vehicle Reg Number</label>
                            <div class="slip-val"><strong>${esc(truck.truck_reg_number)}</strong></div>
                        </div>
                        <div class="slip-cell">
                            <label>Driver Name</label>
                            <div class="slip-val">${esc(truck.driver_name || 'N/A')}</div>
                        </div>
                        ${truck.company_name ? `<div class="slip-cell" style="grid-column: span 2;">
                            <label>Supplier / Vendor</label>
                            <div class="slip-val">${esc(truck.company_name)}</div>
                        </div>` : ''}
                    </div>
                    
                    <table class="slip-weight-table">
                        <thead>
                            <tr>
                                <th>Parameter</th>
                                <th>Measurement</th>
                                <th>Status / Operational Remarks</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Gross Weight (Inbound Loaded)</td>
                                <td><strong>${gross > 0 ? gross.toLocaleString() + ' kg' : 'Pending'}</strong></td>
                                <td>Phase 1 Inbound</td>
                            </tr>
                            <tr>
                                <td>Tare Weight (Outbound Empty)</td>
                                <td><strong>${tare > 0 ? tare.toLocaleString() + ' kg' : 'Pending Outbound Weighment'}</strong></td>
                                <td>${tare > 0 ? 'Phase 2 Tare Confirmed' : 'Material In Yard'}</td>
                            </tr>
                            <tr style="background: rgba(0,0,0,0.05); font-weight: bold;">
                                <td>${status === 'REJECTED' ? 'Net Weight (Rejected Consignment)' : 'Net Biomass Delivered'}</td>
                                <td style="font-size: 1.15rem; color: #0284c7;">${tare > 0 ? net.toLocaleString() + ' kg (' + (net/1000).toFixed(2) + ' MT)' : '—'}</td>
                                <td>${status === 'REJECTED' ? 'REJECTED (actual weighed net)' : (tare > 0 ? 'Discharged' : 'Pending')}</td>
                            </tr>
                            <tr>
                                <td>Gate Moisture %</td>
                                <td><strong>${moisture}</strong></td>
                                <td><span class="badge ${status === 'ACCEPTED' ? 'badge-success' : (status === 'REJECTED' ? 'badge-danger' : 'badge-warning')}">${status}</span></td>
                            </tr>
                        </tbody>
                    </table>
                    
                    <div class="slip-signatures-grid">
                        <div class="slip-signature-box">
                            <div class="slip-sign-line">Weighbridge Operator</div>
                        </div>
                        <div class="slip-signature-box">
                            <div class="slip-sign-line">Unloading Supervisor</div>
                        </div>
                        <div class="slip-signature-box">
                            <div class="slip-sign-line">Authorized Plant In-Charge</div>
                        </div>
                    </div>
                </div>
            `;

            const filename = `Weighment_Slip_${truck.truck_id}${truck.company_name ? '_' + shortCode(truck.company_name) : ''}_${compactDate(truck.entry_date)}`;
            await printDocumentInFrame({ title: filename, bodyHtml, css: SLIP_PRINT_CSS });
        } catch (err) {
            alert('Failed to load weighment slip: ' + err.message);
        }
    };

    const SLIP_PRINT_CSS = `
        .print-slip-container { max-width: 7.5in; margin: 0 auto; }
        .slip-header { position: relative; text-align: center; border-bottom: 2.5px solid #000; padding-bottom: 10px; margin-bottom: 16px; min-height: 84px; }
        .slip-title { margin: 0; font-size: 17pt; }
        .slip-subtitle { font-size: 10pt; color: #333; margin-top: 4px; }
        .slip-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 10.5pt; margin-bottom: 16px; line-height: 1.6; }
        .slip-cell label { display: block; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin-bottom: 2px; }
        .slip-val { font-size: 11pt; }
        .slip-weight-table { margin: 16px 0; border: 2px solid #000; }
        .slip-weight-table th, .slip-weight-table td { border: 1px solid #000; padding: 10px 14px; text-align: center; font-size: 11pt; }
        .slip-weight-table th { background-color: #f1f5f9; font-weight: 700; text-transform: uppercase; font-size: 9.5pt; }
        .slip-signatures-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 50px; text-align: center; page-break-inside: avoid; }
        .slip-signature-box { border-top: 1.5px solid #000; padding-top: 6px; }
        .slip-sign-line { font-size: 9.5pt; font-weight: 600; }
        .badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-weight: 700; font-size: 9.5pt; color: #fff; }
        .badge-success { background: #16a34a; }
        .badge-danger { background: #dc2626; }
        .badge-warning { background: #ca8a04; }
    `;


    // Evidence photos are fetched one at a time, on demand (admin only; enforced by the database).
    window.viewEvidencePhoto = async function(kind, id, caption) {
        try {
            if (window.showGlobalLoader) window.showGlobalLoader('Loading photo...');
            const photo = await window.BiomassAPI.getEvidencePhoto(kind, id);
            if (!photo) { alert('No photo is stored for this record.'); return; }
            window.viewPhoto(photo, caption || 'Photo');
        } catch (err) {
            alert('Could not load photo: ' + err.message);
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    };
    window.viewPhoto = function(url, caption) {
        const lightbox = document.getElementById('lightbox');
        const img = document.getElementById('lightbox-img');
        const text = document.getElementById('lightbox-caption');

        img.src = url;
        text.textContent = caption;
        lightbox.style.display = 'flex';
    };

    window.triggerWeighmentEdit = async function(id, gross, tare) {
        const card = document.getElementById('weighment-edit-card');
        document.getElementById('weigh-edit-truck-id').value = id;
        document.getElementById('weigh-edit-title').textContent = 'Update Weighment logs for ...';
        
        const grossInput = document.getElementById('weigh-edit-gross');
        const tareInput = document.getElementById('weigh-edit-tare');
        const stageBadge = document.getElementById('weigh-stage-badge');
        const grossLockedNotice = document.getElementById('weigh-gross-locked-notice');
        const tareLockedNotice = document.getElementById('weigh-tare-locked-notice');
        const submitBtn = document.getElementById('btn-save-weigh');
        const moistureAlert = document.getElementById('weigh-moisture-alert');
        const overrideGroup = document.getElementById('weigh-override-reason-group');
        const overrideReasonInput = document.getElementById('weigh-override-reason');

        grossInput.value = gross || '';
        tareInput.value = tare || '';
        if (overrideReasonInput) overrideReasonInput.value = '';

        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;

        let truck = null;
        try {
            truck = await window.BiomassAPI.getTruckById(id);
        } catch (e) {
            console.warn('Could not fetch truck details for modal:', e);
        }
        // The operator confirms the truck physically on the weighbridge, so the heading shows the VEHICLE NUMBER (not the internal Truck ID)
        if (truck && truck.truck_reg_number) {
            document.getElementById('weigh-edit-title').textContent = `Update Weighment logs for [${truck.truck_reg_number}]`;
        } else {
            document.getElementById('weigh-edit-title').textContent = `Update Weighment logs for [${id}]`;     // details could not be loaded
        }

        const hasGross = gross !== null && gross !== undefined && Number(gross) > 0;
        const hasTare  = tare  !== null && tare  !== undefined && Number(tare)  > 0;
        const grossLocked = hasGross && role !== 'admin';
        // The tare weight is locked the same way the gross weight is, the moment it has been recorded:
        // a non-admin login must not be able to type over an already-submitted value (the server also
        // refuses the change, but the field looking editable was misleading and confusing to operators).
        const tareLocked = hasTare && role !== 'admin';

        if (grossInput) {
            grossInput.disabled = grossLocked;
            grossInput.style.background = grossLocked ? 'rgba(255,255,255,0.06)' : '';
        }
        if (grossLockedNotice) grossLockedNotice.style.display = grossLocked ? 'block' : 'none';

        if (tareInput) {
            tareInput.disabled = tareLocked || (!hasGross && role !== 'admin');
            tareInput.style.background = tareInput.disabled ? 'rgba(255,255,255,0.06)' : '';
            tareInput.placeholder = hasGross ? 'e.g. 11500' : 'Awaiting outbound return';
        }
        if (tareLockedNotice) tareLockedNotice.style.display = tareLocked ? 'block' : 'none';

        if (stageBadge) {
            if (hasGross) {
                stageBadge.textContent = 'Stage 2: Outbound (Tare)';
                stageBadge.className = 'stage-indicator-badge stage-outbound';
            } else {
                stageBadge.textContent = 'Stage 1: Inbound (Gross)';
                stageBadge.className = 'stage-indicator-badge stage-inbound';
            }
        }

        if (submitBtn) {
            // Nothing left for this role to do: both fields it's allowed to touch are already locked.
            const nothingToSubmit = role !== 'admin' && grossLocked && (hasGross ? tareLocked : true);
            submitBtn.disabled = nothingToSubmit;
            submitBtn.textContent = nothingToSubmit ? '🔒 Already Recorded' : 'Save Weight Record';
        }

        if (!tareInput.disabled) {
            setTimeout(() => (hasGross ? tareInput : grossInput).focus(), 150);
        } else if (!grossInput.disabled) {
            setTimeout(() => grossInput.focus(), 150);
        }

        // Moisture Interlock Alert
        if (moistureAlert) {
            if (truck && truck.acceptance_status === 'REJECTED') {
                moistureAlert.style.display = 'block';
                moistureAlert.innerHTML = `
                    <div style="font-weight: bold; color: #ef4444; font-size: 1rem;">⛔ REJECTED CONSIGNMENT DETECTED (${truck.moisture_pct}% Moisture)</div>
                    <div style="font-size: 0.85rem; color: #fca5a5; margin-top: 0.25rem;">
                        This consignment was rejected by Lab 1. Biomass must NOT be unloaded. Record exit tare weight for gate release; net weight will be recorded as 0 kg.
                    </div>
                `;
            } else {
                moistureAlert.style.display = 'none';
            }
        }
        
        // Admin Override Reason
        if (overrideGroup) {
            overrideGroup.style.display = (role === 'admin') ? 'block' : 'none';
        }
        
        card.style.display = 'block';
        calculateEditNet();
        card.scrollIntoView({ behavior: 'smooth' });
    };

    const editGross = document.getElementById('weigh-edit-gross');
    const editTare = document.getElementById('weigh-edit-tare');
    const editNet = document.getElementById('weigh-edit-net');

    if (editGross) editGross.oninput = calculateEditNet;
    if (editTare) editTare.oninput = calculateEditNet;

    function calculateEditNet() {
        const g = Number(editGross.value) || 0;
        const t = Number(editTare.value) || 0;
        const net = g > t ? (g - t) : 0;
        if (editNet) editNet.textContent = `${net.toLocaleString()} kg`;
    }

    const btnCancelWeigh = document.getElementById('btn-cancel-weigh');
    if (btnCancelWeigh) {
        btnCancelWeigh.onclick = () => {
            document.getElementById('weighment-edit-card').style.display = 'none';
        };
    }

    const weighEditForm = document.getElementById('weigh-edit-form');
    if (weighEditForm) {
        weighEditForm.onsubmit = async function(e) {
            e.preventDefault();
            const id = document.getElementById('weigh-edit-truck-id').value;
            const g = editGross.value;
            const t = editTare.value;
            const overrideInput = document.getElementById('weigh-override-reason');
            const reason = overrideInput ? overrideInput.value.trim() : '';

            // Validation guard: Tare cannot be >= Gross
            if (g && t && Number(g) > 0 && Number(t) > 0) {
                if (Number(t) >= Number(g)) {
                    alert(`⚠️ TARE WEIGHT ERROR:\nTare weight (${Number(t).toLocaleString()} kg) cannot be equal to or greater than Gross weight (${Number(g).toLocaleString()} kg)!\n\nPlease re-check weighbridge readout.`);
                    return;
                }
            }

            try {
                const res = await window.BiomassAPI.updateWeighment(id, g, t, reason);
                if (res.success) {
                    alert('Weighment updated successfully.');
                    document.getElementById('weighment-edit-card').style.display = 'none';
                    renderWeighmentLog();
                } else {
                    alert('Update failed: ' + res.message);
                }
            } catch (err) {
                alert('API communication error: ' + err.message);
            }
        };
    }

    // Composite batch creation now happens exclusively from the Lab 2 login
    // (see setupLab2GroupCodeGenerator), where each physical sample is scanned
    // and blind-confirmed against its moisture result before mixing.

    // --- Admin: Compiled Reports Generation ---
    async function loadReportSelectors() {
        await loadSupplierDataLists();
        document.getElementById('report-output-panel').style.display = 'none';
        const dateInput = document.getElementById('report-select-date');
        if (dateInput && !dateInput.value) dateInput.value = window.BiomassAPI.todayIST();
        await filterSuppliersByDate('report-select-company', dateInput.value, '<option value="">-- Choose Supplier --</option>');
    }

    const btnCompileReport = document.getElementById('btn-compile-report');
    btnCompileReport.onclick = async function() {
        const company = document.getElementById('report-select-company').value;
        const date = document.getElementById('report-select-date').value;

        if (!company || !date) {
            alert('Please select both supplier and date.');
            return;
        }

        try {
            const report = await window.BiomassAPI.getAdminReport(company, date);
            
            if (report.rows.length === 0) {
                alert('No truck entry logs recorded for this supplier on the selected date.');
                document.getElementById('report-output-panel').style.display = 'none';
                return;
            }

            // Populate Panel
            document.getElementById('report-company-title').textContent = report.company_name;
            document.getElementById('report-date-title').textContent = report.date;

            document.getElementById('summary-truck-count').textContent = report.summary.truck_count;
            document.getElementById('summary-net-weight').textContent = `${report.summary.total_net_weight.toLocaleString()} kg`;
            document.getElementById('summary-accept-reject').textContent = `${report.summary.accepted_count} / ${report.summary.rejected_count}`;
            document.getElementById('summary-avg-moisture').textContent = report.summary.avg_moisture !== null ? `${report.summary.avg_moisture}%` : 'Pending';
            document.getElementById('summary-avg-fineness').textContent = report.summary.avg_fineness !== null ? `${report.summary.avg_fineness}%` : 'Pending';
            
            document.getElementById('summary-avg-moisture').textContent = report.summary.tm !== null ? `${report.summary.tm}%` : 'Pending';       // Moisture = TM
            const gcvVal = report.summary.avg_gcv !== null ? `${report.summary.avg_gcv} kcal` : 'Pending';
            const ashVal = report.summary.avg_ash !== null ? `${report.summary.avg_ash}%` : 'Pending';
            document.getElementById('summary-avg-composite').textContent = `${gcvVal} / ${ashVal}` + (report.summary.has_lot4 && report.summary.avg_sulphur !== null ? `  |  S ${report.summary.avg_sulphur}% / VM ${report.summary.avg_vm}%` : '');
            document.querySelectorAll('#report-output-panel .lot4-only').forEach(el => { el.style.display = report.summary.has_lot4 ? '' : 'none'; });

            // Populate rows
            const tbody = document.getElementById('report-rows-body');
            tbody.innerHTML = '';

            report.rows.forEach(row => {
                const tr = document.createElement('tr');

                let acceptanceBadge = '';
                if (row.acceptance_status === 'REJECTED') {
                    acceptanceBadge = `<span class="badge badge-danger" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">⛔ REJECTED</span><br><small style="color:#ef4444; font-size:0.75rem;">${row.rejection_reason || 'Moisture >14%'}</small>`;
                    tr.style.background = 'rgba(239, 68, 68, 0.12)';
                } else if (row.acceptance_status === 'CANCELLED') {
                    acceptanceBadge = `<span class="status-cancelled">🚫 QR CANCELLED</span><br><small style="color:#9ca3af; font-size:0.75rem;">${esc(row.cancel_reason || '')}</small>`;
                    tr.style.background = 'rgba(107, 114, 128, 0.15)';
                } else if (row.acceptance_status === 'ACCEPTED') {
                    acceptanceBadge = `<span class="badge badge-success" style="background:#10b981; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ ACCEPTED</span>`;
                } else {
                    acceptanceBadge = `<span class="badge badge-warning" style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px;">⏳ Pending Lab 1</span>`;
                }

                const gcvText = (row.acceptance_status === 'REJECTED' || row.acceptance_status === 'CANCELLED') ? ('<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (' + row.acceptance_status + ')</span>') : (row.gcv_value !== null ? row.gcv_value + ' kcal' : '<span class="badge badge-pending">Pending</span>');
                const ashText = (row.acceptance_status === 'REJECTED' || row.acceptance_status === 'CANCELLED') ? ('<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (' + row.acceptance_status + ')</span>') : (row.ash_pct !== null ? row.ash_pct + '%' : '<span class="badge badge-pending">Pending</span>');
                const vendorGcvText = (row.acceptance_status === 'REJECTED' || row.acceptance_status === 'CANCELLED') ? ('<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (' + row.acceptance_status + ')</span>') : formatVendorGcvDisplay(row);
                const refereeGcvText = (row.acceptance_status === 'REJECTED' || row.acceptance_status === 'CANCELLED') ? ('<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (' + row.acceptance_status + ')</span>') : formatRefereeGcvDisplay(row);

                tr.innerHTML = `
                    <td><strong>${row.truck_id}</strong></td>
                    <td><span style="font-family: monospace;">${row.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${row.invoice_no || row.challan_no || '-'}</span></td>
                    <td style="font-weight: 500;">${row.moisture_pct !== null ? row.moisture_pct + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="font-weight: 500;">${row.fineness_value !== null ? row.fineness_value + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td>${acceptanceBadge}</td>
                    <td><span class="badge badge-referee" style="font-weight: bold;">${row.mixing_group_code || 'N/A'}</span></td>
                    <td style="font-weight: 500;">${row.tm !== null && row.tm !== undefined ? row.tm.toFixed(2) + '%' : '-'}</td>
                    <td style="font-weight: 500;">${gcvText}</td>
                    <td style="font-weight: 500;">${ashText}</td>
                    ${report.summary.has_lot4 ? `<td style="font-weight: 500;">${row.lot === 'LOT4' && row.arb_sulphur !== null ? row.arb_sulphur + '%' : '-'}</td><td style="font-weight: 500;">${row.lot === 'LOT4' && row.arb_vm !== null ? row.arb_vm + '%' : '-'}</td>` : ''}
                    <td style="font-weight: 500;">${vendorGcvText}</td>
                    <td style="font-weight: 500;">${refereeGcvText}</td>
                `;
                tbody.appendChild(tr);
            });

            document.getElementById('report-output-panel').style.display = 'block';
            document.getElementById('report-output-panel').scrollIntoView({ behavior: 'smooth' });

            setupReportPrintTrigger(report);

        } catch (err) {
            alert('Failed to compile report: ' + err.message);
        }
    };

    // Shared by: Compiled Reports, Commercial Logistics Report, and the Executive Dashboard's
    // filtered PDF export - all three use this same "official report" layout.
    const OFFICIAL_REPORT_PRINT_CSS = `
        .print-report-view { width: 100%; }
        .report-meta-info { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin-bottom: 0.3in; border-bottom: 2px solid #000; padding-bottom: 0.1in; font-size: 10pt; }
        table { margin-top: 0.2in; }
        th, td { border: 1px solid #000; padding: 6px; font-size: 9pt; text-align: left; }
        th { background-color: #f3f4f6; font-weight: bold; }
        .print-summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 0.3in; border: 1px solid #000; padding: 10px; background-color: #f9fafb; }
        .print-summary-card { text-align: center; }
        .print-summary-lbl { font-size: 8pt; text-transform: uppercase; color: #555; }
        .print-summary-val { font-size: 14pt; font-weight: bold; color: #000; }
        .print-signature-section { margin-top: 1.2in; display: flex; justify-content: space-between; padding: 0 0.3in; page-break-inside: avoid; }
        .print-signature-box { text-align: center; border-top: 1.5px solid #000; width: 2.2in; padding-top: 6px; font-size: 10pt; }
        @media (max-width: 1px) {}   /* keep @page rule from the shared wrapper untouched */
        @media print { .print-summary-grid { grid-template-columns: repeat(5, 1fr); } }
        @media screen and (max-width: 700px) { .print-summary-grid { grid-template-columns: repeat(2, 1fr); } }
    `;

    function setupReportPrintTrigger(report) {
        const btnPrint = document.getElementById('btn-print-report-action');
        const btnPdf = document.getElementById('btn-export-pdf-action');

        function generatePrintHtml() {
            let rowHtml = '';
            report.rows.forEach(r => {
                const acceptanceLabel = r.acceptance_status === 'REJECTED' 
                    ? `<span style="color:red; font-weight:bold;">⛔ REJECTED (${r.rejection_reason || 'Moisture >14%'})</span>` 
                    : r.acceptance_status === 'CANCELLED' ? `<span style="color:#444; font-weight:bold;">🚫 QR CANCELLED (${esc(r.cancel_reason || '')})</span>`
                    : r.acceptance_status === 'ACCEPTED' ? '<span style="color:green; font-weight:bold;">✅ ACCEPTED</span>' : 'Pending';
                const chNo = r.invoice_no || r.challan_no || '-';
                const gcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : (r.gcv_value !== null ? r.gcv_value : 'Pending');
                const ashPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : (r.ash_pct !== null ? r.ash_pct + '%' : 'Pending');
                const vendorGcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : formatVendorGcvDisplay(r);
                const refereeGcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : formatRefereeGcvDisplay(r);

                rowHtml += `
                    <tr>
                        <td><strong>${r.truck_id}</strong></td>
                        <td>${r.truck_reg_number}</td>
                        <td>${chNo}</td>
                        <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : 'Pending'}</td>
                        <td>${r.fineness_value !== null ? r.fineness_value + '%' : 'Pending'}</td>
                        <td>${acceptanceLabel}</td>
                        <td>${r.mixing_group_code || 'N/A'}</td>
                        <td>${r.tm !== null && r.tm !== undefined ? r.tm.toFixed(2) + '%' : '-'}</td>
                        <td>${gcvPrint}</td>
                        <td>${ashPrint}</td>
                        ${report.summary.has_lot4 ? `<td>${r.lot === 'LOT4' && r.arb_sulphur !== null ? r.arb_sulphur + '%' : '-'}</td><td>${r.lot === 'LOT4' && r.arb_vm !== null ? r.arb_vm + '%' : '-'}</td>` : ''}
                        <td>${vendorGcvPrint}</td>
                        <td>${refereeGcvPrint}</td>
                    </tr>
                `;
            });

            return `
                <div class="print-report-view">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 2px solid black; padding-bottom: 0.75rem;">
                        <img src="ntpc-logo.png" alt="" style="height: 50px;" onerror="this.style.display='none'">
                        <div style="text-align: left;">
                            <h1 style="font-size: 20pt; font-weight: bold; margin: 0; color: #000;">NTPC LIMITED</h1>
                            <h3 style="font-size: 11pt; font-weight: bold; letter-spacing: 0.05em; margin: 0; color: #444;">CHEMISTRY DEPARTMENT</h3>
                        </div>
                    </div>

                    <h2 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 1rem;">OFFICIAL BIOMASS LAB QUALITY REPORT</h2>

                    <div class="report-meta-info">
                        <div><strong>Supplier Company:</strong> ${esc(report.company_name)}</div>
                        <div><strong>Intake Date:</strong> ${esc(report.date)}</div>
                        <div><strong>Generated At:</strong> ${new Date().toLocaleString()}</div>
                    </div>

                    <table>
                        <thead>
                            <tr>
                                <th>Truck ID</th>
                                <th>Vehicle Reg</th>
                                <th>Invoice / Challan No.</th>
                                <th>Moisture %</th>
                                <th>Fineness %</th>
                                <th>Acceptance</th>
                                <th>Mixing Group</th>
                                <th>TM %</th>
                                <th>ARB GCV (kcal)</th>
                                <th>ARB Ash %</th>
                                ${report.summary.has_lot4 ? '<th>ARB Sulphur %</th><th>ARB VM %</th>' : ''}
                                <th>Vendor GCV</th>
                                <th>Referee GCV</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowHtml}
                        </tbody>
                    </table>

                    <div class="print-summary-grid">
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Total Trucks</div>
                            <div class="print-summary-val">${report.summary.truck_count}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Total Net Weight</div>
                            <div class="print-summary-val">${report.summary.total_net_weight.toLocaleString()} kg</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Approved / Rejected</div>
                            <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">${report.summary.accepted_count} / ${report.summary.rejected_count}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Moisture (TM)</div>
                            <div class="print-summary-val">${report.summary.tm !== null ? report.summary.tm + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg Fineness</div>
                            <div class="print-summary-val">${report.summary.avg_fineness !== null ? report.summary.avg_fineness + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">ARB GCV / Ash${report.summary.has_lot4 ? ' / S / VM' : ''}</div>
                            <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">
                                ${report.summary.avg_gcv !== null ? report.summary.avg_gcv + ' kcal' : 'Pending'} / 
                                ${report.summary.avg_ash !== null ? report.summary.avg_ash + '%' : 'Pending'}${report.summary.has_lot4 && report.summary.avg_sulphur !== null ? ` / ${report.summary.avg_sulphur}% / ${report.summary.avg_vm}%` : ''}
                            </div>
                        </div>
                    </div>

                    <div class="print-signature-section">
                        <div class="print-signature-box">
                            <strong>Prepared By</strong><br>
                            <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                            <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                        </div>
                        <div class="print-signature-box">
                            <strong>Verified By</strong><br>
                            <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                            <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                        </div>
                    </div>
                </div>
            `;
        }

        const filename = `${shortCode(report.company_name)}_Quality_Report_${compactDate(report.date)}`;

        btnPrint.onclick = async function() {
            btnPrint.disabled = true;
            try { await printDocumentInFrame({ title: filename, bodyHtml: generatePrintHtml(), css: OFFICIAL_REPORT_PRINT_CSS }); }
            finally { btnPrint.disabled = false; }
        };

        if (btnPdf) {
            btnPdf.onclick = async function() {
                btnPdf.disabled = true;
                try { await printDocumentInFrame({ title: filename, bodyHtml: generatePrintHtml(), css: OFFICIAL_REPORT_PRINT_CSS }); }
                finally { btnPdf.disabled = false; }
            };
        }
    }

    // --- Admin: Commercial Logistics & Unloaded Biomass Report ---
    let lastCommReport = null;   // kept so the Print/PDF buttons can rebuild the document on demand

    function buildCommReportBodyHtml(rep) {
        const vendors = rep.company_breakdown || [];
        const trucks = rep.rows || [];
        const vendorRows = vendors.length === 0
            ? '<tr><td colspan="7" style="text-align:center;">No vendor consignments found.</td></tr>'
            : vendors.map(v => `
                <tr>
                    <td><strong>${esc(v.company_name)}</strong></td>
                    <td style="text-align:center;">${v.total_trucks}</td>
                    <td style="text-align:center;"><strong>${v.unloaded_trucks}</strong></td>
                    <td style="text-align:right;">${(v.gross_weight / 1000).toFixed(2)}</td>
                    <td style="text-align:right; font-weight:bold;">${(v.net_weight / 1000).toFixed(2)}</td>
                    <td style="text-align:center;">${v.approved_count}</td>
                    <td style="text-align:center;">${v.rejected_count}</td>
                </tr>`).join('');
        const truckRows = trucks.length === 0
            ? '<tr><td colspan="9" style="text-align:center;">No truck consignments recorded.</td></tr>'
            : trucks.map(t => `
                <tr>
                    <td>${esc(t.entry_date)}</td>
                    <td><strong>${esc(t.truck_id)}</strong></td>
                    <td>${esc(t.truck_reg_number)}</td>
                    <td>${esc(t.company_name)}</td>
                    <td style="text-align:right;">${t.gross_weight > 0 ? t.gross_weight.toLocaleString() : '-'}</td>
                    <td style="text-align:right;">${t.tare_weight > 0 ? t.tare_weight.toLocaleString() : '-'}</td>
                    <td style="text-align:right; font-weight:bold;">${t.is_unloaded ? t.net_weight.toLocaleString() : '-'}</td>
                    <td style="text-align:center;">${t.is_unloaded ? 'Unloaded' : 'Pending'}</td>
                    <td style="text-align:center;">${esc(t.acceptance_status)}</td>
                </tr>`).join('');

        return `
            <div class="print-report-view">
                <h2 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 0.2in;">BIOMASS LOGISTICS &amp; UNLOADING REPORT (${esc((rep.period || '').toUpperCase())})</h2>
                <div class="report-meta-info">
                    <div><strong>Period:</strong> ${esc(rep.start_date)} to ${esc(rep.end_date)}</div>
                    <div><strong>Supplier:</strong> ${esc(rep.company_filter)}</div>
                    <div><strong>Generated:</strong> ${new Date().toLocaleString()}</div>
                </div>
                <div class="print-summary-grid" style="grid-template-columns: repeat(4, 1fr);">
                    <div class="print-summary-card"><div class="print-summary-lbl">Total Trucks</div><div class="print-summary-val">${rep.summary.total_trucks}</div></div>
                    <div class="print-summary-card"><div class="print-summary-lbl">Unloaded</div><div class="print-summary-val">${rep.summary.unloaded_trucks}</div></div>
                    <div class="print-summary-card"><div class="print-summary-lbl">Gross (MT)</div><div class="print-summary-val">${(rep.summary.total_gross_weight_kg / 1000).toFixed(2)}</div></div>
                    <div class="print-summary-card"><div class="print-summary-lbl">Net (MT)</div><div class="print-summary-val">${(rep.summary.total_net_weight_kg / 1000).toFixed(2)}</div></div>
                </div>
                <h3 style="margin-top: 0.3in; font-size: 12pt;">Vendor Breakdown</h3>
                <table>
                    <thead><tr><th>Supplier</th><th>Trucks</th><th>Unloaded</th><th>Gross (MT)</th><th>Net (MT)</th><th>Approved</th><th>Rejected</th></tr></thead>
                    <tbody>${vendorRows}</tbody>
                </table>
                <h3 style="margin-top: 0.3in; font-size: 12pt;">Consignment Detail</h3>
                <table>
                    <thead><tr><th>Date</th><th>Truck ID</th><th>Vehicle Reg</th><th>Supplier</th><th>Gross (kg)</th><th>Tare (kg)</th><th>Net (kg)</th><th>Unloading</th><th>Status</th></tr></thead>
                    <tbody>${truckRows}</tbody>
                </table>
                <div class="print-signature-section">
                    <div class="print-signature-box"><strong>Prepared By</strong></div>
                    <div class="print-signature-box"><strong>Verified By</strong></div>
                </div>
            </div>`;
    }

    const btnCompileCommReport = document.getElementById('btn-compile-comm-report');
    if (btnCompileCommReport) {
        btnCompileCommReport.onclick = async function() {
            const period = document.getElementById('comm-report-period').value;
            const date = document.getElementById('comm-report-date').value || window.BiomassAPI.todayIST();
            const company = document.getElementById('comm-report-company').value;

            const outputPanel = document.getElementById('comm-report-output');
            const titleEl = document.getElementById('comm-report-title');
            const subtitleEl = document.getElementById('comm-report-subtitle');

            if (window.showGlobalLoader) window.showGlobalLoader('Compiling Commercial Logistics Report...');
            try {
                const rep = await window.BiomassAPI.getLogisticsWeightReport({ period, date, companyName: company });
                lastCommReport = rep;

                outputPanel.style.display = 'block';
                titleEl.textContent = `Biomass Logistics & Unloading Report (${period.toUpperCase()})`;
                subtitleEl.textContent = `Period: ${rep.start_date} to ${rep.end_date} | Supplier: ${rep.company_filter} | Generated: ${new Date().toLocaleString()}`;

                // NOTE: these ids (comm-sum-*) previously did not match any element in index.html
                // (they were comm-stat-*), so this whole panel silently rendered nothing at all.
                document.getElementById('comm-sum-trucks').textContent = rep.summary.total_trucks;
                document.getElementById('comm-sum-unloaded').textContent = rep.summary.unloaded_trucks;
                document.getElementById('comm-sum-gross').textContent = (rep.summary.total_gross_weight_kg / 1000).toFixed(2) + ' MT';
                document.getElementById('comm-sum-net').textContent = (rep.summary.total_net_weight_kg / 1000).toFixed(2) + ' MT';
                document.getElementById('comm-sum-approved').textContent = rep.summary.approved_trucks;
                document.getElementById('comm-sum-rejected').textContent = rep.summary.rejected_trucks;

                // Render Vendor Breakdown table (id previously didn't match index.html either - see note above)
                const vTbody = document.getElementById('comm-company-breakdown-body');
                if (vTbody) {
                    const vendors = rep.company_breakdown || [];
                    vTbody.innerHTML = '';
                    if (vendors.length === 0) {
                        vTbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No vendor consignments found.</td></tr>';
                    } else {
                        vendors.forEach(v => {
                            const tr = document.createElement('tr');
                            tr.innerHTML = `
                                <td><strong>${esc(v.company_name)}</strong></td>
                                <td style="text-align:center;">${v.total_trucks}</td>
                                <td style="text-align:center;"><strong>${v.unloaded_trucks}</strong></td>
                                <td style="text-align:right;">${(v.gross_weight / 1000).toFixed(2)}</td>
                                <td style="text-align:right; font-weight:bold; color:var(--primary);">${(v.net_weight / 1000).toFixed(2)}</td>
                                <td style="text-align:center;"><span class="badge badge-success">${v.approved_count}</span></td>
                                <td style="text-align:center;"><span class="badge badge-danger">${v.rejected_count}</span></td>
                            `;
                            vTbody.appendChild(tr);
                        });
                    }
                }

                // Render Detailed Consignments table (id previously didn't match index.html either)
                const cTbody = document.getElementById('comm-trucks-detail-body');
                if (cTbody) {
                    const consignments = rep.rows || [];
                    cTbody.innerHTML = '';
                    if (consignments.length === 0) {
                        cTbody.innerHTML = '<tr><td colspan="10" style="text-align:center;">No truck consignments recorded.</td></tr>';
                    } else {
                        consignments.forEach(t => {
                            const tr = document.createElement('tr');
                            const statusBadge = t.acceptance_status === 'ACCEPTED'
                                ? `<span class="badge badge-success">ACCEPTED</span>`
                                : (t.acceptance_status === 'REJECTED' ? `<span class="badge badge-danger">REJECTED</span>` : `<span class="badge badge-warning">PENDING</span>`);
                            const unloadBadge = t.is_unloaded
                                ? `<span style="color:#10b981; font-weight:bold;">✅ Unloaded</span>`
                                : `<span style="color:#f59e0b;">⏳ Pending</span>`;
                            // Column order must match the <thead> in index.html exactly:
                            // Truck ID | Date | Supplier Name | Vehicle Number | Challan No. | Gross | Tare | Net | Unloading State | Approval
                            tr.innerHTML = `
                                <td><strong>${esc(t.truck_id)}</strong></td>
                                <td>${esc(t.entry_date)}</td>
                                <td>${esc(t.company_name)}</td>
                                <td><span style="font-family:monospace;">${esc(t.truck_reg_number)}</span></td>
                                <td><span style="font-family:monospace;">${esc(t.invoice_no || t.challan_no || '-')}</span></td>
                                <td style="text-align:right;">${t.gross_weight > 0 ? t.gross_weight.toLocaleString() : '-'}</td>
                                <td style="text-align:right;">${t.tare_weight > 0 ? t.tare_weight.toLocaleString() : '-'}</td>
                                <td style="text-align:right; font-weight:bold; color:var(--primary);">${t.is_unloaded ? t.net_weight.toLocaleString() : '-'}</td>
                                <td style="text-align:center;">${unloadBadge}</td>
                                <td style="text-align:center;">${statusBadge}</td>
                            `;
                            cTbody.appendChild(tr);
                        });
                    }
                }

                outputPanel.scrollIntoView({ behavior: 'smooth' });
            } catch (err) {
                alert('Failed to compile commercial report: ' + err.message);
            } finally {
                if (window.hideGlobalLoader) window.hideGlobalLoader();
            }
        };
    }

    async function printCommReport(btn) {
        if (!lastCommReport) { alert('Generate the report first, then print/export it.'); return; }
        const filename = `Biomass_Logistics_Report_${(lastCommReport.period || '').toUpperCase()}_${compactDate(lastCommReport.end_date)}`;
        if (btn) btn.disabled = true;
        try {
            await printDocumentInFrame({ title: filename, bodyHtml: buildCommReportBodyHtml(lastCommReport), css: OFFICIAL_REPORT_PRINT_CSS });
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    const btnPrintComm = document.getElementById('btn-print-comm-report');
    if (btnPrintComm) {
        btnPrintComm.onclick = () => printCommReport(btnPrintComm);
    }

    const btnPdfComm = document.getElementById('btn-pdf-comm-report');
    if (btnPdfComm) {
        btnPdfComm.onclick = () => printCommReport(btnPdfComm);
    }

    // ---- Exceptions & Security Violations (Admin) / audit log (Super Admin): date range + acknowledged filter; the default is TODAY + NOT ACKNOWLEDGED
    const actState = { wired: false, rows: [] };
    const actEl = (id) => document.getElementById(id);
    function actWire() {
        if (actState.wired) return;
        actState.wired = true;
        const today = () => window.BiomassAPI.todayIST();
        const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
        actEl('act-from').value = actEl('act-to').value = today();
        actEl('act-from').max = actEl('act-to').max = today();
        actEl('act-status').value = 'open';
        const reload = () => renderActivityLogTab();
        actEl('act-chips').onclick = (e) => {
            const b = e.target.closest('button[data-range]'); if (!b) return;
            const t = today(), r = b.dataset.range;
            if (r === 'today') { actEl('act-from').value = actEl('act-to').value = t; }
            else if (r === 'yesterday') { actEl('act-from').value = actEl('act-to').value = shift(t, -1); }
            else if (r === 'week') { actEl('act-from').value = shift(t, -6); actEl('act-to').value = t; }
            else { actEl('act-from').value = '2020-01-01'; actEl('act-to').value = t; }
            actEl('act-chips').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
            reload();
        };
        ['act-from', 'act-to'].forEach(id => { actEl(id).onchange = () => { actEl('act-chips').querySelectorAll('button').forEach(x => x.classList.remove('active')); reload(); }; });
        actEl('act-status').onchange = reload;
        actEl('btn-act-show').onclick = reload;
        actEl('act-q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); reload(); } };
        actEl('btn-act-ackall').onclick = async () => {
            const ids = actState.rows.filter(r => !r.acknowledged).map(r => r.id);
            if (!ids.length) { alert('Nothing to acknowledge in this list.'); return; }
            if (!confirm(`Mark the ${ids.length} line(s) shown as reviewed (acknowledged)?\n\nThey will no longer appear in the default view.`)) return;
            try { await window.BiomassAPI.ackLogs(ids); } catch (e) { alert(e.message); return; }
            reload(); refreshSuperAlert();
        };
        actEl('exceptions-log-body').onclick = async (e) => {
            const b = e.target.closest('button[data-ack]'); if (!b) return;
            b.disabled = true;
            try { await window.BiomassAPI.ackLogs([Number(b.dataset.ack)]); } catch (err) { alert(err.message); b.disabled = false; return; }
            renderActivityLogTab(); refreshSuperAlert();
        };
    }
    async function actFetch() {
        const res = await window.BiomassAPI.exceptionsRange({ from: actEl('act-from').value, to: actEl('act-to').value, status: actEl('act-status').value, q: actEl('act-q').value });
        actState.rows = res.rows || [];
        const dmyS = (d) => { const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : String(d); };
        const range = String(res.from).slice(0, 10) === String(res.to).slice(0, 10) ? dmyS(res.from) : dmyS(res.from) + ' to ' + dmyS(res.to);
        const stTxt = { open: 'not acknowledged', acked: 'acknowledged', all: 'acknowledged and not acknowledged' }[res.status];
        const other = (res.open_total || 0) - (res.open_in_range || 0);
        actEl('act-summary').innerHTML = `<b>${actState.rows.length}</b> line(s) &middot; ${esc(range)} &middot; ${stTxt}. Not acknowledged in total (all dates): <b style="color:${res.open_total ? '#f87171' : '#34d399'};">${res.open_total || 0}</b>` +
            (other > 0 ? ` &mdash; <b>${other}</b> of them on other days (change the dates or press &ldquo;All dates&rdquo; to see them)` : '') + (res.truncated ? '. <span style="color:#fbbf24;">Only the newest 1000 are shown: narrow the dates.</span>' : '');
        const ackBtn = actEl('btn-act-ackall');
        ackBtn.style.display = res.can_acknowledge && actState.rows.some(r => !r.acknowledged) ? '' : 'none';
        return res;
    }
    const actReview = (l, canAck) => l.acknowledged ? '<span class="mixr-pill ok">&#10003; acknowledged</span>'
        : (canAck ? `<button type="button" class="btn btn-secondary btn-sm" data-ack="${l.id}">Acknowledge</button>` : '<span class="mixr-pill wait">not yet</span>');

    // Super Admin: only its own changes + the submitted lab results with their values
    async function renderSuperAuditTab() {
        actWire();
        const chg = document.getElementById('sx-audit-changes'), subs = document.getElementById('sx-audit-subs');
        document.querySelectorAll('#tab-admin-activity .admin-only-log').forEach(el => el.style.display = 'none');
        document.getElementById('sx-audit-panel').style.display = 'flex';
        chg.innerHTML = subs.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>';
        try {
            const res = await actFetch();
            chg.innerHTML = actState.rows.map(l => `<tr><td style="font-family:monospace; font-size:0.82rem; color:#ef4444; white-space:nowrap;">${esc(l.timestamp)}</td><td>${esc(l.username)}</td><td><strong style="color:#ef4444;">${esc(l.action.replace('SUPERADMIN_', ''))}</strong></td>` +
                `<td style="font-size:0.85rem;">${esc(l.details)}</td><td style="font-family:monospace; font-size:0.8rem;">${esc(l.ip || '-')}${devTag(l)}${l.device ? `<br><span style="font-family:inherit; color:#94a3b8; font-size:0.7rem;">${esc(String(l.device).slice(0, 90))}</span>` : ''}</td><td>${actReview(l, false)}</td></tr>`).join('')
                || '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No changes for this selection.</td></tr>';
            // the lab results follow the same dates (and the search text)
            const r = await window.BiomassAPI.superLogs();
            superAuditData = r;
            const f = String(res.from).slice(0, 10), t = String(res.to).slice(0, 10), q = actEl('act-q').value.trim().toLowerCase();
            const subRows = (r.submissions || []).filter(l => String(l.timestamp).slice(0, 10) >= f && String(l.timestamp).slice(0, 10) <= t && (!q || (l.username + ' ' + l.summary).toLowerCase().includes(q)));
            subs.innerHTML = subRows.map(l => `<tr><td style="font-family:monospace; font-size:0.82rem; white-space:nowrap;">${esc(l.timestamp)}</td><td>${esc(l.username)}</td><td style="font-size:0.9rem;"><strong>${esc(l.summary)}</strong></td></tr>`).join('')
                || '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No results submitted in this period.</td></tr>';
        } catch (e) {
            chg.innerHTML = subs.innerHTML = `<tr><td colspan="6" style="color:var(--danger);">${esc(e.message)}</td></tr>`;
        }
    }
    let superAuditData = null;

    const ipUnknown = (log) => !!log.ip && log.ip !== 'unknown' && !log.ip_label;
    const devTag = (log) => log.device_name ? `<br><span class="ip-tag known" style="margin-top:2px;" title="The registered computer this was done from">&#128421; ${esc(log.device_name)}</span>` : '';
    const ipCell = (log, red, noUnknownTag) => {
        const tag = (ipUnknown(log) && !noUnknownTag) ? '<span class="ip-tag unknown">⚠ UNKNOWN IP</span>' : (log.ip_label ? `<span class="ip-tag known">${esc(log.ip_label)}</span>` : '');
        return `${tag}<br><span style="font-family:monospace; font-size:0.78rem;${red ? ' color:#ef4444;' : ''}">${esc(log.ip || '-')}</span>` +
               devTag(log) + (log.device ? `<br><span style="color:#94a3b8; font-size:0.7rem;">${esc(String(log.device).slice(0, 80))}</span>` : '');
    };
    async function renderActivityLogTab() {
        const cu = window.BiomassAPI.getCurrentUser();
        actWire();
        if (cu && cu.is_super) return renderSuperAuditTab();
        const exceptionsBody = document.getElementById('exceptions-log-body');
        exceptionsBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Loading exception logs...</td></tr>';
        try {
            await actFetch();
            // The Admin gets NO unknown-IP / "new IP address detected" alerts (owner's decision): such lines are not listed and not marked.
            exceptionsBody.innerHTML = actState.rows.length ? actState.rows.map(l => {
                return `<tr${l.acknowledged ? ' style="opacity:0.65;"' : ''}><td style="font-family:monospace; font-size:0.85rem; color:#ef4444;">${esc(l.timestamp)}</td>` +
                    `<td><span class="user-role" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; padding: 0.1rem 0.4rem; border-radius: 4px;">${esc(l.username)}</span></td>` +
                    `<td><strong style="color:#ef4444;">${esc(l.action)}</strong></td><td style="font-size:0.85rem;">${esc(l.details)}</td><td>${ipCell(l, false, true)}</td><td>${actReview(l, true)}</td></tr>`;
            }).join('') : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No exceptions for this selection.</td></tr>';
        } catch (e) {
            exceptionsBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger);">Failed to load exceptions: ${esc(e.message)}</td></tr>`;
        }
    }

    // ================= READER TRAINING =================
    // Lab-1 keeps a photo (and the value the operator confirmed) when the reader was less than 50 % sure. The Admin lets the fineness-weight
    // reader learn from those photos (the moisture reader is a general text reader and cannot learn: its photos are only kept for checking).
    // What is learned is published as a numbered version that every Lab-1 device loads by itself - no redeploy - and can be switched back.
    const LED_CACHE_KEY = 'BIOMASS_LED_EXTRA';
    function applyLearnedEntries(entries) {
        if (!window.LED_TEMPLATES_BUILTIN) window.LED_TEMPLATES_BUILTIN = window.LED_TEMPLATES || [];
        window.LED_TEMPLATES = window.LED_TEMPLATES_BUILTIN.concat((entries || []).map(e => ({ ch: e[0], g: e.slice(1) })));
    }
    // Loads the active learned set (from this device's copy first, then from the server when a newer version exists)
    async function syncLearnedTemplates() {
        let have = -1;
        try {
            const c = JSON.parse(localStorage.getItem(LED_CACHE_KEY) || 'null');
            if (c && Array.isArray(c.examples)) { applyLearnedEntries(c.examples); have = c.version; }
        } catch (e) { /* no copy yet */ }
        try {
            const r = await window.BiomassAPI.getReaderTemplates(have);
            if (r && !r.unchanged) {
                applyLearnedEntries(r.examples);
                try { localStorage.setItem(LED_CACHE_KEY, JSON.stringify({ version: r.version, examples: r.examples })); } catch (e) { /* too big / blocked: works without the copy */ }
            }
            return r ? r.version : null;
        } catch (e) { return null; }       // offline or not allowed: the examples already loaded stay
    }

    const rt = { wired: false, rows: [], used: [], list: null, photos: {}, learned: null, newEntries: null, activeExamples: [] };
    const RT_KIND = { moisture: 'Moisture', fineness_initial: 'Initial weight', fineness_final: 'Final weight' };
    const rtEl = (id) => document.getElementById(id);

    function rtLoadImage(url) {
        return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('photo could not be opened')); i.src = url; });
    }
    async function rtPhoto(row) {
        if (rt.photos[row.id]) return rt.photos[row.id];
        const u = await window.BiomassAPI.loadStoredPhoto(row.photo);
        rt.photos[row.id] = u;
        return u;
    }

    async function initReaderTrainingTab() {
        if (!rt.wired) {
            rt.wired = true;
            rtEl('rt-refresh').onclick = rtLoad;
            rtEl('rt-collect').onchange = async () => {
                try { await window.BiomassAPI.trainingCollect(rtEl('rt-collect').checked); } catch (e) { alert(e.message); }
                rtLoad();
            };
            rtEl('rt-view').onchange = rtLoad;
            rtEl('rt-check').onclick = rtCheckReader;
            rtEl('rt-filter').oninput = () => {
                const q = rtEl('rt-filter').value.trim().toLowerCase();
                document.querySelectorAll('#rt-body tr[data-id]').forEach(tr => { tr.style.display = !q || tr.dataset.find.includes(q) ? '' : 'none'; });
            };
            rtEl('rt-del-done').onclick = () => rtDeletePhotos('done');
            rtEl('rt-del-all').onclick = () => rtDeletePhotos('all');
            rtEl('rt-learn').onclick = rtLearn;
            rtEl('rt-publish').onclick = rtPublish;
            rtEl('rt-reject').onclick = async () => {
                const ids = [...document.querySelectorAll('#rt-body input[data-pick]:checked')].map(x => Number(x.dataset.pick))
                    .concat([...document.querySelectorAll('#rt-body input[data-pickm]:checked')].map(x => Number(x.dataset.pickm)));
                if (!ids.length) { alert('Tick the samples to reject first.'); return; }
                if (!confirm(`Reject ${ids.length} sample(s)? They will not be learned (a wrong confirmation by an operator should be rejected).`)) return;
                try { await window.BiomassAPI.trainingMark(ids, 'REJECTED'); } catch (e) { alert(e.message); return; }
                rtLoad();
            };
            rtEl('rt-versions').onclick = async (e) => {
                const b = e.target.closest('button[data-ver]'); if (!b) return;
                const v = Number(b.dataset.ver);
                if (!confirm(v ? `Switch every Lab-1 device to learned version ${v}?` : 'Go back to the built-in examples only (no learned examples) on every Lab-1 device?')) return;
                try { await window.BiomassAPI.activateTemplates(v); } catch (err) { alert(err.message); return; }
                await syncLearnedTemplates();
                rtLoad();
            };
        }
        await syncLearnedTemplates();
        rtLoad();
    }

    async function rtLoad() {
        const body = rtEl('rt-body'), tiles = rtEl('rt-tiles');
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading...</td></tr>';
        rtEl('rt-result').innerHTML = ''; rtEl('rt-publish-box').style.display = 'none'; rt.newEntries = null;
        rtSpace();
        try {
            const l = await window.BiomassAPI.trainingList(rtEl('rt-view').value || 'PENDING');
            rt.list = l; rt.rows = l.rows || [];
            try { rt.used = ((await window.BiomassAPI.trainingList('USED')).rows || []).filter(r => r.kind !== 'moisture'); } catch (e) { rt.used = []; }
            const c = l.counts || {};
            tiles.innerHTML = [['Waiting to be learned', c.pending], ['Already learned', c.used], ['Rejected', c.rejected], ['Kept in the last 7 days', `${l.last7} <small style="color:#94a3b8;">(before: ${l.prev7})</small>`],
                ['Kept in the last 30 days', `${l.last30} <small style="color:#94a3b8;">(before: ${l.prev30})</small>`], ['Active learned set', l.active_version ? 'version ' + l.active_version : 'none (built-in only)']]
                .map(t => `<div class="tile"><small>${t[0]}</small><strong>${t[1]}</strong></div>`).join('');
            rtEl('rt-collect').checked = !!l.collect;
            rtEl('rt-verdict').innerHTML = l.last7 <= 2
                ? `<span style="color:#34d399;">&#9989; Only ${l.last7} low-confidence photo(s) in the last 7 days: the reader is rarely unsure now. You can switch collecting off.</span>`
                : `<span style="color:#fbbf24;">&#8505;&#65039; ${l.last7} low-confidence photos in the last 7 days. Keep learning until this stays at 2 or less per week (or 1&ndash;2 per month).</span>`;
            rtEl('rt-versions').innerHTML = (l.versions || []).length ? '<table style="min-width:0; font-size:0.85rem;"><thead><tr><th>Version</th><th>Published</th><th>By</th><th>Examples</th><th>Note</th><th></th></tr></thead><tbody>' +
                l.versions.map(v => `<tr><td><b>${v.version}</b>${v.active ? ' <span class="mixr-pill ok">active</span>' : ''}</td><td>${esc(String(v.created_at).slice(0, 16).replace('T', ' '))} UTC</td><td>${esc(v.created_by || '')}</td><td>${v.examples}</td><td>${esc(v.note || '')}</td>` +
                    `<td>${v.active ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-ver="${v.version}">Use this version</button>`}</td></tr>`).join('') +
                `</tbody></table>${l.active_version ? '<div style="margin-top:0.5rem;"><button type="button" class="btn btn-secondary btn-sm" data-ver="0">&#8630; Go back to the built-in examples only</button></div>' : ''}`
                : '<span style="color:#94a3b8;">Nothing has been published yet.</span>';
            body.innerHTML = rt.rows.length ? rt.rows.map(r => {
                const weight = r.kind !== 'moisture', gone = String(r.photo).startsWith('purged:');
                const find = [r.truck_reg_number, r.company_name, r.operator].join(' ').toLowerCase();
                return `<tr data-id="${r.id}" data-find="${esc(find)}"><td>${gone || r.status !== 'PENDING' ? (r.status === 'USED' ? '<small style="color:#34d399;">learned v' + esc(String(r.used_version || '')) + '</small>' : '') : (weight ? `<input type="checkbox" data-pick="${r.id}" checked>` : `<input type="checkbox" data-pickm="${r.id}" title="tick to reject">`)}</td>` +
                    `<td>${gone ? '<span style="color:#94a3b8; font-size:0.8rem;">photo deleted</span>' : `<img data-photo="${r.id}" alt="" style="width:140px; height:80px; object-fit:contain; background:#000; border-radius:6px; cursor:zoom-in;">`}</td>` +
                    `<td><b>${esc(r.truck_reg_number || '-')}</b><br><span style="font-size:0.85rem;">${esc(r.company_name || '-')}</span><br><small style="color:#94a3b8;">${esc(lotLabel(r.lot || ''))} &middot; operator ${esc(r.operator || '-')}</small></td>` +
                    `<td>${RT_KIND[r.kind]}<br><small style="color:#94a3b8;">${esc(String(r.created_at).slice(0, 10))}</small></td><td style="font-size:1.1rem; font-weight:800;">${esc(String(Number(r.value)))}</td>` +
                    `<td>${Math.round(r.conf)}%${r.examples_n ? '<br><small style="color:#34d399;">digits captured (' + r.examples_n + ')</small>' : ''}</td><td id="rt-now-${r.id}" style="font-size:0.85rem;">${weight ? '<span style="color:#94a3b8;">not checked</span>' : '<span style="color:#94a3b8;">kept for checking; the moisture reader cannot learn from photos</span>'}</td></tr>`;
            }).join('') : '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Nothing in this list. Photos appear here when an operator confirms a reading the reader was less than 50 % sure about.</td></tr>';
            rt.rows.filter(r => !String(r.photo).startsWith('purged:')).forEach(async (r) => {
                try { const u = await rtPhoto(r); const img = body.querySelector(`img[data-photo="${r.id}"]`); if (img) { img.src = u; img.onclick = () => { const lb = document.getElementById('lightbox'); if (lb) { document.getElementById('lightbox-img').src = u; lb.style.display = 'flex'; } }; } }
                catch (e) { const img = body.querySelector(`img[data-photo="${r.id}"]`); if (img) img.alt = 'photo not available'; }
            });
        } catch (e) {
            body.innerHTML = `<tr><td colspan="7" style="color:#ef4444;">${esc(e.message)}</td></tr>`;
        }
    }

    // Storage used by the training photos, and the "delete at once" buttons
    async function rtSpace() {
        const box = rtEl('rt-space');
        try {
            const [sp, st] = await Promise.all([window.BiomassAPI.trainingSpace(), window.BiomassAPI.getStorageStatus().catch(() => null)]);
            const pct = st && st.limit ? sp.bytes / st.limit * 100 : null;
            box.innerHTML = `<b>${fmtMB(sp.bytes)}</b> in <b>${sp.files}</b> photo file(s)` + (pct !== null ? ` &mdash; ${pct.toFixed(2)}% of the whole Storage limit (${fmtMB(st.limit)}; Storage is ${(st.bytes / st.limit * 100).toFixed(1)}% full in total)` : '') +
                `<br><span style="color:#94a3b8;">waiting to be learned: ${fmtMB(sp.waiting_bytes)} (${sp.waiting_files}) &middot; learned or rejected: ${fmtMB(sp.done_bytes)} (${sp.done_files}) &middot; already deleted: ${sp.deleted_rows} sample(s)</span>`;
            rtEl('rt-del-done').disabled = !sp.done_files && !sp.samples; rtEl('rt-del-done').title = sp.done_files ? '' : 'Nothing to delete here yet';
        } catch (e) { box.textContent = 'Could not read the storage use: ' + e.message + ' (has the updated db/01_schema_v2.sql been run?)'; }
    }
    async function rtDeletePhotos(scope) {
        const out = rtEl('rt-del-result'), b1 = rtEl('rt-del-done'), b2 = rtEl('rt-del-all');
        const msg = scope === 'all'
            ? 'Delete ALL training photos, including the ones still waiting to be learned?\n\nWaiting samples will be rejected (nothing left to learn from). What the reader has already learned is kept. The lab records\' own photos are not touched.\n\nThis cannot be undone.'
            : 'Delete the photos of the samples that were learned or rejected?\n\nWhat the reader has learned is kept (it does not need the photos). The waiting samples and the lab records\' own photos are not touched.\n\nThis cannot be undone.';
        if (!confirm(msg)) return;
        b1.disabled = b2.disabled = true; out.textContent = 'Deleting...';
        try {
            const r = await window.BiomassAPI.deleteTrainingPhotos(scope, (i, n) => { out.textContent = `Deleting... ${Math.round(i / n * 100)}%`; });
            try { await window.BiomassAPI.logActivity('TRAINING_PHOTOS_DELETED', `${r.done} training photo file(s) deleted (about ${(r.freed / 1048576).toFixed(1)} MB), ${r.detached} sample(s) detached; not removed: ${r.failed}.`); } catch (e) { /* courtesy line */ }
            out.innerHTML = `${r.failed ? '&#9888;&#65039;' : '&#9989;'} Deleted ${r.done} photo file(s), freed about ${fmtMB(r.freed)}` + (r.failed ? `; ${r.failed} could not be removed (try again)` : '') + '.';
        } catch (e) { out.textContent = 'Could not delete: ' + e.message; }
        finally { b1.disabled = b2.disabled = false; rtLoad(); }
    }

    const rtFmt = (v) => Number(v).toFixed(3);
    async function rtReadWeight(row, templates) {
        const img = await rtLoadImage(await rtPhoto(row));
        const r = window.LedWeightReader.read(img, 3, templates);
        return r.found && r.value ? { value: r.value, conf: r.conf } : { value: null, conf: 0, fail: r.fail || 'no display found' };
    }
    // What does the reader (with the examples it has NOW) say about the waiting photos?
    async function rtCheckReader() {
        const btn = rtEl('rt-check'); btn.disabled = true;
        try {
            for (const r of rt.rows) {
                const cell = rtEl('rt-now-' + r.id); if (!cell) continue;
                cell.textContent = 'reading...';
                try {
                    if (r.kind === 'moisture') {
                        if (!window.MoistureOCR) { cell.textContent = 'reader not loaded'; continue; }
                        const blob = await (await fetch(await rtPhoto(r))).blob();
                        const x = await window.MoistureOCR.read(blob, { kind: 'moisture' });
                        const ok = x && Number(x.value) === Number(r.value);
                        cell.innerHTML = x ? `${ok ? '&#9989;' : '&#10060;'} reads <b>${esc(String(x.value))}</b> (${Math.round(x.conf)}%)` : '&#10060; no reading';
                    } else {
                        const x = await rtReadWeight(r);
                        const ok = x.value && rtFmt(x.value) === rtFmt(r.value);
                        cell.innerHTML = x.value ? `${ok ? '&#9989;' : '&#10060;'} reads <b>${esc(x.value)}</b> (${Math.round(x.conf)}%)` : `&#10060; ${esc(x.fail)}`;
                    }
                } catch (e) { cell.textContent = e.message; }
            }
        } finally { btn.disabled = false; }
    }

    // Build the new examples from the ticked weight photos, then re-read them (and the earlier learned ones) to prove it works
    async function rtLearn() {
        const ids = new Set([...document.querySelectorAll('#rt-body input[data-pick]:checked')].map(x => Number(x.dataset.pick)));
        const picked = rt.rows.filter(r => ids.has(r.id) && r.kind !== 'moisture' && !String(r.photo).startsWith('purged:'));
        const out = rtEl('rt-result');
        if (!picked.length) { out.innerHTML = '<span style="color:#f59e0b;">Tick at least one weight photo.</span>'; return; }
        if (!window.LedWeightReader) { out.innerHTML = '<span style="color:#ef4444;">The weight reader is not loaded.</span>'; return; }
        const btn = rtEl('rt-learn'); btn.disabled = true; out.innerHTML = 'Learning... (a few seconds per photo)';
        try {
            const active = await window.BiomassAPI.getReaderTemplates(-1);
            rt.activeExamples = active && active.examples ? active.examples.slice() : [];
            const seen = new Set(rt.activeExamples.map(e => e[0] + ':' + e.slice(1)));
            const entries = rt.activeExamples.slice(); const learned = []; const lines = [];
            const carried = {};
            try { (await window.BiomassAPI.trainingExamples(picked.filter(r => r.examples_n > 0).map(r => r.id))).forEach(x => { carried[x.id] = x.examples; }); } catch (e) { /* fall back to the photos */ }
            for (const r of picked) {
                const lab = rtFmt(r.value).replace('.', '');
                let n = 0, why = '', src = '';
                try {
                    if (carried[r.id]) {                  // the digits were cut out of the original photo at the moment the operator confirmed
                        src = 'cut from the original photo';
                        carried[r.id].forEach(e => { const key = e[0] + ':' + e.slice(1); if (seen.has(key)) return; seen.add(key); entries.push(e); n++; });
                        if (!n) why = 'all of its examples are already in the learned set';
                    } else {
                        src = 'cut from the stored photo';
                        const img = await rtLoadImage(await rtPhoto(r));
                        const ex = window.LedWeightReader.examples(img, [-2, -1, 0, 1, 2], [-5, 0, 5], lab.length);
                        if (!ex.found) why = 'the display was not found in the stored photo (it is a smaller copy than the one the reader saw)';
                        else {
                            ex.sets.forEach(s => { if (s.n !== lab.length) return; s.grids.forEach(gs => gs.forEach((g, i) => { const key = lab[i] + ':' + g; if (seen.has(key)) return; seen.add(key); entries.push(lab[i] + g); n++; })); });
                            if (!n) {
                                const counts = [...new Set(ex.sets.map(s => s.n))];
                                why = counts.length ? ('the display shows ' + counts.join(' / ') + ' digit(s) in this photo, ' + lab.length + ' are expected' + (counts.length && counts.every(c => c === lab.length) ? ' (all of its examples are already known)' : '')) : ('no digits could be cut out: ' + [...new Set(ex.fails || [])].join(', '));
                            }
                        }
                    }
                } catch (e) { why = e.message; }
                if (n) learned.push(r);
                lines.push({ r, n, why, src });
            }
            // proof: read every learned photo again with the new set, plus the photos learned earlier (they must not get worse)
            const all = (window.LED_TEMPLATES_BUILTIN || window.LED_TEMPLATES || []).concat(entries.map(e => ({ ch: e[0], g: e.slice(1) })));
            let okNew = 0, notChecked = 0; const rows = [];
            for (const l of lines) {
                let res = '';
                if (l.n) { try { const x = await rtReadWeight(l.r, all); const ok = x.value && rtFmt(x.value) === rtFmt(l.r.value); if (ok) okNew++; res = ok ? `&#9989; now reads ${esc(x.value)} (${Math.round(x.conf)}%)` : (l.src.indexOf('original') >= 0 ? `<span style="color:#94a3b8;">not re-checked: the stored photo is a smaller copy than the original (${esc(x.value || x.fail || 'unreadable')})</span>` : `&#10060; now reads ${esc(x.value || x.fail)}`); if (!ok && l.src.indexOf('original') >= 0) notChecked++; } catch (e) { res = esc(e.message); } }
                rows.push(`<tr><td>${RT_KIND[l.r.kind]} ${esc(rtFmt(l.r.value))}</td><td>${l.n ? l.n + ' new examples <small style="color:#94a3b8;">(' + esc(l.src) + ')</small>' : '<span style="color:#f59e0b;">skipped: ' + esc(l.why) + '</span>'}</td><td>${res}</td></tr>`);
            }
            let okOld = 0, totOld = 0;
            for (const r of rt.used.filter(x => !String(x.photo).startsWith('purged:'))) { totOld++; try { const x = await rtReadWeight(r, all); if (x.value && rtFmt(x.value) === rtFmt(r.value)) okOld++; } catch (e) { /* photo gone */ } }
            rt.newEntries = entries; rt.learned = learned;
            out.innerHTML = `<table style="min-width:0; font-size:0.85rem;"><thead><tr><th>Photo (confirmed value)</th><th>Learned</th><th>Reader with the new examples</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
                `<p style="margin-top:0.6rem;"><b>${okNew} of ${learned.length}</b> learned photo(s) are read correctly with the new set` + (notChecked ? ` (${notChecked} could not be re-checked because the stored photo is a smaller copy than the original; their digits come from the original)` : '') + (totOld ? `; <b>${okOld} of ${totOld}</b> photos learned earlier are still read correctly` : '') + `. The new set has ${entries.length} learned examples in total (+${entries.length - rt.activeExamples.length}).</p>` +
                (totOld && okOld < totOld ? '<p style="color:#fbbf24;">&#9888;&#65039; Some earlier photos are no longer read correctly with this set. Publishing is not recommended.</p>' : '');
            rtEl('rt-publish-box').style.display = learned.length ? '' : 'none';
        } catch (e) { out.innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; }
        finally { btn.disabled = false; }
    }

    async function rtPublish() {
        if (!rt.newEntries || !rt.learned || !rt.learned.length) return;
        const note = rtEl('rt-note').value.trim() || ('learned from ' + rt.learned.length + ' photo(s)');
        if (!confirm(`Publish the new learned set (${rt.newEntries.length} examples, from ${rt.learned.length} new photo(s))?\n\nEvery Lab-1 device uses it from its next page load. You can go back to an earlier version at any time.`)) return;
        const btn = rtEl('rt-publish'); btn.disabled = true;
        try {
            const r = await window.BiomassAPI.publishTemplates(rt.newEntries, rt.learned.map(x => x.id), note);
            await syncLearnedTemplates();
            alert('Published as version ' + r.version + '.');
            rtLoad();
        } catch (e) { alert(e.message); }
        finally { btn.disabled = false; }
    }

    // ================= ADMIN: PHOTO STORAGE SPACE (Settings tab) =================
    const STORAGE_TRIGGER_PCT = 90, STORAGE_TARGET_PCT = 75, STORAGE_KEEP_DAYS = 60;
    const fmtMB = (b) => { const m = (Number(b) || 0) / 1048576; return (m >= 100 ? m.toFixed(0) : m.toFixed(1)) + ' MB'; };

    async function refreshStorageCard() {
        const bar = document.getElementById('storage-bar'), txt = document.getElementById('storage-status-text');
        if (!bar || !txt) return null;
        try {
            const st = await window.BiomassAPI.getStorageStatus();
            const pct = st.limit ? Math.min(100, st.bytes / st.limit * 100) : 0;
            bar.style.width = pct.toFixed(1) + '%';
            bar.style.background = pct >= STORAGE_TRIGGER_PCT ? '#ef4444' : (pct >= STORAGE_TARGET_PCT ? '#f59e0b' : '#10b981');
            txt.innerHTML = `<b>${fmtMB(st.bytes)}</b> of ${fmtMB(st.limit)} used (<b>${pct.toFixed(1)}%</b>) &middot; ${Number(st.files).toLocaleString()} photo file(s)` +
                            (st.oldest ? ` &middot; oldest from ${esc(String(st.oldest).slice(0, 10))}` : '');
            return st;
        } catch (e) {
            txt.textContent = 'Could not read the storage usage: ' + e.message + ' (has the updated db/01_schema_v2.sql been run?)';
            return null;
        }
    }

    // Plan, (optionally) ask, then delete the oldest photos. Returns the result or null when nothing was done.
    async function freeUpStorage(auto) {
        const out = document.getElementById('storage-result');
        const say = (html) => { if (out) out.innerHTML = html; };
        const plan = await window.BiomassAPI.planPhotoCleanup({ targetPercent: STORAGE_TARGET_PCT, keepDays: STORAGE_KEEP_DAYS });
        const st = plan.status, pct = st.limit ? st.bytes / st.limit * 100 : 0;
        if (plan.need <= 0) { say(`✅ Nothing to delete: storage is at ${pct.toFixed(1)}%, below the ${STORAGE_TARGET_PCT}% target.`); return null; }
        if (!plan.items.length) {
            say(`⚠️ Storage is at ${pct.toFixed(1)}%, but there are no photos old enough to delete (the newest ${STORAGE_KEEP_DAYS} days and open referee challenges are protected). Upgrade the Supabase plan or free space another way.`);
            return null;
        }
        const first = String(plan.items[0].created).slice(0, 10), last = String(plan.items[plan.items.length - 1].created).slice(0, 10);
        if (!auto) {
            const msg = `Storage is at ${pct.toFixed(1)}% (${fmtMB(st.bytes)} of ${fmtMB(st.limit)}).\n\n` +
                `To get down to ${STORAGE_TARGET_PCT}%, the OLDEST ${plan.items.length.toLocaleString()} photo(s) (taken ${first} to ${last}) will be PERMANENTLY deleted, freeing about ${fmtMB(plan.freeBytes)}.\n\n` +
                (plan.enough ? '' : `(This is all that is old enough; it will not fully reach ${STORAGE_TARGET_PCT}%.)\n\n`) +
                `The records stay; only the pictures are removed. Photos from the last ${STORAGE_KEEP_DAYS} days and of open referee challenges are never deleted.\n\nThis cannot be undone. Delete them now?`;
            if (!confirm(msg)) { say('Cancelled. Nothing was deleted.'); return null; }
        }
        say('Deleting... 0%');
        const res = await window.BiomassAPI.runPhotoCleanup(plan.items, (i, n) => say(`Deleting... ${Math.round(i / n * 100)}%`));
        say(`${res.failed ? '⚠️' : '✅'} Deleted ${res.done.toLocaleString()} old photo(s), freed about ${fmtMB(res.freed)}` + (res.failed ? `; ${res.failed} could not be removed (try again)` : '') +
            (auto ? ' (automatic)' : '') + '.');
        return res;
    }

    function initStorageCard() {
        const btnRefresh = document.getElementById('btn-storage-refresh'), btnFree = document.getElementById('btn-storage-free'), auto = document.getElementById('storage-auto');
        if (!btnRefresh || !btnFree) return;
        btnRefresh.onclick = refreshStorageCard;
        btnFree.onclick = async function () {
            btnFree.disabled = true;
            try { await freeUpStorage(false); } catch (e) { const o = document.getElementById('storage-result'); if (o) o.textContent = 'Could not free space: ' + e.message; }
            finally { btnFree.disabled = false; await refreshStorageCard(); }
        };
        if (auto) {
            try { auto.checked = localStorage.getItem('BIOMASS_AUTO_FREE_STORAGE') === '1'; } catch (e) { /* storage blocked: stays off */ }
            auto.onchange = function () { try { localStorage.setItem('BIOMASS_AUTO_FREE_STORAGE', auto.checked ? '1' : '0'); } catch (e) { /* ignore */ } };
        }
        refreshStorageCard();
    }

    // When the Admin signs in (once per page load): if the setting is on and storage is above the trigger, clean up without asking.
    let autoStorageChecked = false;
    async function autoFreeStorageIfEnabled() {
        if (autoStorageChecked) return;
        autoStorageChecked = true;
        try {
            if (localStorage.getItem('BIOMASS_AUTO_FREE_STORAGE') !== '1') return;
            const st = await window.BiomassAPI.getStorageStatus();
            if (!st.limit || st.bytes / st.limit * 100 < STORAGE_TRIGGER_PCT) return;
            const res = await freeUpStorage(true);
            if (res && res.done) alert(`Photo storage was above ${STORAGE_TRIGGER_PCT}%, so ${res.done.toLocaleString()} of the oldest photos were deleted automatically (about ${fmtMB(res.freed)} freed).`);
        } catch (e) {
            console.warn('Automatic storage clean-up skipped:', e);
        }
    }

    // --- Admin: Settings (Supabase Database Health Monitor) ---
    async function checkSupabaseHealth() {
        const badge = document.getElementById('supabase-status-badge');
        const details = document.getElementById('supabase-status-details');
        const urlDisplay = document.getElementById('supabase-url-display');
        
        if (urlDisplay) urlDisplay.textContent = window.BiomassAPI.getSupabaseUrl();
        if (badge) {
            badge.textContent = 'Checking...';
            badge.className = 'badge badge-warning';
        }
        if (details) details.innerHTML = 'Connecting to Supabase PostgreSQL REST gateway...';
        
        try {
            const health = await window.BiomassAPI.getSupabaseHealth();
            if (health.success) {
                if (badge) {
                    badge.textContent = 'Operational';
                    badge.className = 'badge badge-success';
                }
                if (details) {
                    details.innerHTML = `
                        <div style="color: #10b981; font-weight: bold; margin-bottom: 0.35rem;">✅ Supabase Connection Verified & Active</div>
                        <div><strong>Round-trip Latency:</strong> ${health.latency_ms} ms</div>
                        <div><strong>Total Consignments in DB:</strong> ${health.truck_count}</div>
                        <div><strong>Lab 1 Records:</strong> ${health.lab1_count} | <strong>Composite Batches:</strong> ${health.composite_count}</div>
                        <div><strong>Database Engine:</strong> Supabase PostgreSQL REST API</div>
                    `;
                }
            } else {
                throw new Error(health.error || 'Connection check returned false');
            }
        } catch (err) {
            if (badge) {
                badge.textContent = 'Connection Error';
                badge.className = 'badge badge-danger';
            }
            if (details) {
                details.innerHTML = `<div style="color: #ef4444; font-weight: bold;">Connection Failure: ${esc(err.message)}</div>`;
            }
        }
    }

    const btnTestSupabase = document.getElementById('btn-test-supabase-conn');
    if (btnTestSupabase) {
        btnTestSupabase.onclick = checkSupabaseHealth;
    }


    async function processScannedCode(inputCode) {
        const trimmed = inputCode.trim();
        if (!trimmed) {
            throw new Error('Code is empty');
        }

        let payload;
        try {
            // Try decrypting. If it's a legacy CODE128 plain ID, decryptPayload returns it directly.
            payload = await decryptPayload(trimmed);
        } catch (decErr) {
            // Log security exception for invalid/tampered token
            const currentUser = window.BiomassAPI.getCurrentUser();
            const username = currentUser ? currentUser.username : 'anonymous';
            await window.BiomassAPI.logActivity('Security Exception', `Invalid or tampered token scan attempt by ${username}: "${trimmed.substring(0, 30)}..."`);
            throw decErr;
        }
        
        // QR labels no longer expire — they stay valid for the whole life of the consignment.
        return payload.id;
    }

    // ================= LAB 1 STATION 1 CONTROLLER (BLIND Moisture & Fineness) =================
    function getLab1FieldVisibility() {
        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;
        // lab1m = Moisture-only login, lab1f = Fineness-only login, lab1/admin = both
        return {
            showMoisture: role !== 'lab1f',
            showFineness: role !== 'lab1m'
        };
    }

    function applyLab1RoleView() {
        const { showMoisture, showFineness } = getLab1FieldVisibility();

        const moistureGroup = document.getElementById('lab1-moisture-group');
        const finenessGroup = document.getElementById('lab1-fineness-group');
        const moistureInput = document.getElementById('lab1-moisture');
        const finenessInput = document.getElementById('lab1-fineness');

        moistureGroup.style.display = showMoisture ? '' : 'none';
        finenessGroup.style.display = showFineness ? '' : 'none';

        // A hidden required field blocks form submission, so toggle 'required' along with visibility
        moistureInput.required = showMoisture;
        // Fineness is now a computed hidden field fed by the weight-based module
        finenessInput.required = false;


        // Station title reflects which test this login is responsible for
        const titleEl = document.getElementById('lab1-station-title');
        if (showMoisture && showFineness) {
            titleEl.textContent = 'Lab Station 1 — Moisture & Fineness';
        } else if (showMoisture) {
            titleEl.textContent = 'Lab Station 1 — Moisture Testing';
        } else {
            titleEl.textContent = 'Lab Station 1 — Fineness Testing';
        }

        // Hide the corresponding column in the submissions history table
        const historyMoistureTh = document.getElementById('lab1-th-moisture');
        const historyFinenessTh = document.getElementById('lab1-th-fineness');
        if (historyMoistureTh) historyMoistureTh.style.display = showMoisture ? '' : 'none';
        if (historyFinenessTh) historyFinenessTh.style.display = showFineness ? '' : 'none';
    }

    // ===================== Scale & Moisture Analyzer OCR Engine (v2) =====================

    const ScaleOCREngine = {
        // 1. Load an image (dataUrl, Blob/File, or Video) to an offscreen Canvas
        async loadImageToCanvas(source) {
            return new Promise((resolve, reject) => {
                if (source instanceof HTMLCanvasElement) {
                    resolve(source);
                    return;
                }
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const maxDim = 1600;
                    let w = img.width;
                    let h = img.height;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) {
                            h = Math.round((h * maxDim) / w);
                            w = maxDim;
                        } else {
                            w = Math.round((w * maxDim) / h);
                            h = maxDim;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve(canvas);
                };
                img.onerror = () => reject(new Error('Failed to load scale photo for OCR processing.'));
                if (typeof source === 'string') {
                    img.src = source;
                } else if (source instanceof Blob || source instanceof File) {
                    img.src = URL.createObjectURL(source);
                } else if (source instanceof HTMLVideoElement) {
                    const canvas = document.createElement('canvas');
                    canvas.width = source.videoWidth || 1280;
                    canvas.height = source.videoHeight || 720;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
                    resolve(canvas);
                }
            });
        },

        // 2. Mode-Aware Display Type Detection
        detectScaleType(ctx, w, h, mode) {
            const imgData = ctx.getImageData(0, 0, w, h);
            const d = imgData.data;
            let redCount = 0;
            let cyanCount = 0;

            for (let i = 0; i < d.length; i += 8) {
                const r = d[i], g = d[i + 1], b = d[i + 2];
                // Glowing red LED: high saturation
                if (r > 125 && (r - g > 45) && (r - b > 45)) {
                    redCount++;
                }
                // Glowing blue/cyan LCD backlight
                if (b > 70 && g > 50 && (b - r > 15) && (g - r > 10)) {
                    cyanCount++;
                }
            }

            if (mode === 'weight') {
                // In Fineness Lab: Jansons scale is Red LED; others are precision balances
                if (redCount > 250) {
                    return 'RED_LED';
                }
                return 'WHITE_LCD';
            } else {
                // In Moisture Lab: Aczet MB 50 has Cyan/Blue backlight; Sartorius is White LCD
                if (cyanCount > 1000) {
                    return 'BLUE_LCD';
                }
                return 'WHITE_LCD';
            }
        },

        // Otsu's thresholding helper
        calculateOtsu(vals) {
            const hist = new Int32Array(256);
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i] < 0 ? 0 : (vals[i] > 255 ? 255 : (vals[i] | 0));
                hist[v]++;
            }
            const total = vals.length;
            let sumAll = 0;
            for (let i = 0; i < 256; i++) sumAll += i * hist[i];
            let sumB = 0, wB = 0, varMax = 0, bestT = 128;
            for (let t = 0; t < 256; t++) {
                wB += hist[t];
                if (wB === 0) continue;
                const wF = total - wB;
                if (wF === 0) break;
                sumB += t * hist[t];
                const mB = sumB / wB;
                const mF = (sumAll - sumB) / wF;
                const varBetween = wB * wF * (mB - mF) * (mB - mF);
                if (varBetween > varMax) {
                    varMax = varBetween;
                    bestT = t;
                }
            }
            return bestT;
        },

        // 3. Robust 7-Segment Hardware Parser for Red LED Scales (Jansons)
        parse7SegmentRedLed(canvas) {
            const w = canvas.width;
            const h = canvas.height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.getImageData(0, 0, w, h);
            const d = imgData.data;

            const redPts = [];
            const xHist = new Int32Array(w);
            for (let y = 0; y < h; y++) {
                const row = y * w * 4;
                for (let x = 0; x < w; x++) {
                    const idx = row + x * 4;
                    const r = d[idx], g = d[idx + 1], b = d[idx + 2];
                    if (r > 125 && (r - g > 55) && (r - b > 55)) {
                        redPts.push({ x, y });
                        xHist[x]++;
                    }
                }
            }

            if (redPts.length < 150) return null;

            // X-clustering to drop single indicator LED
            const xClusters = [];
            let curXc = [];
            for (let x = 0; x < w; x++) {
                if (xHist[x] > 4) {
                    if (curXc.length === 0 || x - curXc[curXc.length - 1] < 35) {
                        curXc.push(x);
                    } else {
                        xClusters.push(curXc);
                        curXc = [x];
                    }
                }
            }
            if (curXc.length > 0) xClusters.push(curXc);
            if (xClusters.length === 0) return null;

            xClusters.sort((a, b) => {
                let sumA = 0, sumB = 0;
                for (let i = 0; i < a.length; i++) sumA += xHist[a[i]];
                for (let i = 0; i < b.length; i++) sumB += xHist[b[i]];
                return sumB - sumA;
            });

            const bestXc = xClusters[0];
            const x0 = bestXc[0], x1 = bestXc[bestXc.length - 1];

            // Y-clustering within the best X cluster (eliminates reflections/sticker)
            const yHist = new Int32Array(h);
            for (let i = 0; i < redPts.length; i++) {
                const p = redPts[i];
                if (p.x >= x0 && p.x <= x1) {
                    yHist[p.y]++;
                }
            }

            const yClusters = [];
            let curYc = [];
            for (let y = 0; y < h; y++) {
                if (yHist[y] > 4) {
                    if (curYc.length === 0 || y - curYc[curYc.length - 1] < 25) {
                        curYc.push(y);
                    } else {
                        yClusters.push(curYc);
                        curYc = [y];
                    }
                }
            }
            if (curYc.length > 0) yClusters.push(curYc);
            if (yClusters.length === 0) return null;

            yClusters.sort((a, b) => {
                let sumA = 0, sumB = 0;
                for (let i = 0; i < a.length; i++) sumA += yHist[a[i]];
                for (let i = 0; i < b.length; i++) sumB += yHist[b[i]];
                return sumB - sumA;
            });

            const bestYc = yClusters[0];
            const y0 = bestYc[0], y1 = bestYc[bestYc.length - 1];

            const bw = x1 - x0 + 1;
            const bh = y1 - y0 + 1;
            if (bw < 30 || bh < 15) return null;

            // Build binary grid
            const grid = new Uint8Array(bw * bh);
            for (let i = 0; i < redPts.length; i++) {
                const p = redPts[i];
                if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
                    grid[(p.y - y0) * bw + (p.x - x0)] = 1;
                }
            }

            const truth = {
                '0': [1, 1, 1, 0, 1, 1, 1],
                '1': [0, 0, 1, 0, 0, 1, 0],
                '2': [1, 0, 1, 1, 1, 0, 1],
                '3': [1, 0, 1, 1, 0, 1, 1],
                '4': [0, 1, 1, 1, 0, 1, 0],
                '5': [1, 1, 0, 1, 0, 1, 1],
                '6': [1, 1, 0, 1, 1, 1, 1],
                '7': [1, 0, 1, 0, 0, 1, 0],
                '8': [1, 1, 1, 1, 1, 1, 1],
                '9': [1, 1, 1, 1, 0, 1, 1]
            };

            function checkZone(sx0, sx1, sy0, sy1, subW, subOffset) {
                let hit = 0, tot = 0;
                const yStart = Math.floor(sy0 * bh), yEnd = Math.floor(sy1 * bh);
                const xStart = Math.floor(sx0 * subW), xEnd = Math.floor(sx1 * subW);
                for (let y = yStart; y < yEnd; y++) {
                    const shear = Math.floor((bh - y) * 0.12);
                    for (let x = xStart; x < xEnd; x++) {
                        const gx = subOffset + x + shear - Math.floor(bh * 0.06);
                        if (gx >= 0 && gx < bw && y >= 0 && y < bh) {
                            tot++;
                            if (grid[y * bw + gx]) hit++;
                        }
                    }
                }
                return tot > 0 ? (hit / tot > 0.20) : false;
            }

            function checkMid(subW, subOffset) {
                let hit = 0, tot = 0;
                const yStart = Math.floor(0.44 * bh), yEnd = Math.floor(0.56 * bh);
                const xStart = Math.floor(0.35 * subW), xEnd = Math.floor(0.65 * subW);
                for (let y = yStart; y < yEnd; y++) {
                    const shear = Math.floor((bh - y) * 0.12);
                    for (let x = xStart; x < xEnd; x++) {
                        const gx = subOffset + x + shear - Math.floor(bh * 0.06);
                        if (gx >= 0 && gx < bw && y >= 0 && y < bh) {
                            tot++;
                            if (grid[y * bw + gx]) hit++;
                        }
                    }
                }
                return tot > 0 ? (hit / tot > 0.30) : false;
            }

            const numDigits = (bw / bh < 2.0) ? 3 : 4;
            const digitW = bw / numDigits;
            const digits = [];

            for (let i = 0; i < numDigits; i++) {
                const subOffset = Math.floor(i * digitW);
                const subW = Math.floor((i + 1) * digitW) - subOffset;

                const top  = checkZone(0.20, 0.80, 0.05, 0.22, subW, subOffset);
                const topL = checkZone(0.05, 0.40, 0.20, 0.44, subW, subOffset);
                const topR = checkZone(0.60, 0.95, 0.20, 0.44, subW, subOffset);
                const mid  = checkMid(subW, subOffset);
                const botL = checkZone(0.05, 0.40, 0.56, 0.80, subW, subOffset);
                const botR = checkZone(0.60, 0.95, 0.56, 0.80, subW, subOffset);
                const bot  = checkZone(0.20, 0.80, 0.78, 0.95, subW, subOffset);

                const cur = [top ? 1 : 0, topL ? 1 : 0, topR ? 1 : 0, mid ? 1 : 0, botL ? 1 : 0, botR ? 1 : 0, bot ? 1 : 0];

                let bestChar = '0', minDiff = 999;
                for (const [ch, pat] of Object.entries(truth)) {
                    let diff = 0;
                    for (let k = 0; k < 7; k++) diff += Math.abs(pat[k] - cur[k]);
                    if (ch === '0' && mid) diff += 3;
                    if (ch === '8' && !mid) diff += 3;
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestChar = ch;
                    }
                }
                digits.push(bestChar);
            }

            let numStr;
            if (numDigits === 4) {
                numStr = `${digits[0]}.${digits[1]}${digits[2]}${digits[3]}`;
            } else {
                numStr = `0.${digits[0]}${digits[1]}${digits[2]}`;
            }

            const val = parseFloat(numStr);
            if (!isNaN(val) && val >= 0.001 && val < 40.0) {
                return {
                    value: val,
                    formatted: val.toFixed(3),
                    digits: numStr,
                    scaleType: 'Jansons Red 7-Segment LED',
                    engine: 'Hardware 7-Segment Analyzer'
                };
            }
            return null;
        },

        // 4. Preprocess Canvas for OCR with screen cropping and morphological dilation
        preprocessForOCR(canvas, scaleType) {
            const w = canvas.width;
            const h = canvas.height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.getImageData(0, 0, w, h);
            const d = imgData.data;

            if (scaleType === 'BLUE_LCD') {
                // Find cyan/blue pixels bounding box
                let minX = w, maxX = 0, minY = h, maxY = 0;
                const cyanLums = [];
                for (let y = 0; y < h; y++) {
                    const row = y * w * 4;
                    for (let x = 0; x < w; x++) {
                        const idx = row + x * 4;
                        const r = d[idx], g = d[idx + 1], b = d[idx + 2];
                        const isCyan = (b > 65 && g > 45 && b > r + 15 && g > r + 10);
                        if (isCyan) {
                            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                            cyanLums.push(lum);
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }
                }

                if (cyanLums.length > 500 && maxX > minX && maxY > minY) {
                    const otsuThresh = this.calculateOtsu(cyanLums);
                    const cropW = maxX - minX + 1;
                    const cropH = maxY - minY + 1;

                    // Dedicated cropped LCD canvas (black digits on white)
                    const lcdCanvas = document.createElement('canvas');
                    lcdCanvas.width = cropW;
                    lcdCanvas.height = cropH;
                    const lcdCtx = lcdCanvas.getContext('2d');
                    const lcdImgData = lcdCtx.createImageData(cropW, cropH);
                    const lcdD = lcdImgData.data;

                    for (let y = minY; y <= maxY; y++) {
                        const row = y * w * 4;
                        const outRow = (y - minY) * cropW * 4;
                        for (let x = minX; x <= maxX; x++) {
                            const idx = row + x * 4;
                            const outIdx = outRow + (x - minX) * 4;
                            const r = d[idx], g = d[idx + 1], b = d[idx + 2];
                            const isCyan = (b > 60 && g > 40 && b > r + 10 && g > r + 5);
                            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                            if (isCyan && lum > otsuThresh && g > 90) {
                                lcdD[outIdx] = 0;
                                lcdD[outIdx + 1] = 0;
                                lcdD[outIdx + 2] = 0;
                            } else {
                                lcdD[outIdx] = 255;
                                lcdD[outIdx + 1] = 255;
                                lcdD[outIdx + 2] = 255;
                            }
                            lcdD[outIdx + 3] = 255;
                        }
                    }
                    lcdCtx.putImageData(lcdImgData, 0, 0);

                    // Dilate 1px to connect segment gaps
                    const dilCanvas = document.createElement('canvas');
                    dilCanvas.width = cropW;
                    dilCanvas.height = cropH;
                    const dilCtx = dilCanvas.getContext('2d');
                    const dilImgData = dilCtx.createImageData(cropW, cropH);
                    const dilD = dilImgData.data;
                    dilD.set(lcdD);

                    for (let y = 1; y < cropH - 1; y++) {
                        for (let x = 1; x < cropW - 1; x++) {
                            const idx = (y * cropW + x) * 4;
                            if (lcdD[idx] === 0) {
                                for (let dy = -1; dy <= 1; dy++) {
                                    for (let dx = -1; dx <= 1; dx++) {
                                        const nIdx = ((y + dy) * cropW + (x + dx)) * 4;
                                        dilD[nIdx] = 0;
                                        dilD[nIdx + 1] = 0;
                                        dilD[nIdx + 2] = 0;
                                    }
                                }
                            }
                        }
                    }
                    dilCtx.putImageData(dilImgData, 0, 0);

                    // Create reading sub-canvas focusing on central digits (excluding top & bottom text)
                    const readingCanvas = document.createElement('canvas');
                    const rw = Math.floor(cropW * 0.65);
                    const rh = Math.floor(cropH * 0.48);
                    readingCanvas.width = rw;
                    readingCanvas.height = rh;
                    const rCtx = readingCanvas.getContext('2d');
                    rCtx.fillStyle = '#ffffff';
                    rCtx.fillRect(0, 0, rw, rh);
                    rCtx.drawImage(dilCanvas, Math.floor(cropW * 0.20), Math.floor(cropH * 0.26), rw, rh, 0, 0, rw, rh);

                    return { full: dilCanvas, central: readingCanvas };
                }
            } else if (scaleType === 'WHITE_LCD') {
                const lums = [];
                for (let i = 0; i < d.length; i += 8) {
                    lums.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
                }
                const thresh = this.calculateOtsu(lums);
                let minX = w, maxX = 0, minY = h, maxY = 0;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const idx = (y * w + x) * 4;
                        const lum = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                        if (lum > thresh) {
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }
                }

                if (maxX - minX > 100 && maxY - minY > 50) {
                    const sw = maxX - minX + 1, sh = maxY - minY + 1;
                    const sCanvas = document.createElement('canvas');
                    sCanvas.width = sw; sCanvas.height = sh;
                    const sCtx = sCanvas.getContext('2d');
                    const sImg = sCtx.createImageData(sw, sh);
                    const sD = sImg.data;
                    for (let y = minY; y <= maxY; y++) {
                        for (let x = minX; x <= maxX; x++) {
                            const idx = (y * w + x) * 4;
                            const outIdx = ((y - minY) * sw + (x - minX)) * 4;
                            const lum = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                            const isDigit = (lum < thresh);
                            sD[outIdx] = isDigit ? 0 : 255;
                            sD[outIdx + 1] = isDigit ? 0 : 255;
                            sD[outIdx + 2] = isDigit ? 0 : 255;
                            sD[outIdx + 3] = 255;
                        }
                    }
                    sCtx.putImageData(sImg, 0, 0);
                    return { full: sCanvas };
                }
            }

            // Fallback general binarized canvas
            const outCanvas = document.createElement('canvas');
            outCanvas.width = w; outCanvas.height = h;
            const outCtx = outCanvas.getContext('2d');
            const outImgData = outCtx.createImageData(w, h);
            const outD = outImgData.data;
            for (let i = 0; i < outD.length; i += 4) {
                outD[i] = 255; outD[i + 1] = 255; outD[i + 2] = 255; outD[i + 3] = 255;
            }
            outCtx.putImageData(outImgData, 0, 0);
            return { full: outCanvas };
        },

        // 5. Run Tesseract.js with character whitelist
        async runTesseract(canvas, mode) {
            if (typeof Tesseract === 'undefined' || !canvas) return null;
            try {
                const whitelist = (mode === 'moisture') 
                    ? '0123456789.%M/ ' 
                    : '0123456789.kgKg ';

                const res = await Tesseract.recognize(canvas, 'eng', {
                    tessedit_char_whitelist: whitelist,
                    logger: () => {}
                });
                return res && res.data ? res.data.text : null;
            } catch (e) {
                console.warn('Tesseract OCR engine warning:', e);
                return null;
            }
        },

        // 6. Regex & Mathematical Space-Merging Extraction
        extractReading(text, mode) {
            if (!text) return null;
            let clean = text.replace(/,/g, '.').replace(/[\r\n]+/g, ' ');

            // Repeatedly merge space-separated digits (e.g. "13.4 16" -> "13.416", "0 . 0 5 2" -> "0.052")
            let prev;
            do {
                prev = clean;
                clean = clean.replace(/(\d)\s+(\d)/g, '$1$2');
                clean = clean.replace(/(\d)\s+\.\s*(\d)/g, '$1.$2');
                clean = clean.replace(/(\d)\s*\.\s+(\d)/g, '$1.$2');
            } while (prev !== clean);

            if (mode === 'moisture') {
                // Priority 1: Match moisture percentage reading with decimal
                const pctMatch = clean.match(/(\d{1,2}\.\d{1,3})\s*(?:%|%M|%\s*M|%\/M|\/M|%m|7\.M|7M|M)?/i);
                if (pctMatch) {
                    const v = parseFloat(pctMatch[1]);
                    if (!isNaN(v) && v >= 0.5 && v <= 60.0) return v;
                }

                // Priority 2: 4 or 5 digit integer where decimal dot was missed
                const intMatches = clean.match(/\b(\d{3,5})\b/g);
                if (intMatches) {
                    for (const s of intMatches) {
                        if (s.length === 5) {
                            const v = parseInt(s, 10) / 1000.0;
                            if (v >= 10.0 && v <= 50.0) return v;
                        } else if (s.length === 4) {
                            const v = parseInt(s, 10) / 1000.0;
                            if (v >= 1.0 && v <= 10.0) return v;
                        } else if (s.length === 3) {
                            const v = parseInt(s, 10) / 10.0;
                            if (v >= 5.0 && v <= 40.0) return v;
                        }
                    }
                }
            } else {
                // Weight reading
                // Priority 1: Decimal weight in kg (0.001 to 35.0 kg)
                const wMatch = clean.match(/(\d{1,2}\.\d{2,3})\s*(?:kg|k\s*g|g)?/i);
                if (wMatch) {
                    const v = parseFloat(wMatch[1]);
                    if (!isNaN(v) && v >= 0.001 && v <= 35.0) return v;
                }

                // Priority 2: 3 or 4 digit integer where dot was missed (e.g. 0052 -> 0.052, 1942 -> 1.942)
                const intMatches = clean.match(/\b(\d{3,4})\b/g);
                if (intMatches) {
                    for (const s of intMatches) {
                        const v = parseInt(s, 10) / 1000.0;
                        if (v >= 0.001 && v <= 35.0) return v;
                    }
                }
            }
            return null;
        },

        // 7. Master recognize function
        async recognize(imageSource, options = {}) {
            const mode = options.mode || 'weight';
            const canvas = await this.loadImageToCanvas(imageSource);
            const w = canvas.width;
            const h = canvas.height;
            const ctx = canvas.getContext('2d');
            const scaleType = this.detectScaleType(ctx, w, h, mode);

            // Path 1: For Red LED scale, try instant 7-segment hardware analyzer first
            if (scaleType === 'RED_LED') {
                const segResult = this.parse7SegmentRedLed(canvas);
                if (segResult) {
                    return {
                        success: true,
                        value: segResult.value,
                        formatted: segResult.formatted,
                        scaleType: segResult.scaleType,
                        engine: segResult.engine
                    };
                }
            }

            // Path 2: Preprocess canvas with morphology and run Tesseract OCR
            const prep = this.preprocessForOCR(canvas, scaleType);
            const canvasesToTry = [];
            if (prep && prep.central) canvasesToTry.push(prep.central);
            if (prep && prep.full) canvasesToTry.push(prep.full);
            if (!prep || (!prep.central && !prep.full)) canvasesToTry.push(prep || canvas);

            for (const c of canvasesToTry) {
                const ocrText = await this.runTesseract(c, mode);
                if (ocrText) {
                    const extracted = this.extractReading(ocrText, mode);
                    if (extracted !== null) {
                        const typeLabel = scaleType === 'BLUE_LCD' ? 'Aczet Blue Backlit LCD' : (scaleType === 'RED_LED' ? 'Jansons Red LED Scale' : 'Digital Precision Balance');
                        return {
                            success: true,
                            value: extracted,
                            formatted: mode === 'weight' ? extracted.toFixed(3) : extracted.toFixed(extracted.toString().includes('.') && extracted.toString().split('.')[1].length === 3 ? 3 : 2),
                            scaleType: typeLabel,
                            engine: 'Optical Character Recognition (OCR)',
                            rawText: ocrText.trim()
                        };
                    }
                }
            }

            // Path 3: Fallback on original canvas
            if (typeof Tesseract !== 'undefined') {
                const origText = await this.runTesseract(canvas, mode);
                if (origText) {
                    const extracted = this.extractReading(origText, mode);
                    if (extracted !== null) {
                        return {
                            success: true,
                            value: extracted,
                            formatted: mode === 'weight' ? extracted.toFixed(3) : extracted.toFixed(2),
                            scaleType: 'Direct Visual Scale Reading',
                            engine: 'Direct OCR Engine',
                            rawText: origText.trim()
                        };
                    }
                }
            }

            return {
                success: false,
                scaleType: scaleType,
                error: 'Could not detect clear digital numbers from this photo. Please ensure camera is focused on the digital scale display without glare.'
            };
        }
    };

    // Make ScaleOCREngine globally accessible
    window.ScaleOCREngine = ScaleOCREngine;

    // ===================== Lab 1 State & Controllers =====================

    const moistureState = {
        photo: null,
        reading: null,
        scaleType: null
    };

    const finenessState = {
        initialPhoto: null,
        initialReading: null,
        finalPhoto: null,
        finalReading: null
    };

    // Scale-reading proof photos must be taken NOW. A photo picked from an old gallery image (or reused from
    // another sample) is refused. (Client-side control: it raises the bar; the photo is also kept for admin audit.)
    const MAX_PHOTO_AGE_MS = 15 * 60 * 1000;
    function isFreshCapture(file) {
        if (!file || !file.lastModified) return true;      // some WebViews do not expose the timestamp
        const age = Date.now() - file.lastModified;
        if (age > MAX_PHOTO_AGE_MS) {
            alert('This photo is more than 15 minutes old.\n\nPlease take a NEW photo of the scale display now — old or reused photos cannot be used as reading proof.');
            return false;
        }
        return true;
    }

    function readImageAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read the captured photo.'));
            reader.readAsDataURL(file);
        });
    }

    // ===================== AUTO-READ from a meter photo: camera photo -> reader -> operator confirms =====================
    // Used by three Lab-1 fields: the moisture %, and the initial / final fineness weights. The operator only photographs
    // the meter / scale display; the trained offline reader (moisture-ocr.js + lib/ocr/) finds the number and shows it WITH
    // the digits it read; the operator must confirm it matches the display. Up to AUTO_READ_MAX_ATTEMPTS photos per field;
    // if none is accepted the field falls back to the old way (attach a photo + type the value). The reader never fills a
    // value without that confirmation, and a reading it is not confident about (conf < MoistureOCR.MIN_CONFIDENCE) cannot
    // be accepted at all. Which kinds are switched on is set in moisture-ocr.js (window.MeterAutoRead).
    const AUTO_READ_MAX_ATTEMPTS = 3;
    const LOW_CONF_TRAIN = 50;           // a confirmed reading below this score is kept for reader training
    const lowConf = {};                  // key -> { conf, value } of the reading the operator confirmed although the reader was < 50 % sure

    // For a reading the reader was < 50 % sure about: (1) a training photo cut down from the ORIGINAL (the stored audit photo is smaller and less sharp than what the
    // reader actually saw) and (2) for a weight, the digit examples the reader cuts out of that original, labelled with the value the operator confirmed.
    async function captureTrainingMaterial(slot, kind, p) {
        const big = await compressScaleImage(p.dataUrl, 2400, 0.9);
        slot.photo = big.length * 0.75 > 2800000 ? await compressScaleImage(p.dataUrl, 1800, 0.8) : big;
        if (kind !== 'weight' || !window.LedWeightReader) return;
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = p.dataUrl; });
        const lab = Number(p.value).toFixed(3).replace('.', '');
        const ex = window.LedWeightReader.examples(img, [-2, -1, 0, 1, 2], [-5, 0, 5], lab.length);
        if (!ex.found) return;
        const seen = new Set(), entries = [];
        ex.sets.forEach(s => { if (s.n !== lab.length) return; s.grids.forEach(gs => gs.forEach((g, i) => { const k = lab[i] + g; if (!seen.has(k)) { seen.add(k); entries.push(k); } })); });
        if (entries.length) slot.examples = entries.slice(0, 400);
    }

    function createAutoRead(cfg) {
        const key = cfg.key;
        const unit = cfg.kind === 'weight' ? 'kg' : '%M';
        const st = {
            enabled: true,        // false while this field is already recorded / not editable for this role
            mode: 'auto',         // 'auto' (scanning) | 'accepted' (value confirmed) | 'manual' (fallback)
            attempts: 0,
            busy: false,
            pending: null,        // { value, conf, crop, dataUrl, uncertain } waiting for the operator's decision
            unavailable: false,   // the reader could not load / run on this device -> manual, with a notice
            session: 0            // bumped on every reset so a slow read can never land on a different sample
        };
        const el = (id) => document.getElementById(id);
        const part = (suffix) => el(key + '-' + suffix);
        const configOn = () => (window.MeterAutoRead || {})[cfg.kind] !== false;
        const startsManual = () => st.unavailable || !configOn();

        function mount() {
            const host = el(key + '-auto-host');
            if (!host || host.dataset.mounted) return;
            host.dataset.mounted = '1';
            host.innerHTML =
                '<div id="' + key + '-auto-panel">' +
                  '<div class="scale-photo-row" style="margin-top: 0.5rem;">' +
                    '<button type="button" class="btn btn-primary btn-sm" id="btn-' + key + '-scan">📷 Scan ' + cfg.scanLabel + '</button>' +
                    '<input type="file" id="' + key + '-scan-input" accept="image/*" capture="environment" style="display: none;">' +
                    '<span id="' + key + '-attempt-badge" class="badge badge-pending"></span>' +
                  '</div>' +
                  '<div id="' + key + '-auto-msg" class="auto-read-msg" style="display: none;"></div>' +
                  '<div id="' + key + '-review" class="auto-read-review" style="display: none;">' +
                    '<div class="auto-read-read">Reader sees: <strong id="' + key + '-review-value">--</strong> ' + unit + ' <span id="' + key + '-review-conf" class="badge badge-pending"></span></div>' +
                    '<img id="' + key + '-review-crop" class="auto-read-crop" alt="Digits the reader found">' +
                    '<div class="auto-read-q" id="' + key + '-review-q"></div>' +
                    '<div class="scale-photo-row">' +
                      '<button type="button" class="btn btn-primary btn-sm" id="btn-' + key + '-accept">✔ Yes, use this value</button>' +
                      '<button type="button" class="btn btn-secondary btn-sm" id="btn-' + key + '-retake">↻ No, retake photo</button>' +
                    '</div>' +
                  '</div>' +
                '</div>';
        }

        function autoMsg(text, color) {
            const m = part('auto-msg');
            if (!m) return;
            m.textContent = text || '';
            m.style.color = color || '#10b981';
            m.style.display = text ? 'block' : 'none';
        }
        function statusMsg(text, color) {
            const m = el(cfg.statusMsgId);
            if (!m) return;
            m.textContent = text || '';
            m.style.color = color || '#10b981';
            m.style.display = text ? 'block' : 'none';
        }
        function unavailableNotice() {
            statusMsg('⚠️ Automatic reading is not available on this device. Attach a photo of the display and type the reading.', '#f59e0b');
        }

        function apply() {
            mount();
            const input = el('lab1-' + key), autoPanel = part('auto-panel'), manualRow = part('manual-row');
            const scanBtn = el('btn-' + key + '-scan'), badge = part('attempt-badge'), review = part('review');
            if (!input || !autoPanel || !manualRow || !scanBtn || !badge || !review) return;

            if (!st.enabled) {                   // nothing to do for this field / role
                autoPanel.style.display = 'none';
                manualRow.style.display = 'none';
                return;
            }
            const manual = st.mode === 'manual';
            autoPanel.style.display = manual ? 'none' : '';
            manualRow.style.display = manual ? 'flex' : 'none';
            input.readOnly = !manual;            // typing is only possible in the manual fallback
            input.placeholder = manual ? '0.000' : 'Scan the display';

            const status = part('photo-status');
            if (status && !cfg.hasPhoto() && st.mode !== 'accepted') {
                status.textContent = manual ? 'Photo Required' : 'Scan Required';
                status.className = 'badge badge-pending';
            }
            if (manual) return;

            const left = AUTO_READ_MAX_ATTEMPTS - st.attempts;
            if (st.mode === 'accepted') {
                badge.textContent = '✔ Confirmed (attempt ' + st.attempts + ' of ' + AUTO_READ_MAX_ATTEMPTS + ')';
                badge.className = 'badge badge-success';
            } else if (st.pending) {
                badge.textContent = 'Attempt ' + st.attempts + ' of ' + AUTO_READ_MAX_ATTEMPTS + ' - check below';
                badge.className = 'badge badge-pending';
            } else if (st.attempts === 0) {
                badge.textContent = AUTO_READ_MAX_ATTEMPTS + ' attempts available';
                badge.className = 'badge badge-pending';
            } else {
                badge.textContent = left + ' attempt' + (left === 1 ? '' : 's') + ' left';
                badge.className = 'badge badge-pending';
            }
            scanBtn.textContent = st.mode === 'accepted' ? '↻ Scan Again' : '📷 Scan ' + cfg.scanLabel;
            scanBtn.disabled = st.busy || !!st.pending || (st.mode === 'accepted' && st.attempts >= AUTO_READ_MAX_ATTEMPTS);

            review.style.display = st.pending ? '' : 'none';
            if (st.pending) {
                const p = st.pending;
                part('review-value').textContent = p.value;
                part('review-crop').src = p.crop || '';
                const conf = part('review-conf');
                conf.textContent = (p.uncertain ? 'Not sure - ' : 'Confidence ') + Math.round(p.conf) + '%';
                conf.className = 'badge ' + (p.uncertain ? 'badge-warning' : 'badge-success');
                review.classList.toggle('is-uncertain', p.uncertain);
                part('review-q').textContent = p.uncertain
                    ? '⚠️ The reader is only ' + Math.round(p.conf) + '% sure. Look at the ' + cfg.deviceName + ' and at the digits above: does the number match EXACTLY? If yes, confirm it; if there is any doubt, retake the photo.'
                    : 'Does this exactly match the number on the ' + cfg.deviceName + '?';
                el('btn-' + key + '-accept').textContent = p.uncertain ? '✔ Yes, it matches the display - use this value' : '✔ Yes, use this value';
            }
        }

        function reset() {
            lowConf[key] = null;
            st.session += 1;
            st.attempts = 0;
            st.busy = false;
            st.pending = null;
            st.mode = startsManual() ? 'manual' : 'auto';
            mount();
            autoMsg('');
            const scanInput = part('scan-input');
            if (scanInput) scanInput.value = '';
            apply();
            if (st.mode === 'manual' && st.enabled && st.unavailable && configOn()) unavailableNotice();
        }

        function goManual(reason) {
            st.session += 1;
            st.mode = 'manual';
            st.pending = null;
            st.busy = false;
            autoMsg('');
            apply();
            statusMsg('⚠️ ' + reason + ' Attach a photo of the display (Live Camera or Select Photo) and type the reading.', '#f59e0b');
        }

        function clearAccepted() {
            lowConf[key] = null;
            const input = el('lab1-' + key);
            if (input) input.value = '';
            cfg.clearState();
            const preview = part('photo-preview');
            if (preview) { preview.removeAttribute('src'); preview.style.display = 'none'; }
            const placeholder = part('photo-placeholder');
            if (placeholder) placeholder.style.display = 'flex';
            const status = part('photo-status');
            if (status) { status.textContent = 'Scan Required'; status.className = 'badge badge-pending'; }
            statusMsg('');
            st.mode = 'auto';
            if (cfg.afterChange) cfg.afterChange();
        }

        async function onScanFile(file) {
            if (!file || st.busy || !st.enabled || st.mode === 'manual') return;
            if (!isFreshCapture(file)) return;

            const session = st.session;
            if (st.mode === 'accepted') clearAccepted();    // a new photo replaces the earlier confirmed value
            st.pending = null;
            st.attempts += 1;
            st.busy = true;
            autoMsg(cfg.kind === 'weight'
                ? '⏳ Reading the display... this can take up to 30 seconds (the first scan after opening this page takes longer while the reader loads)'
                : '⏳ Reading the display... (the first scan after opening this page can take a minute while the reader loads)', '#94a3b8');
            apply();

            let result = null, dataUrl = '', failure = null;
            try {
                if (!window.MoistureOCR) throw new Error('Meter reader is not loaded');
                const opts = cfg.kind === 'weight'
                    ? { kind: 'weight', decimals: (window.MeterAutoRead || {}).weightDecimals }
                    : { kind: 'moisture' };
                result = await window.MoistureOCR.read(file, opts);
                dataUrl = await readImageAsDataUrl(file);
            } catch (err) {
                failure = err;
            }
            if (session !== st.session) return;   // the operator moved on to another sample meanwhile
            st.busy = false;

            if (failure) {
                console.error('Meter reader failed:', failure);
                st.attempts -= 1;                 // a reader fault is not one of the operator's attempts
                st.unavailable = true;
                goManual('The automatic reader could not run on this device.');
                return;
            }

            const num = result ? Number(result.value) : NaN;
            if (!isFinite(num) || !cfg.valid(num)) {
                autoMsg('❌ No reading could be found in that photo. Hold the phone steady, fill the frame with the display, avoid glare, then take another photo.', '#ef4444');
            } else {
                const uncertain = result.conf < window.MoistureOCR.MIN_CONFIDENCE;
                st.pending = { value: result.value, conf: result.conf, crop: result.crop, dataUrl, uncertain };
                autoMsg('');
            }
            if (st.attempts >= AUTO_READ_MAX_ATTEMPTS && !st.pending) {
                goManual('All ' + AUTO_READ_MAX_ATTEMPTS + ' automatic attempts were used without an accepted reading.');
                return;
            }
            apply();
        }

        async function accept() {
            const p = st.pending;
            if (!p || st.busy) return;
            // a low-confidence reading can still be used, but only when the operator says in so many words that it matches the display
            if (p.uncertain && !confirm('The reader was only ' + Math.round(p.conf) + '% sure.\n\nLook at the ' + cfg.deviceName + ' now. Is the display showing exactly  ' + p.value + ' ' + unit + ' ?\n\nPress OK only if it matches exactly.')) return;
            const session = st.session;
            st.busy = true;
            apply();
            try {
                await handleScaleImage(cfg.target, p.dataUrl);   // compresses, shows the thumbnail, stores the audit photo
            } finally {
                if (session === st.session) st.busy = false;
            }
            if (session !== st.session) return;
            const input = el('lab1-' + key);
            if (input) input.value = p.value;
            cfg.onAccept(Number(p.value), p);
            lowConf[key] = p.conf < LOW_CONF_TRAIN ? { conf: Math.round(p.conf), value: Number(p.value) } : null;
            if (lowConf[key]) captureTrainingMaterial(lowConf[key], cfg.kind, p).catch(() => { /* the sample is still kept without the extras */ });
            st.mode = 'accepted';
            st.pending = null;
            autoMsg('');
            const status = part('photo-status');
            if (status) { status.textContent = '📸 Auto-read ' + p.value + ' ' + unit + (p.uncertain ? ' (operator confirmed, low confidence)' : ' (confirmed)'); status.className = 'badge badge-success'; }
            statusMsg('Value read from the display photo and confirmed by the operator' + (p.uncertain ? ' (the reader was only ' + Math.round(p.conf) + '% sure)' : '') + '. Photo attached for supervisor audit.', '#10b981');
            apply();
            if (cfg.afterChange) cfg.afterChange();
        }

        function retake() {
            if (st.busy) return;
            st.pending = null;
            if (st.attempts >= AUTO_READ_MAX_ATTEMPTS) {
                goManual('All ' + AUTO_READ_MAX_ATTEMPTS + ' automatic attempts were used without an accepted reading.');
                return;
            }
            autoMsg('Take another photo of the display.', '#94a3b8');
            apply();
            const scanInput = part('scan-input');
            if (scanInput) { scanInput.value = ''; scanInput.click(); }   // straight back to the camera
        }

        function setup() {
            mount();
            const scanBtn = el('btn-' + key + '-scan'), scanInput = part('scan-input');
            if (scanBtn && scanInput) {
                scanBtn.onclick = () => { scanInput.value = ''; scanInput.click(); };
                scanInput.onchange = (e) => {
                    const file = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (file) onScanFile(file);
                };
            }
            const acceptBtn = el('btn-' + key + '-accept'), retakeBtn = el('btn-' + key + '-retake');
            if (acceptBtn) acceptBtn.onclick = accept;
            if (retakeBtn) retakeBtn.onclick = retake;
        }

        return {
            setup, reset, apply, goManual,
            mode: () => st.mode,
            isConfigOn: configOn,
            setEnabled(enabled) { st.enabled = enabled; apply(); },
            setUnavailable(flag) { st.unavailable = flag; },
            canSwitchToManualNow: () => st.enabled && st.mode === 'auto' && st.attempts === 0 && !st.busy
        };
    }

    const autoRead = {
        'moisture': createAutoRead({
            key: 'moisture', kind: 'moisture', target: 'moisture', scanLabel: 'Moisture Display', deviceName: 'moisture meter',
            statusMsgId: 'moisture-ocr-status-msg',
            valid: (n) => n > 0 && n <= 60,
            hasPhoto: () => !!moistureState.photo,
            clearState: () => { moistureState.photo = null; moistureState.reading = null; moistureState.scaleType = null; },
            onAccept: (n, p) => { moistureState.reading = n; moistureState.scaleType = 'Auto-read (operator confirmed' + (p && p.uncertain ? ', low confidence ' + Math.round(p.conf) + '%' : '') + ')'; }
        }),
        'fineness-initial': createAutoRead({
            key: 'fineness-initial', kind: 'weight', target: 'fineness-initial', scanLabel: 'Initial Weight', deviceName: 'scale',
            statusMsgId: 'fineness-initial-ocr-status',
            valid: (n) => n > 0 && n <= 40,
            hasPhoto: () => !!finenessState.initialPhoto,
            clearState: () => { finenessState.initialPhoto = null; finenessState.initialReading = null; },
            onAccept: (n) => { finenessState.initialReading = n; },
            afterChange: () => updateFinenessCalc()
        }),
        'fineness-final': createAutoRead({
            key: 'fineness-final', kind: 'weight', target: 'fineness-final', scanLabel: 'Final Weight', deviceName: 'scale',
            statusMsgId: 'fineness-final-ocr-status',
            valid: (n) => n >= 0 && n <= 40,
            hasPhoto: () => !!finenessState.finalPhoto,
            clearState: () => { finenessState.finalPhoto = null; finenessState.finalReading = null; },
            onAccept: (n) => { finenessState.finalReading = n; },
            afterChange: () => updateFinenessCalc()
        })
    };

    function updateFinenessCalc() {
        const initial = parseFloat(document.getElementById('lab1-fineness-initial').value);
        const final = parseFloat(document.getElementById('lab1-fineness-final').value);
        const display = document.getElementById('lab1-fineness-display');
        const hidden = document.getElementById('lab1-fineness');
        const errEl = document.getElementById('lab1-fineness-error');

        if (!isNaN(initial) && initial > 0 && !isNaN(final) && final >= 0) {
            if (final > initial) {
                if (errEl) {
                    errEl.textContent = '⚠️ Final weight cannot exceed gross initial sample weight! Please re-verify scale reading.';
                    errEl.style.display = 'block';
                }
                hidden.value = '';
                display.textContent = '⚠️ Invalid (f > i)';
                return;
            }
            if (errEl) errEl.style.display = 'none';
            const pct = (final / initial) * 100;
            hidden.value = pct.toFixed(2);
            display.textContent = pct.toFixed(2) + ' %';
        } else {
            if (errEl) errEl.style.display = 'none';
            hidden.value = '';
            display.textContent = '—';
        }
    }

    function resetMoistureModule() {
        moistureState.photo = null;
        moistureState.reading = null;
        moistureState.scaleType = null;
        const fileInput = document.getElementById('moisture-file-input');
        if (fileInput) fileInput.value = '';
        const status = document.getElementById('moisture-photo-status');
        if (status) {
            status.textContent = 'Photo Required';
            status.className = 'badge badge-pending';
        }
        const preview = document.getElementById('moisture-photo-preview');
        if (preview) {
            preview.removeAttribute('src');
            preview.style.display = 'none';
        }
        const placeholder = document.getElementById('moisture-photo-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
        const statusMsg = document.getElementById('moisture-ocr-status-msg');
        if (statusMsg) {
            statusMsg.textContent = '';
            statusMsg.style.display = 'none';
        }
        const input = document.getElementById('lab1-moisture');
        if (input) input.value = '';
        autoRead['moisture'].reset();
    }

    function resetFinenessModule() {
        finenessState.initialPhoto = null;
        finenessState.initialReading = null;
        finenessState.finalPhoto = null;
        finenessState.finalReading = null;
        ['initial', 'final'].forEach(which => {
            const fileInput = document.getElementById(`fineness-${which}-file-input`);
            if (fileInput) fileInput.value = '';
            const status = document.getElementById(`fineness-${which}-photo-status`);
            if (status) {
                status.textContent = 'Photo Required';
                status.className = 'badge badge-pending';
            }
            const preview = document.getElementById(`fineness-${which}-photo-preview`);
            if (preview) {
                preview.removeAttribute('src');
                preview.style.display = 'none';
            }
            const placeholder = document.getElementById(`fineness-${which}-photo-placeholder`);
            if (placeholder) placeholder.style.display = 'flex';
            const statusMsg = document.getElementById(`fineness-${which}-ocr-status`);
            if (statusMsg) {
                statusMsg.textContent = '';
                statusMsg.style.display = 'none';
            }
            const input = document.getElementById(`lab1-fineness-${which}`);
            if (input) input.value = '';
            autoRead[`fineness-${which}`].reset();
        });
        updateFinenessCalc();
    }

    function setMoistureModuleEnabled(enabled) {
        const btnPhoto = document.getElementById('btn-moisture-photo');
        const btnFile = document.getElementById('btn-moisture-file');
        const input = document.getElementById('lab1-moisture');
        if (btnPhoto) btnPhoto.disabled = !enabled;
        if (btnFile) btnFile.disabled = !enabled;
        if (input) input.disabled = !enabled;
        autoRead['moisture'].setEnabled(enabled);
    }

    function setFinenessModuleEnabled(enabled) {
        ['initial', 'final'].forEach(which => {
            const btnPhoto = document.getElementById(`btn-fineness-${which}-photo`);
            const btnFile = document.getElementById(`btn-fineness-${which}-file`);
            const input = document.getElementById(`lab1-fineness-${which}`);
            if (btnPhoto) btnPhoto.disabled = !enabled;
            if (btnFile) btnFile.disabled = !enabled;
            if (input) input.disabled = !enabled;
            autoRead[`fineness-${which}`].setEnabled(enabled);
        });
    }

    // Unified Camera Stream Handler
    let scaleCameraStream = null;
    let currentCameraTarget = null; // 'moisture', 'fineness-initial', 'fineness-final'

    function stopScaleCamera() {
        if (scaleCameraStream) {
            scaleCameraStream.getTracks().forEach(track => track.stop());
            scaleCameraStream = null;
        }
        const panel = document.getElementById('fineness-camera-panel');
        if (panel) panel.style.display = 'none';
        currentCameraTarget = null;
    }

    async function startScaleCamera(target) {
        currentCameraTarget = target;
        const panel = document.getElementById('fineness-camera-panel');
        const title = document.getElementById('fineness-camera-title');
        if (title) {
            if (target === 'moisture') {
                title.textContent = '📷 Live Scale Photo Capture (Moisture Analyzer)';
            } else if (target === 'fineness-initial') {
                title.textContent = '📷 Live Scale Photo Capture (Initial Weight)';
            } else {
                title.textContent = '📷 Live Scale Photo Capture (Final Weight)';
            }
        }
        // Move the single shared camera panel right next to the field that triggered it, so the
        // operator always sees it appear beside what they're filling in (it used to live permanently
        // inside the Fineness column, so opening it from Moisture could look like nothing happened).
        const anchor = document.getElementById(`camera-anchor-${target}`);
        if (panel && anchor) anchor.appendChild(panel);
        if (panel) {
            panel.style.display = 'block';
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        try {
            if (scaleCameraStream) {
                scaleCameraStream.getTracks().forEach(track => track.stop());
            }
            scaleCameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
            });
            const video = document.getElementById('fineness-webcam-feed');
            if (video) {
                video.srcObject = scaleCameraStream;
                video.play();
            }
        } catch (err) {
            alert('Camera access error: ' + err.message + '. Please ensure camera permissions are allowed.');
            stopScaleCamera();
        }
    }

    // Process captured/selected scale photo: automatic downsampling (~150KB) and audit photo attachment
    async function handleScaleImage(target, rawDataUrl) {
        if (!rawDataUrl) return;

        let statusBadge, statusMsg, previewImg, inputEl, placeholder;
        if (target === 'moisture') {
            statusBadge = document.getElementById('moisture-photo-status');
            statusMsg = document.getElementById('moisture-ocr-status-msg');
            previewImg = document.getElementById('moisture-photo-preview');
            placeholder = document.getElementById('moisture-photo-placeholder');
            inputEl = document.getElementById('lab1-moisture');
        } else if (target === 'fineness-initial') {
            statusBadge = document.getElementById('fineness-initial-photo-status');
            statusMsg = document.getElementById('fineness-initial-ocr-status');
            previewImg = document.getElementById('fineness-initial-photo-preview');
            placeholder = document.getElementById('fineness-initial-photo-placeholder');
            inputEl = document.getElementById('lab1-fineness-initial');
        } else if (target === 'fineness-final') {
            statusBadge = document.getElementById('fineness-final-photo-status');
            statusMsg = document.getElementById('fineness-final-ocr-status');
            previewImg = document.getElementById('fineness-final-photo-preview');
            placeholder = document.getElementById('fineness-final-photo-placeholder');
            inputEl = document.getElementById('lab1-fineness-final');
        }

        if (statusBadge) {
            statusBadge.textContent = '⏳ Compressing Photo...';
            statusBadge.className = 'badge badge-pending';
        }

        try {
            // Client-side canvas downsampling to max 1200px JPEG (~150KB)
            const compressed = await compressScaleImage(rawDataUrl, 1200, 0.75);

            if (previewImg) {
                previewImg.src = compressed;
                previewImg.style.display = 'block';
                // The inline thumbnail is small by design (fits beside the input); click it to read the full photo.
                previewImg.onclick = () => window.viewPhoto(compressed, previewImg.alt || 'Scale photo');
            }
            if (placeholder) placeholder.style.display = 'none';

            if (statusBadge) {
                statusBadge.textContent = '📸 Scale Photo Attached';
                statusBadge.className = 'badge badge-success';
            }

            if (statusMsg) {
                statusMsg.textContent = 'Photo attached for supervisor audit. Type the scale reading below.';
                statusMsg.style.display = 'block';
                statusMsg.style.color = '#10b981';
            }

            if (target === 'moisture') {
                moistureState.photo = compressed;
            } else if (target === 'fineness-initial') {
                finenessState.initialPhoto = compressed;
                updateFinenessCalc();
            } else if (target === 'fineness-final') {
                finenessState.finalPhoto = compressed;
                updateFinenessCalc();
            }

            // Auto-focus input for rapid manual typing
            if (inputEl) {
                inputEl.focus();
            }

        } catch (err) {
            console.error('Scale photo handling error:', err);
            if (statusBadge) {
                statusBadge.textContent = '⚠️ Image Error';
                statusBadge.className = 'badge badge-danger';
            }
            if (statusMsg) {
                statusMsg.textContent = 'Failed to process photo: ' + err.message;
                statusMsg.style.display = 'block';
                statusMsg.style.color = '#ef4444';
            }
        }
    }

    // Manual Scale Entry with Audit Photo Fallback
    window.promptManualScaleEntry = function(target) {
        const isMoisture = (target === 'moisture');
        const unit = isMoisture ? '% Moisture' : 'kg Weight';
        const example = isMoisture ? '13.42' : '0.052';
        const userVal = prompt(`Enter digital reading seen on scale display (${unit}, e.g. ${example}):`);
        if (!userVal) return;

        const val = parseFloat(userVal.trim().replace(',', '.'));
        if (isNaN(val) || val <= 0 || (isMoisture && val > 60) || (!isMoisture && val > 40)) {
            alert(`Invalid scale reading entered. Please enter a valid number between ${isMoisture ? '0.5 and 60.0' : '0.001 and 40.0'}.`);
            return;
        }

        let inputEl, statusBadge, statusMsg;
        if (target === 'moisture') {
            inputEl = document.getElementById('lab1-moisture');
            statusBadge = document.getElementById('moisture-photo-status');
            statusMsg = document.getElementById('moisture-ocr-status-msg');
            moistureState.reading = val;
            moistureState.scaleType = 'Manual Entry (Audit Photo Attached)';
        } else if (target === 'fineness-initial') {
            inputEl = document.getElementById('lab1-fineness-initial');
            statusBadge = document.getElementById('fineness-initial-photo-status');
            statusMsg = document.getElementById('fineness-initial-ocr-status');
            finenessState.initialReading = val;
            updateFinenessCalc();
        } else if (target === 'fineness-final') {
            inputEl = document.getElementById('lab1-fineness-final');
            statusBadge = document.getElementById('fineness-final-photo-status');
            statusMsg = document.getElementById('fineness-final-ocr-status');
            finenessState.finalReading = val;
            updateFinenessCalc();
        }

        const formatted = isMoisture ? val.toFixed(2) : val.toFixed(3);
        if (inputEl) inputEl.value = formatted;
        if (statusBadge) {
            statusBadge.textContent = `⚠️ ${formatted} ${isMoisture ? '%M' : 'kg'} (Manual + Audit Photo)`;
            statusBadge.className = 'badge badge-warning';
        }
        if (statusMsg) {
            statusMsg.innerHTML = `<span style="color:#f59e0b">⚠️ Manually entered by operator (${formatted} ${isMoisture ? '%' : 'kg'}) with scale photo attached for supervisor audit.</span>`;
            statusMsg.style.display = 'block';
        }
    };

    function setupScaleOcrHandlers() {
        // A number box changes its value on a mouse-wheel turn or an arrow key while it has focus; the Lab-1 value boxes must only ever
        // hold what was read / typed on purpose.
        ['lab1-moisture', 'lab1-fineness-initial', 'lab1-fineness-final'].forEach(id => {
            const box = document.getElementById(id);
            if (!box || box.dataset.guarded) return;
            box.dataset.guarded = '1';
            box.setAttribute('autocomplete', 'off');
            box.addEventListener('wheel', () => { if (document.activeElement === box) box.blur(); }, { passive: true });
            box.addEventListener('keydown', (e) => { if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && box.readOnly) e.preventDefault(); });
        });
        // 0. Auto-read (camera -> reader -> operator confirms) for moisture and both fineness weights
        Object.values(autoRead).forEach(a => a.setup());

        // 1. Moisture Buttons & File Inputs (manual fallback only becomes visible after 3 unaccepted auto attempts)
        const btnMoisturePhoto = document.getElementById('btn-moisture-photo');
        if (btnMoisturePhoto) {
            btnMoisturePhoto.onclick = () => startScaleCamera('moisture');
        }

        const btnMoistureFile = document.getElementById('btn-moisture-file');
        const moistureFileInput = document.getElementById('moisture-file-input');
        if (btnMoistureFile && moistureFileInput) {
            btnMoistureFile.onclick = () => moistureFileInput.click();
            moistureFileInput.onchange = async (e) => {
                if (e.target.files && e.target.files[0]) {
                    const file = e.target.files[0];
                    if (!isFreshCapture(file)) { e.target.value = ''; return; }
                    const dataUrl = await readImageAsDataUrl(file);
                    handleScaleImage('moisture', dataUrl);
                }
            };
        }

        // 2. Fineness Initial & Final Buttons & File Inputs
        ['initial', 'final'].forEach(which => {
            const btnPhoto = document.getElementById(`btn-fineness-${which}-photo`);
            if (btnPhoto) {
                btnPhoto.onclick = () => startScaleCamera(`fineness-${which}`);
            }

            const btnFile = document.getElementById(`btn-fineness-${which}-file`);
            const fileInput = document.getElementById(`fineness-${which}-file-input`);
            if (btnFile && fileInput) {
                btnFile.onclick = () => fileInput.click();
                fileInput.onchange = async (e) => {
                    if (e.target.files && e.target.files[0]) {
                        const file = e.target.files[0];
                        if (!isFreshCapture(file)) { e.target.value = ''; return; }
                        const dataUrl = await readImageAsDataUrl(file);
                        handleScaleImage(`fineness-${which}`, dataUrl);
                    }
                };
            }
        });

        // 3. Camera Modal Controls
        const cancelBtn = document.getElementById('btn-cancel-fineness-photo');
        if (cancelBtn) {
            cancelBtn.onclick = stopScaleCamera;
        }

        const snapBtn = document.getElementById('btn-snap-fineness-photo');
        if (snapBtn) {
            snapBtn.onclick = () => {
                if (!currentCameraTarget) return;
                const video = document.getElementById('fineness-webcam-feed');
                if (!video || !video.videoWidth) {
                    alert('Camera feed is initializing. Please wait a moment.');
                    return;
                }
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 1280;
                canvas.height = video.videoHeight || 720;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.90);

                const target = currentCameraTarget;
                stopScaleCamera();
                handleScaleImage(target, dataUrl);
            };
        }
    }

    // ---- Feature tabs: only one feature of a screen is shown at a time (blocks carry data-ftgroup / data-ftab) ----
    function showFtab(barId, name) {
        const bar = document.getElementById(barId);
        if (!bar) return;
        [...bar.querySelectorAll('button[data-ft]')].forEach(b => b.classList.toggle('active', b.dataset.ft === name));
        document.querySelectorAll('[data-ftgroup="' + barId + '"]').forEach(el => el.classList.toggle('ftab-off', el.dataset.ftab !== name));
    }
    function initFeatureTabs(barId) {
        const bar = document.getElementById(barId);
        if (!bar || bar.dataset.wired) return;
        bar.dataset.wired = '1';
        bar.onclick = (e) => { const b = e.target.closest('button[data-ft]'); if (b) showFtab(barId, b.dataset.ft); };
        showFtab(barId, 'scan');
    }

    function initLab1Screen() {
        syncLearnedTemplates();
        initFeatureTabs('lab1-tabs');
        document.getElementById('lab1-entry-card').style.display = 'none';
        applyLab1RoleView();
        setupScaleOcrHandlers();
        // Start loading the meter reader in the background now, so it is ready by the time a sample is scanned.
        const roleFields = getLab1FieldVisibility();
        const readerMissing = !window.MoistureOCR;
        Object.values(autoRead).forEach(a => a.setUnavailable(readerMissing));
        const wanted = Object.entries(autoRead).filter(([k, a]) => a.isConfigOn() && (k === 'moisture' ? roleFields.showMoisture : roleFields.showFineness));
        if (!readerMissing && wanted.length) {
            window.MoistureOCR.preload().then((ok) => {
                if (ok) return;
                wanted.forEach(([, a]) => {
                    a.setUnavailable(true);
                    if (a.canSwitchToManualNow()) a.goManual('Automatic reading is not available on this device.');
                });
            });
        }
        resetMoistureModule();
        resetFinenessModule();
        renderLab1History();
        setupLab1CameraScanner();
        initMixScanCard();
    }

    // Label paper: '4x6' = a 4 x 6 inch thermal sticker (default; the label fills the whole page), '50' = a 50 x 50 mm roll. The choice is kept per computer
    // (select in the header). While a label is printed the browser is asked for exactly that page size (removed again afterwards), so the thermal
    // printer is used at full size instead of A4. Normal reports keep the default page.
    function labelFormat() {
        try { return localStorage.getItem('BM_LABEL_FMT') === '50' ? '50' : '4x6'; } catch (e) { return '4x6'; }
    }
    function setLabelPageSize(on) {
        let st = document.getElementById('label-page-size');
        if (!on) { if (st) st.remove(); document.body.classList.remove('label-4x6'); return; }
        if (!st) { st = document.createElement('style'); st.id = 'label-page-size'; document.head.appendChild(st); }
        const big = labelFormat() === '4x6';
        document.body.classList.toggle('label-4x6', big);
        st.textContent = big ? '@page { size: 101.6mm 152.4mm; margin: 0; }' : '@page { size: 50mm 50mm; margin: 0; }';
    }
    (function () {
        const sel = document.getElementById('label-fmt-select');
        if (!sel) return;
        sel.value = labelFormat();
        sel.onchange = () => { try { localStorage.setItem('BM_LABEL_FMT', sel.value); } catch (e) { /* kept for this session only */ } };
    })();

    // A scanned QR whose result is already saved is refused: the entry form is not opened, a banner explains why, and a
    // pop-up makes sure the operator notices (the server also refuses to overwrite a locked result).
    function showAlreadySaved(noticeId, what, when) {
        const box = document.getElementById(noticeId);
        const msg = 'Data already saved for this QR.';
        const detail = what + ' result for this QR was already submitted' + (when ? ' at ' + when : '') + ' and is locked. It cannot be entered again.';
        if (box) {
            box.innerHTML = '<strong>\u26D4 ' + msg + '</strong><span>' + esc(detail) + '</span>';
            box.style.display = 'flex';
        }
        alert('\u26D4 ' + msg + '\n\n' + detail);
    }

    async function lookupLab1Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a barcode ID.');
            return;
        }

        const entryCard = document.getElementById('lab1-entry-card');
        const alertBox = document.getElementById('lab1-alert');
        const dupBox = document.getElementById('lab1-duplicate-notice');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';
        if (dupBox) dupBox.style.display = 'none';

        try {
            const data = await window.BiomassAPI.getSample1Details(barcode);
            if (data.success) {
                {
                    const _u = window.BiomassAPI.getCurrentUser(), _role = _u ? _u.role : '';
                    const _hasM = data.moisture_pct !== null && data.moisture_pct !== undefined && data.moisture_pct !== '' && Number(data.moisture_pct) > 0;
                    const _hasF = data.fineness_value !== null && data.fineness_value !== undefined && data.fineness_value !== '' && Number(data.fineness_value) > 0;
                    const _done = _role === 'lab1m' ? _hasM : _role === 'lab1f' ? _hasF : (_hasM && _hasF);
                    if (_done) {
                        resetMoistureModule();
                        resetFinenessModule();
                        showAlreadySaved('lab1-duplicate-notice', _role === 'lab1m' ? 'Moisture' : _role === 'lab1f' ? 'Fineness' : 'Moisture and fineness', data.tested_at);
                        return;
                    }
                }
                entryCard.style.display = 'block';
                document.getElementById('lab1-blind-code').textContent = '✅ ACTIVE SECURE SAMPLE';
                document.getElementById('lab1-barcode-id').value = data.sample1_barcode_id;

                if (data.meta || data.company_name || data.truck_reg_number) {
                    console.error('Collusion leak warning: Identity metadata detected in lab session!');
                }

                applyLab1RoleView();
                const { showMoisture, showFineness } = getLab1FieldVisibility();

                const moistureInput = document.getElementById('lab1-moisture');
                const finenessInput = document.getElementById('lab1-fineness');
                const form = document.getElementById('lab1-entry-form');
                const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

                const hasMoisture = data.moisture_pct !== null && 
                                    data.moisture_pct !== undefined && 
                                    data.moisture_pct !== '' && 
                                    Number(data.moisture_pct) > 0;

                const hasFineness = data.fineness_value !== null && 
                                    data.fineness_value !== undefined && 
                                    data.fineness_value !== '' && 
                                    Number(data.fineness_value) > 0;

                // Fresh modules for every scanned sample
                resetMoistureModule();
                resetFinenessModule();

                if (hasMoisture) {
                    moistureInput.value = data.moisture_pct;
                    const mStatus = document.getElementById('moisture-photo-status');
                    if (mStatus) {
                        mStatus.textContent = '✅ Already Tested';
                        mStatus.className = 'badge badge-success';
                    }
                }
                if (hasFineness) {
                    finenessInput.value = data.fineness_value;
                    document.getElementById('lab1-fineness-display').textContent = Number(data.fineness_value).toFixed(2) + ' %';
                    ['initial', 'final'].forEach(w => {
                        const fStatus = document.getElementById(`fineness-${w}-photo-status`);
                        if (fStatus) {
                            fStatus.textContent = '✅ Already Tested';
                            fStatus.className = 'badge badge-success';
                        }
                    });
                }

                const activeUser = window.BiomassAPI.getCurrentUser();
                const userRole = activeUser ? activeUser.role : '';

                let isLockedForRole = false;
                if (userRole === 'lab1m') {
                    // Moisture tester: only locked if moisture is already entered
                    setMoistureModuleEnabled(!hasMoisture);
                    setFinenessModuleEnabled(false);
                    isLockedForRole = hasMoisture;
                } else if (userRole === 'lab1f') {
                    // Fineness tester: only locked if fineness is already entered
                    setMoistureModuleEnabled(false);
                    setFinenessModuleEnabled(!hasFineness);
                    isLockedForRole = hasFineness;
                } else {
                    // Combined Lab1 or Admin
                    setMoistureModuleEnabled(!hasMoisture);
                    setFinenessModuleEnabled(!hasFineness);
                    isLockedForRole = hasMoisture && hasFineness;
                }

                if (isLockedForRole) {
                    if (submitBtn) submitBtn.disabled = true;
                    alertBox.textContent = `Notice: This testing portion has already been submitted and locked for your role at ${data.tested_at || 'earlier'}. No further edits allowed.`;
                    alertBox.className = 'alert alert-warning';
                    alertBox.style.display = 'flex';
                } else {
                    if (submitBtn) submitBtn.disabled = false;
                    if (hasMoisture || hasFineness) {
                        alertBox.textContent = `Notice: ${hasMoisture ? 'Moisture' : 'Fineness'} is already saved for this QR. Only the remaining part can be entered.`;
                        alertBox.className = 'alert alert-warning';
                        alertBox.style.display = 'flex';
                    } else {
                        alertBox.style.display = 'none';
                    }
                }

            } else {
                alert('Invalid lookup: ' + data.message);
            }
        } catch (err) {
            alert('Lookup failed: ' + err.message);
        }
    }

    const lab1Form = document.getElementById('lab1-entry-form');
    lab1Form.onsubmit = async function(e) {
        e.preventDefault();
        
        const { showMoisture, showFineness } = getLab1FieldVisibility();
        const barcode = document.getElementById('lab1-barcode-id').value;
        const moistureInput = document.getElementById('lab1-moisture');
        // When the operator confirmed an automatic reading, THAT confirmed number is what is saved - the text box is only a display.
        const confirmedNum = (key, reading) => (autoRead[key].mode() === 'accepted' && reading !== null && reading !== undefined && isFinite(reading)) ? String(reading) : null;
        const moisture = showMoisture ? (confirmedNum('moisture', moistureState.reading) ?? moistureInput.value) : '';

        const initialWeight = confirmedNum('fineness-initial', finenessState.initialReading) ?? document.getElementById('lab1-fineness-initial').value;
        const finalWeight = confirmedNum('fineness-final', finenessState.finalReading) ?? document.getElementById('lab1-fineness-final').value;
        // keep the visible boxes identical to what is sent
        if (showMoisture && moisture !== '') moistureInput.value = moisture;
        if (showFineness) { const bi = document.getElementById('lab1-fineness-initial'), bf = document.getElementById('lab1-fineness-final'); if (initialWeight !== '') bi.value = initialWeight; if (finalWeight !== '') bf.value = finalWeight; }
        const finenessBtnEnabled = !document.getElementById('btn-fineness-initial-photo').disabled;
        const finenessEditable = showFineness && finenessBtnEnabled;
        const moistureEditable = showMoisture && !moistureInput.disabled;

        // Mandatory: photo-verified moisture reading
        if (moistureEditable) {
            if (autoRead['moisture'].mode() === 'auto') {
                alert('Please scan the moisture meter display with the camera and confirm the reading.\n\n(After 3 attempts without an accepted reading you can attach a photo and type the value manually.)');
                return;
            }
            if (!moistureState.photo) {
                alert('Mandatory scale photo proof required: Please capture or select a photo of the moisture analyzer scale reading first.');
                return;
            }
            if (!moisture || isNaN(Number(moisture)) || Number(moisture) <= 0) {
                alert('Please enter a valid moisture percentage reading.');
                if (moistureInput) moistureInput.focus();
                return;
            }
        }

        // Mandatory: scale photo + both weights before fineness can be recorded
        if (finenessEditable) {
            if (autoRead['fineness-initial'].mode() === 'auto' || autoRead['fineness-final'].mode() === 'auto') {
                alert('Please scan the scale display with the camera and confirm BOTH the initial and the final weight.\n\n(After 3 attempts without an accepted reading you can attach a photo and type the value manually.)');
                return;
            }
            if (!finenessState.initialPhoto) {
                alert('Mandatory scale photo proof required: Please capture or select the scale photo for INITIAL weight first.');
                return;
            }
            if (!initialWeight || isNaN(Number(initialWeight)) || Number(initialWeight) <= 0) {
                alert('Please enter a valid initial sample gross weight (i).');
                return;
            }
            if (!finenessState.finalPhoto) {
                alert('Mandatory scale photo proof required: Please capture or select the scale photo for FINAL weight first.');
                return;
            }
            if (finalWeight === '' || isNaN(Number(finalWeight)) || Number(finalWeight) < 0) {
                alert('Please enter a valid final retained weight (f).');
                return;
            }
            if (Number(finalWeight) > Number(initialWeight)) {
                alert('⚠️ Fineness Calculation Error: Final retained weight cannot exceed gross initial sample weight!');
                return;
            }
            updateFinenessCalc();
        }

        const fineness = finenessEditable ? document.getElementById('lab1-fineness').value : '';
        const extra = {};
        if (moistureEditable && moistureState.photo) {
            extra.moisture_photo = moistureState.photo;
        }
        if (finenessEditable) {
            extra.fineness_initial_weight = initialWeight;
            extra.fineness_final_weight = finalWeight;
            extra.fineness_initial_photo = finenessState.initialPhoto;
            extra.fineness_final_photo = finenessState.finalPhoto;
        }

        // photos the reader was not sure about (< 50 %) and the operator confirmed: the server keeps them for reader training
        {
            const low = [];
            const take = (k, kind, typed) => { const l = lowConf[k]; if (l && Number(typed) === l.value) low.push({ kind, conf: l.conf, photo_src: l.photo || undefined, examples: l.examples || undefined }); };
            if (moistureEditable) take('moisture', 'moisture', moisture);
            if (finenessEditable) { take('fineness-initial', 'fineness_initial', initialWeight); take('fineness-final', 'fineness_final', finalWeight); }
            if (low.length) extra.low_conf = low;
        }

        // Read-back: the operator sees exactly what is about to be locked, next to the display, before it cannot be changed any more.
        {
            const lines = [];
            if (moistureEditable) lines.push('Moisture: ' + Number(moisture) + ' %');
            if (finenessEditable) lines.push('Fineness: ' + fineness + ' %   (final ' + Number(finalWeight) + ' kg / initial ' + Number(initialWeight) + ' kg)');
            if (lines.length && !confirm('You are about to LOCK these values:\n\n' + lines.join('\n') + '\n\nDo they match the display(s)? Press OK to lock, Cancel to go back.')) return;
        }

        try {
            const res = await window.BiomassAPI.submitSample1Result(barcode, moisture, fineness, extra);
            if (res.success) {
                const acceptMsg = res.acceptance_status === 'REJECTED' 
                    ? '\n⚠️ CONSIGNMENT REJECTED: Moisture is 14.0% or higher.' 
                    : (res.acceptance_status === 'ACCEPTED' ? '\n✅ CONSIGNMENT ACCEPTED: Moisture is below 14.0%.' : '');
                // Proof of what the database really holds, compared with what was sent. A difference is shown loudly.
                const rec = res.record || {};
                let saved = '';
                const diff = [];
                if (moistureEditable) {
                    saved += '\nSaved moisture: ' + rec.moisture_pct + ' %';
                    if (Math.abs(Number(rec.moisture_pct) - Number(moisture)) > 0.0006) diff.push('moisture sent ' + Number(moisture) + ' but saved ' + rec.moisture_pct);
                }
                if (finenessEditable) {
                    saved += '\nSaved fineness: ' + rec.fineness_value + ' %';
                    if (Math.abs(Number(rec.fineness_value) - Number(fineness)) > 0.006) diff.push('fineness sent ' + Number(fineness) + ' but saved ' + rec.fineness_value);
                }
                if (diff.length) alert('WARNING - THE SAVED VALUE DIFFERS FROM WHAT WAS ENTERED\n\n' + diff.join('\n') + '\n\nTell the administrator immediately (note the time and the sample).');
                alert('Sample analysis locked and submitted successfully!' + saved + acceptMsg);
                document.getElementById('lab1-entry-card').style.display = 'none';
                resetMoistureModule();
                resetFinenessModule();
                renderLab1History();

            } else {
                alert('Submission failed: ' + res.message);
            }
        } catch (err) {
            if (/already submitted and locked/i.test(String(err.message))) {
                document.getElementById('lab1-entry-card').style.display = 'none';
                resetMoistureModule();
                resetFinenessModule();
                showAlreadySaved('lab1-duplicate-notice', 'This', null);
            } else {
                alert('Submission error: ' + err.message);
            }
        }
    };

    async function renderLab1History() {
        const tbody = document.getElementById('lab1-history-body');
        const { showMoisture, showFineness } = getLab1FieldVisibility();
        const colCount = 2 + (showMoisture ? 1 : 0) + (showFineness ? 1 : 0);
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center;">Loading history...</td></tr>`;

        try {
            const history = await window.BiomassAPI.getLab1History();
            tbody.innerHTML = '';
            
            if (history.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center;">No tests submitted by your account today.</td></tr>`;
                return;
            }

            // the server sends them newest first (by submission time); Sample #1 is the first one submitted today
            history.forEach((row, idx) => {
                const tr = document.createElement('tr');
                const moistureCell = showMoisture ? `<td>${row.moisture_pct}%</td>` : '';
                const finenessCell = showFineness ? `<td>${row.fineness_value}%</td>` : '';
                const when = String(row.submitted_at || row.tested_at || '');
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Sample #${history.length - idx}</strong></td>
                    ${moistureCell}
                    ${finenessCell}
                    <td>${esc(when.split(' ')[1] || when)}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center; color: var(--danger);">Failed to load history: ${esc(e.message)}</td></tr>`;
        }
    }


    // ================= LAB 2 STATION 2 CONTROLLER (BLIND Composite GCV & Ash) =================
    // Mixing scans are done in the FINENESS login (see the mixscan code in the Lab-1 section). Here Lab 2 only
    // generates (once) and reprints the composite labels, for any date range / mixing code.
    const lab2State = {
        // Always "today in India" - recomputed on every use, so it is right after midnight and independent of the
        // device's time zone (the old UTC-based value was yesterday between 00:00 and 05:30 IST).
        get today() { return window.BiomassAPI.todayIST(); },
        groups: []
    };

    function initLab2Screen() {
        initFeatureTabs('lab2-tabs');
        const entryCard = document.getElementById('lab2-entry-card');
        if (entryCard) entryCard.style.display = 'none';
        const compositeOutput = document.getElementById('lab2-composite-output');
        if (compositeOutput) compositeOutput.style.display = 'none';
        renderLab2History();
        setupLab2CameraScanner();
        setupLab2TypedLookup();
        setupLab2Filter();
        renderLab2MixingGroups();
        if (!lab2State.timer) {
            lab2State.timer = setInterval(() => {
                const scr = document.getElementById('screen-lab2');
                if (scr && scr.classList.contains('active') && !document.hidden) renderLab2MixingGroups();
            }, 30000);
        }
    }

    function setupLab2Filter() {
        const from = document.getElementById('lab2-filter-from'), to = document.getElementById('lab2-filter-to'), q = document.getElementById('lab2-filter-q');
        if (!from || !to || !q) return;
        const today = lab2State.today;
        from.value = today; to.value = today; q.value = '';       // default view: today
        const apply = () => renderLab2MixingGroups();
        document.getElementById('btn-lab2-filter-apply').onclick = apply;
        document.getElementById('btn-refresh-lab2-groups').onclick = apply;
        document.getElementById('btn-lab2-filter-today').onclick = () => { const t = lab2State.today; from.value = t; to.value = t; q.value = ''; apply(); };
        q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
        // Picking a new "From" date after the "To" date moves "To" along with it
        from.onchange = () => { if (to.value && to.value < from.value) to.value = from.value; };
    }

    async function renderLab2MixingGroups() {
        const container = document.getElementById('lab2-mixing-groups-container');
        if (!container) return;
        const fromEl = document.getElementById('lab2-filter-from'), toEl = document.getElementById('lab2-filter-to'), qEl = document.getElementById('lab2-filter-q');
        const note = document.getElementById('lab2-filter-note');
        const today = lab2State.today;
        const from = (fromEl && fromEl.value) || today;
        const to = (toEl && toEl.value) || from;
        const q = ((qEl && qEl.value) || '').trim();

        try {
            const res = await window.BiomassAPI.getLab2MixingGroupsStatus(from, to, q);
            const groups = (res && res.groups) || [];
            lab2State.groups = groups;
            const span = from === to ? from : `${from} to ${to}`;
            if (note) note.textContent = `${groups.length} mixing code(s) for ${span}` + (q ? ` matching "${q}"` : '') + '.';
            if (!res.success || groups.length === 0) {
                container.innerHTML = '<div style="color: #94a3b8; font-style: italic; padding: 1rem; grid-column: 1 / -1;">' +
                    (q ? 'No mixing code matches that search in the chosen dates.' : 'No sample entries recorded for the chosen dates.') + '</div>';
                return;
            }

            container.innerHTML = '';
            groups.forEach(group => {
                const acc = group.accepted_count, rej = group.rejected_count, pen = group.pending_count;
                const scanned = group.scanned_accepted || 0;
                const card = document.createElement('div');
                card.className = 'mixing-group-card';
                if (group.is_batch_created) card.style.borderColor = '#10b981';

                let actionHtml = '';
                if (group.is_batch_created) {
                    actionHtml = `
                        <div style="color: #10b981; font-weight: bold; font-size: 0.85rem; margin-top: 0.5rem;">
                            ✅ Composite generated - cannot be generated again
                        </div>
                        <div style="font-size: 0.82rem; color: #cbd5e1; background: rgba(16,185,129,0.1); border-radius: 6px; padding: 0.4rem 0.6rem;">
                            <strong>${esc(group.mixed_samples_count != null ? group.mixed_samples_count : acc)}</strong> sample(s) mixed
                            (of ${esc(group.total_registered)} registered; ${esc(rej)} rejected and left out${pen > 0 ? '; ' + esc(pen) + ' arrived later, not mixed' : ''})
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm mt-2 lab2-reprint" style="width: 100%;">🖨️ View / Reprint Composite QR Codes</button>`;
                } else if (pen > 0) {
                    actionHtml = `
                        <div style="color: #f59e0b; font-size: 0.82rem; margin-top: 0.5rem;">⏳ Waiting for Lab 1 moisture results (${pen} pending).</div>
                        <button type="button" class="btn btn-secondary btn-sm mt-2" disabled style="width: 100%; opacity: 0.5; cursor: not-allowed;">🔒 Locked (Lab 1 incomplete)</button>`;
                } else if (acc === 0) {
                    actionHtml = `<div style="color: #ef4444; font-size: 0.82rem; margin-top: 0.5rem;">⛔ All ${rej} consignments in this group were REJECTED.</div>`;
                } else if (!group.all_scanned) {
                    const remaining = acc - scanned;
                    actionHtml = `
                        <div style="color: #cbd5e1; font-size: 0.82rem; margin-top: 0.5rem;">
                            Scanned in the Fineness login: <strong>${scanned} / ${acc}</strong> accepted container(s).
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm mt-2" disabled style="width: 100%; opacity: 0.6; cursor: not-allowed;">
                            🔒 Waiting for ${remaining} more scan${remaining > 1 ? 's' : ''} in the Fineness login
                        </button>`;
                } else {
                    actionHtml = `
                        <div style="color: #10b981; font-size: 0.85rem; font-weight: bold; margin-top: 0.5rem;">🎉 All ${acc} accepted containers scanned in the Fineness login!</div>
                        <button type="button" class="btn btn-primary btn-sm mt-2 lab2-generate" style="width: 100%; background: linear-gradient(135deg, #10b981 0%, #059669 100%); font-weight: bold;">
                            ⚗️ Generate Composite Mix (${esc(group.group_code)})
                        </button>`;
                }

                card.innerHTML = `
                    <div class="mixing-group-header">
                        <div>
                            <div class="group-code-badge">${esc(group.group_code)}</div>
                            <span style="font-size: 0.8rem; color: #94a3b8; margin-left: 0.4rem;">${esc(group.date)} &bull; ${esc(group.total_registered)} consignment(s)</span>
                        </div>
                        <span class="badge ${group.is_batch_created ? 'badge-success' : 'badge-pending'}">${group.is_batch_created ? 'COMPILED' : 'ACTIVE'}</span>
                    </div>
                    <div class="mixing-group-stats">
                        <div class="group-stat-pill stat-accepted"><strong>${acc}</strong> Approved</div>
                        <div class="group-stat-pill stat-rejected"><strong>${rej}</strong> Rejected</div>
                        ${Number(group.cancelled_count) > 0 ? `<div class="group-stat-pill" style="background:rgba(107,114,128,0.25); color:#d1d5db;"><strong>${esc(group.cancelled_count)}</strong> Cancelled</div>` : ''}
                        <div class="group-stat-pill stat-pending"><strong>${pen}</strong> Pending</div>
                    </div>
                    <div style="font-size: 0.8rem; color: #cbd5e1; margin-top: 0.5rem; display: flex; justify-content: space-between;">
                        <span>Fineness-login scan progress:</span>
                        <strong>${scanned} / ${acc}</strong>
                    </div>
                    <div class="progress-bar-container" style="background: rgba(255,255,255,0.1); height: 6px; border-radius: 3px; margin-top: 0.25rem; overflow: hidden;">
                        <div style="background: #10b981; height: 100%; width: ${acc > 0 ? Math.min(100, scanned / acc * 100) : 0}%;"></div>
                    </div>
                    ${actionHtml}`;
                const gen = card.querySelector('.lab2-generate'), rep = card.querySelector('.lab2-reprint');
                if (gen) gen.onclick = () => window.generateLab2CompositeForGroup(group.group_code, group.date, gen);
                if (rep) rep.onclick = () => window.reprintLab2Batch(group.group_code, group.date);
                container.appendChild(card);
            });
        } catch (err) {
            if (note) note.textContent = '';
            container.innerHTML = `<div style="color: #ef4444; padding: 1rem; grid-column: 1 / -1;">Failed to load mixing groups: ${esc(err.message)}</div>`;
        }
    }

    window.generateLab2CompositeForGroup = async function(groupCode, date, btn) {
        const g = lab2State.groups.find(x => x.group_code === groupCode && x.date === date);
        const detail = g ? `\n\n${g.accepted_count} approved sample(s) will be mixed; ${g.rejected_count} rejected sample(s) are left out.` : '';
        if (!confirm(`Generate Composite Mixture QR codes for Mixing Code [${groupCode}] (${date})?${detail}\n\nThis can be done ONLY ONCE. Afterwards the labels can only be reprinted.`)) return;

        if (btn) btn.disabled = true;
        if (window.showGlobalLoader) window.showGlobalLoader(`Compiling Composite Mixture for [${groupCode}]...`);
        try {
            // The server re-checks everything: no pending results, at least one accepted sample, no earlier composite, and that
            // EVERY accepted container of this group was scanned in the Fineness login.
            const res = await window.BiomassAPI.createCompositeBatchForGroup(date, groupCode);
            if (!res || !res.success) throw new Error((res && res.message) || 'Composite could not be created');

            alert(`The composite for Mixing Code [${groupCode}] was created successfully!`);
            await renderLab2MixingGroups();
            const grp = lab2State.groups.find(x => x.group_code === groupCode && x.date === date);
            await renderLab2CompositeOutput(res.batch, groupCode, grp);
        } catch (err) {
            alert('Generation failed: ' + err.message);
            if (btn) btn.disabled = false;
            renderLab2MixingGroups();
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    };

    window.reprintLab2Batch = async function(groupCode, date) {
        try {
            const batch = await window.BiomassAPI.getCompositeBatchByGroupCode(groupCode, date);
            if (batch) {
                const grp = lab2State.groups.find(x => x.group_code === groupCode && x.date === date);
                await renderLab2CompositeOutput(batch, groupCode, grp);
            } else {
                alert('Composite batch record not found for Mixing Code ' + groupCode);
            }
        } catch (err) {
            alert('Failed to retrieve batch: ' + err.message);
        }
    };

    // One 50 x 50 mm composite label. With a vendor name (Vendor / Referee copies) the COMPLETE name is printed above the QR in up to 3
    // lines; the font shrinks for long names so the whole label always fits the 50 x 50 mm roll.
    function labelHtmlFor(lotId, sampleName, vendorName, group, dateStr, canvasId) {
        // The operator sees NO composite code on any composite label: Test = mixing code + date; Vendor / Referee = date + the COMPLETE vendor name + mixing code.
        // (The code is inside the QR for the scanner. The font shrinks for long vendor names so the label always fits 50 x 50 mm.)
        const v = String(vendorName || '').trim();
        if (!v) {
            return `
                <div class="print-label-view print-label-50mm label-with-initials" style="text-align: center;">
                    <div style="font-size: 11pt; font-weight: 800; font-family: monospace; color: #000; line-height: 1.1;">MIXING CODE: ${esc(group)}</div>
                    <div style="font-size: 8pt; font-weight: bold; margin: 2px 0 3px 0; color: #000; font-family: monospace;">${esc(sampleName)}</div>
                    <div style="font-size: 12pt; font-weight: 800; margin: 0 0 2px 0; color: #000; font-family: monospace; line-height: 1;">${esc(dmy(dateStr))}</div>
                    <canvas id="${canvasId}"></canvas>
                </div>`;
        }
        const pt = labelFormat() === '4x6' ? (v.length <= 22 ? 10 : (v.length <= 44 ? 9 : (v.length <= 66 ? 8 : 7))) : (v.length <= 22 ? 8 : (v.length <= 44 ? 7 : (v.length <= 66 ? 6 : 5)));
        return `
            <div class="print-label-view print-label-50mm label-with-vendor" style="text-align: center;">
                <div style="font-size: 8.5pt; font-weight: bold; font-family: monospace; color: #000; line-height: 1;">MIXING CODE: ${esc(group)} &middot; ${esc(dmy(dateStr))}</div>
                <div style="font-size: 6.5pt; font-weight: bold; margin: 1px 0; color: #000; font-family: monospace;">${esc(sampleName)}</div>
                <div class="label-vendor" style="font-size: ${pt}pt;">${esc(v)}</div>
                <canvas id="${canvasId}"></canvas>
            </div>`;
    }

    // Renders the Test/Referee/Vendor QR outputs for a composite batch on the Lab 2 screen,
    // formatted for strict 50mm x 50mm thermal paper label rolls
    async function renderLab2CompositeOutput(batch, groupCode, grp) {
        if (!batch.lots) {
            batch.lots = {
                test: batch.test_lot || batch.composite_barcode_id || `${batch.composite_ref_id}-T`,
                referee: batch.referee_lot || `${batch.composite_ref_id}-R`,
                vendor: batch.vendor_lot || `${batch.composite_ref_id}-V`
            };
        }

        const outputDiv = document.getElementById('lab2-composite-output');
        if (outputDiv) outputDiv.style.display = 'block';
        if (outputDiv) {
            let sum = document.getElementById('lab2-output-summary');
            if (!sum) { sum = document.createElement('div'); sum.id = 'lab2-output-summary'; sum.style.cssText = 'font-size:0.88rem; color:#e2e8f0; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.4); border-radius:8px; padding:0.6rem 0.8rem; margin-bottom:0.75rem;'; outputDiv.insertBefore(sum, outputDiv.firstChild); }
            const mixed = batch.mixed_samples_count != null ? batch.mixed_samples_count : (grp ? grp.mixed_samples_count : null);
            sum.innerHTML = `<strong>Mixing Code ${esc(String(batch.daily_group_code || groupCode || '').toUpperCase())}</strong> &bull; ${esc(dmy(batch.date || ''))}` +
                (grp ? `<br>Approved: <strong>${esc(grp.accepted_count)}</strong> &nbsp; Rejected: <strong>${esc(grp.rejected_count)}</strong> &nbsp; Total registered: <strong>${esc(grp.total_registered)}</strong> &nbsp; <strong>Total samples mixed: ${esc(mixed != null ? mixed : grp.accepted_count)}</strong>`
                       : (mixed != null ? `<br>Total samples mixed: <strong>${esc(mixed)}</strong>` : ''));
        }

        const gCodeLab2 = String(batch.daily_group_code || groupCode || 'N/A').trim().toUpperCase();
        const groupLabelText = `MIXING GROUP: ${gCodeLab2}`;
        const batchDate = batch.date || '';

        // The supplier's COMPLETE name goes on the Vendor and Referee copies only (never on the Test lot), so the stored samples can be
        // found by the supplier and similar vendor names cannot be confused. It comes from the server together with the batch.
        const initials = String(batch.vendor_initials || '').trim().toUpperCase();
        const vendorFull = String(batch.vendor_name || batch.company_name || '').trim().toUpperCase();
        const vendorLabel = vendorFull || initials;
        ['test', 'ref', 'vend'].forEach(k => {
            const groupEl = document.getElementById(`lab2-${k}-group-code`);
            const codeEl = document.getElementById(`lab2-${k}-code`);
            if (groupEl) groupEl.textContent = groupLabelText;
            if (codeEl) {
                if (k !== 'test' && vendorLabel) { codeEl.textContent = `SUPPLIER: ${vendorLabel}`; codeEl.style.display = ''; }
                else codeEl.style.display = 'none';
            }
        });

        const testEnc = await encryptPayload(batch.lots.test);
        const refEnc = await encryptPayload(batch.lots.referee);
        const vendEnc = await encryptPayload(batch.lots.vendor);

        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-test'), testEnc, { errorCorrectionLevel: 'M', width: 246, margin: 4 });
        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-ref'), refEnc, { errorCorrectionLevel: 'M', width: 246, margin: 4 });
        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-vend'), vendEnc, { errorCorrectionLevel: 'M', width: 246, margin: 4 });

        const printContainer = document.getElementById('print-section');
        // One 50 x 50 mm label for a lot (the Vendor / Referee copies also carry the supplier's complete name).
        const labelHtml = (lotId, sampleName, withVendor, canvasId) => labelHtmlFor(lotId, sampleName, withVendor ? vendorLabel : '', gCodeLab2, batchDate, canvasId);
        const drawQr = (canvasId, text) => new Promise((resolve) => {
            QRCode.toCanvas(document.getElementById(canvasId), text, { errorCorrectionLevel: 'M', width: 410, margin: 4 }, function(err) {
                if (err) console.error(err);
                resolve();
            });
        });
        const sendToPrinter = () => {
            document.body.classList.add('printing-label'); setLabelPageSize(true);
            setTimeout(() => {
                window.print();
                document.body.classList.remove('printing-label'); setLabelPageSize(false);
            }, 250);
        };
        const setupPrint = async (lotId, sampleName, withInitials) => {
            const encrypted = await encryptPayload(lotId);
            printContainer.innerHTML = labelHtml(lotId, sampleName, withInitials, 'print-qr-target');
            await drawQr('print-qr-target', encrypted);
            sendToPrinter();
        };
        // All three labels in ONE print job (one 50 x 50 mm page each): Test, Referee, Vendor
        const printAllLots = async () => {
            const lots = [[batch.lots.test, "TEST LOT (-T)", false], [batch.lots.referee, "REFEREE LOT (-R)", true], [batch.lots.vendor, "VENDOR LOT (-V)", true]];
            printContainer.innerHTML = lots.map((l, i) => `<div class="label-page">${labelHtml(l[0], l[1], l[2], 'print-qr-' + i)}</div>`).join('');
            for (let i = 0; i < lots.length; i++) await drawQr('print-qr-' + i, await encryptPayload(lots[i][0]));
            sendToPrinter();
        };
        const btnAll = document.getElementById('btn-print-lab2-all');
        if (btnAll) btnAll.onclick = printAllLots;

        document.getElementById('btn-print-lab2-test').onclick = () => setupPrint(batch.lots.test, "TEST LOT (-T)");
        document.getElementById('btn-print-lab2-ref').onclick = () => setupPrint(batch.lots.referee, "REFEREE LOT (-R)", true);
        document.getElementById('btn-print-lab2-vend').onclick = () => setupPrint(batch.lots.vendor, "VENDOR LOT (-V)", true);

        // Download PNG actions
        document.getElementById('btn-download-lab2-test').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-test',
            `TEST_${batchDate}_${gCodeLab2}`,
            `GROUP: ${gCodeLab2} | TEST LOT ${dmy(batchDate)}`,
            "TEST LOT",
            true
        );
        document.getElementById('btn-download-lab2-ref').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-ref',
            `REFEREE_${initials ? initials + '_' : ''}${batchDate}_${gCodeLab2}`,
            `REFEREE LOT | ${gCodeLab2} ${dmy(batchDate)}`,
            "REFEREE LOT",
            true,
            vendorLabel
        );
        document.getElementById('btn-download-lab2-vend').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-vend',
            `VENDOR_${initials ? initials + '_' : ''}${batchDate}_${gCodeLab2}`,
            `VENDOR LOT | ${gCodeLab2} ${dmy(batchDate)}`,
            "VENDOR LOT",
            true,
            vendorLabel
        );

        outputDiv.scrollIntoView({ behavior: 'smooth' });
    }

    // Lab 2 enters AIR-DRIED (AD) values; TM, X and the ARB values are calculated (the database is the authority, this is a live preview).
    const lab2Calc = { tm: null, lot4: false };
    const r2 = (v, d) => { const f = Math.pow(10, d); return Math.round((v + Number.EPSILON) * f) / f; };
    function lab2Preview() {
        const box = document.getElementById('lab2-calc-preview');
        const adm = parseFloat(document.getElementById('lab2-ad-moisture').value), gcv = parseFloat(document.getElementById('lab2-gcv').value), ash = parseFloat(document.getElementById('lab2-ash').value);
        const sul = parseFloat(document.getElementById('lab2-sulphur').value), vm = parseFloat(document.getElementById('lab2-vm').value);
        if (!box || lab2Calc.tm === null || !(adm > 0 && adm < 100)) { if (box) box.style.display = 'none'; return; }
        const x = (100 - lab2Calc.tm) / (100 - adm);
        let h = `<strong>X</strong> = (100 &minus; ${r2(lab2Calc.tm, 3)}) / (100 &minus; ${adm}) = <strong>${x.toFixed(6)}</strong><br>`;
        if (gcv > 0) h += `ARB GCV = <strong>${Math.round(gcv * x)}</strong> kcal/kg &nbsp; `;
        if (ash >= 0) h += `ARB Ash = <strong>${r2(ash * x, 2).toFixed(2)}</strong> %`;
        if (lab2Calc.lot4) {
            h += '<br>';
            if (sul >= 0) h += `ARB Sulphur = <strong>${r2(sul * x, 2).toFixed(2)}</strong> % &nbsp; `;
            if (vm >= 0) h += `ARB VM = <strong>${r2(vm * x, 2).toFixed(2)}</strong> %`;
        }
        if (adm > lab2Calc.tm) h += '<br><span style="color:#fbbf24;">⚠️ AD moisture is higher than TM - please check the value.</span>';
        box.innerHTML = h; box.style.display = 'block';
    }
    ['lab2-ad-moisture', 'lab2-gcv', 'lab2-ash', 'lab2-sulphur', 'lab2-vm'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', lab2Preview); });

    async function lookupLab2Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a composite barcode ID.');
            return;
        }
        await openLab2Results(() => window.BiomassAPI.getCompositeDetails(barcode));
    }

    // Typed alternative to scanning: the mixing code + the date opens exactly the same results form as the composite QR.
    function setupLab2TypedLookup() {
        const code = document.getElementById('lab2-code-input'), date = document.getElementById('lab2-code-date'), btn = document.getElementById('btn-lab2-code-open');
        if (!code || !btn || btn.dataset.wired) return;
        btn.dataset.wired = '1';
        if (!date.value) date.value = window.BiomassAPI.todayIST();
        const go = async () => {
            const c = code.value.trim().toUpperCase();
            if (!c) { alert('Type the mixing code printed on the label.'); code.focus(); return; }
            if (!date.value) { alert('Pick the date of the composite.'); return; }
            btn.disabled = true;
            try { await openLab2Results(() => window.BiomassAPI.getCompositeByCode(c, date.value)); }
            finally { btn.disabled = false; }
        };
        btn.onclick = go;
        code.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    }

    async function openLab2Results(fetchData) {
        const entryCard = document.getElementById('lab2-entry-card');
        const alertBox = document.getElementById('lab2-alert');
        const dup2 = document.getElementById('lab2-duplicate-notice');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';
        if (dup2) dup2.style.display = 'none';

        try {
            const data = await fetchData();
            if (data.success) {
                entryCard.style.display = 'block';
                document.getElementById('lab2-blind-code').textContent = `✅ ACTIVE SECURE COMPOSITE (${data.lot_type})`;
                document.getElementById('lab2-barcode-id').value = data.composite_barcode_id;

                if (data.meta || data.company_name || data.parent_truck_ids) {
                    console.error('Collusion leak warning: Identity metadata detected in composite lab session!');
                }
                if (data.is_tested) {
                    entryCard.style.display = 'none';
                    showAlreadySaved('lab2-duplicate-notice', 'The air-dried values and the calculated ARB results', data.tested_at);
                    return;
                }
                lab2Calc.tm = data.tm === null || data.tm === undefined ? null : Number(data.tm);
                lab2Calc.lot4 = !!data.is_lot4;
                document.getElementById('lab2-tm').textContent = lab2Calc.tm === null ? 'not available yet' : r2(lab2Calc.tm, 2).toFixed(2) + ' %';
                document.querySelectorAll('.lab2-lot4').forEach(el => { el.style.display = lab2Calc.lot4 ? '' : 'none'; });
                const sulEl = document.getElementById('lab2-sulphur'), vmEl = document.getElementById('lab2-vm');
                sulEl.required = lab2Calc.lot4; vmEl.required = lab2Calc.lot4;
                ['lab2-ad-moisture', 'lab2-gcv', 'lab2-ash', 'lab2-sulphur', 'lab2-vm'].forEach(id => { const el = document.getElementById(id); el.value = ''; el.disabled = false; });
                const submitBtn = document.getElementById('lab2-entry-form').querySelector('button[type="submit"]');
                if (submitBtn) submitBtn.disabled = lab2Calc.tm === null;
                lab2Preview();
                document.getElementById('lab2-ad-moisture').focus();
            } else {
                alert('Invalid lookup: ' + data.message);
            }
        } catch (err) {
            alert('Lookup failed: ' + err.message);
        }
    }

    const lab2Form = document.getElementById('lab2-entry-form');
    lab2Form.onsubmit = async function(e) {
        e.preventDefault();

        const barcode = document.getElementById('lab2-barcode-id').value;
        const vals = {
            ad_moisture: document.getElementById('lab2-ad-moisture').value, ad_gcv: document.getElementById('lab2-gcv').value, ad_ash: document.getElementById('lab2-ash').value,
            ad_sulphur: lab2Calc.lot4 ? document.getElementById('lab2-sulphur').value : '', ad_vm: lab2Calc.lot4 ? document.getElementById('lab2-vm').value : ''
        };
        const pv = document.getElementById('lab2-calc-preview');
        if (pv && pv.style.display !== 'none' && !confirm('Lock these results? They cannot be changed afterwards.\n\n' + pv.innerText)) return;

        try {
            const res = await window.BiomassAPI.submitCompositeResult(barcode, vals);
            if (res.success) {
                alert('Composite analysis locked and submitted successfully!\n\nTM ' + r2(Number(res.tm), 2).toFixed(2) + ' %  |  X ' + Number(res.x).toFixed(6) +
                      '\nARB GCV ' + res.arb_gcv + ' kcal/kg  |  ARB Ash ' + Number(res.arb_ash).toFixed(2) + ' %' +
                      (res.arb_sulphur !== null && res.arb_sulphur !== undefined ? '\nARB Sulphur ' + Number(res.arb_sulphur).toFixed(2) + ' %  |  ARB VM ' + Number(res.arb_vm).toFixed(2) + ' %' : '') +
                      (res.warning ? '\n\n⚠️ ' + res.warning : ''));
                document.getElementById('lab2-entry-card').style.display = 'none';
                renderLab2History();
            } else {
                alert('Submission failed: ' + res.message);
            }
        } catch (err) {
            alert('Submission error: ' + err.message);
        }
    };

    async function renderLab2History() {
        const tbody = document.getElementById('lab2-history-body');
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">Loading history...</td></tr>';

        try {
            const history = await window.BiomassAPI.getLab2History();
            tbody.innerHTML = '';

            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No composite tests submitted by your account today.</td></tr>';
                return;
            }

            history.forEach((row, idx) => {
                const tr = document.createElement('tr');
                const dash = v => (v === null || v === undefined) ? '-' : v;
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Composite #${history.length - idx}</strong></td>
                    <td>${row.tm !== null && row.tm !== undefined ? Number(row.tm).toFixed(2) : '-'}</td>
                    <td>${row.gcv_value} kcal/kg</td>
                    <td>${row.ash_pct}%</td>
                    <td>${row.is_lot4 ? Number(row.arb_sulphur).toFixed(2) + '%' : '-'}</td>
                    <td>${row.is_lot4 ? Number(row.arb_vm).toFixed(2) + '%' : '-'}</td>
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger);">Failed to load history: ${esc(e.message)}</td></tr>`;
        }
    }

    // ================= BARCODE INSPECTOR TAB (ADMIN) =================
    // ================= ADMIN: VENDORS (Lot 2/3 and Lot 4) =================
    const vdState = { rows: [], lot: 'ALL', status: 'active', q: '' };
    const vdLotCls = (l) => l === 'LOT4' ? 'l4' : l === 'LOT3' ? 'l3' : l === 'LOT2' ? 'l2' : 'l23';
    const vdNormLot = (t) => { const x = String(t || '').toUpperCase().replace(/[^A-Z0-9/]/g, ''); return ({ 'LOT4': 'LOT4', 'LOT04': 'LOT4', '4': 'LOT4', 'LOT3': 'LOT3', 'LOT03': 'LOT3', '3': 'LOT3', '03': 'LOT3', 'LOT2': 'LOT2', 'LOT02': 'LOT2', '2': 'LOT2', '02': 'LOT2', 'LOT2/3': 'LOT2/3', 'LOT23': 'LOT2/3', '2/3': 'LOT2/3' })[x] || x; };

    function vdDialog(o) {
        const m = document.getElementById('vd-modal'), ok = document.getElementById('vd-ok'), cancel = document.getElementById('vd-cancel'), msg = document.getElementById('vd-msg');
        document.getElementById('vd-title').innerHTML = o.title;
        document.getElementById('vd-dlg-body').innerHTML = o.html || '';
        msg.textContent = ''; msg.style.color = '';
        ok.style.display = o.hideOk ? 'none' : ''; ok.disabled = false;
        ok.textContent = o.okLabel || 'OK';
        ok.style.background = o.danger ? '#dc2626' : ''; ok.style.borderColor = o.danger ? '#dc2626' : '';
        m.style.display = 'flex';
        const close = () => { m.style.display = 'none'; };
        cancel.onclick = close;
        ok.onclick = async () => {
            ok.disabled = true; msg.style.color = ''; msg.textContent = 'Working...';
            try { await o.onOk(); close(); } catch (e) { msg.style.color = '#ef4444'; msg.textContent = e.message || String(e); ok.disabled = false; }
        };
    }
    async function vdApply(rows) {
        const r = await window.BiomassAPI.vendorApply(rows, false);
        if (!r.success) throw new Error(r.results.filter(x => x.action === 'ERROR').map(x => x.message).join('; ') || 'Nothing was changed');
        await loadVendors();
        return r;
    }
    function initVendorsTab() {
        const box = document.getElementById('tab-admin-vendors');
        if (!box) return;
        if (!box.dataset.wired) {
            box.dataset.wired = '1';
            const pick = (barId, key) => { document.getElementById(barId).onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; vdState[key] = b.dataset.v; vdRender(); }; };
            pick('vd-lot-chips', 'lot'); pick('vd-status-chips', 'status');
            document.getElementById('vd-q').oninput = (e) => { vdState.q = e.target.value; vdRender(); };
            document.getElementById('vd-add').onclick = vdAddDialog;
            document.getElementById('vd-download').onclick = vdDownloadSheet;
            document.getElementById('vd-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) vdHandleSheet(f); };
            document.getElementById('vd-body').onclick = (e) => {
                const b = e.target.closest('button[data-act]'); if (!b) return;
                const v = vdState.rows.find(x => String(x.id) === b.dataset.id); if (!v) return;
                if (b.dataset.act === 'edit') vdEditDialog(v);
                else if (b.dataset.act === 'retire') vdConfirm(`Retire <b>${esc(v.name)}</b> (${esc(v.lot)})?`, `It disappears from the gate-entry list${v.trucks ? ` (its ${v.trucks} truck(s) and their reports stay)` : ''}. You can re-activate it any time.`, 'Retire', [{ id: v.id, active: false }]);
                else if (b.dataset.act === 'restore') vdConfirm(`Re-activate <b>${esc(v.name)}</b> (${esc(v.lot)})?`, 'It will be offered at the gate again.', 'Re-activate', [{ id: v.id, active: true }], false);
                else if (b.dataset.act === 'delete') vdConfirm(`Delete <b>${esc(v.name)}</b> (${esc(v.lot)}) for good?`, 'It has no trucks, so nothing else is affected. This cannot be undone (you can add it again).', 'Delete', [{ id: v.id, remove: true }]);
            };
        }
        loadVendors();
    }
    function vdConfirm(title, text, label, rows, danger) {
        vdDialog({ title, html: `<p style="font-size:0.9rem;">${text}</p>`, okLabel: label, danger: danger !== false, onOk: async () => { await vdApply(rows); } });
    }
    async function loadVendors() {
        try { vdState.rows = await window.BiomassAPI.adminVendors(); }
        catch (e) { document.getElementById('vd-body').innerHTML = `<tr><td colspan="7" style="color:#ef4444;">${esc(e.message)}</td></tr>`; return; }
        vdRender();
    }
    function vdRender() {
        document.querySelectorAll('#vd-lot-chips button').forEach(b => b.classList.toggle('active', b.dataset.v === vdState.lot));
        document.querySelectorAll('#vd-status-chips button').forEach(b => b.classList.toggle('active', b.dataset.v === vdState.status));
        const q = vdState.q.trim().toLowerCase();
        const rows = vdState.rows.filter(v => (vdState.lot === 'ALL' || v.lot === vdState.lot) && (vdState.status === 'all' || (vdState.status === 'active') === v.active)
            && (!q || (stripMs(v.name) + ' ' + v.name).toLowerCase().includes(stripMs(q).toLowerCase()) || String(v.po_number || '').includes(q)));
        const act = vdState.rows.filter(v => v.active).length;
        document.getElementById('vd-count').textContent = `${rows.length} shown · ${vdState.rows.length} in total (${act} active, ${vdState.rows.length - act} retired)`;
        document.getElementById('vd-body').innerHTML = rows.map(v => `<tr class="${v.active ? '' : 'vd-retired'}">
            <td><strong>${esc(v.name)}</strong></td><td><span class="vd-lot ${vdLotCls(v.lot)}">${esc(lotLabel(v.lot))}</span></td><td style="font-family:monospace;">${esc(v.po_number || '-')}</td>
            <td>${esc(v.trucks)}</td><td>${v.last_used ? esc(dmy(v.last_used)) : '-'}</td>
            <td>${v.active ? '<span class="badge badge-success">ACTIVE</span>' : '<span class="badge badge-pending">RETIRED</span>'}</td>
            <td style="min-width:250px;"><button class="btn btn-secondary btn-sm" data-act="edit" data-id="${esc(v.id)}">✏️ Edit</button>
                ${v.active ? `<button class="btn btn-secondary btn-sm" data-act="retire" data-id="${esc(v.id)}">⏸ Retire</button>` : `<button class="btn btn-secondary btn-sm" data-act="restore" data-id="${esc(v.id)}">▶ Re-activate</button>`}
                ${v.trucks === 0 ? `<button class="btn btn-secondary btn-sm" style="border-color:#ef4444; color:#fca5a5;" data-act="delete" data-id="${esc(v.id)}">🗑 Delete</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No vendors match.</td></tr>';
    }
    function vdFormHtml(v, canLot) {
        const legacy = v.lot === 'LOT2/3';
        const opts = (legacy ? [['LOT2/3', 'Lot 2/3 (old - choose Lot 2 or Lot 3)']] : []).concat([['LOT2', 'Lot 2'], ['LOT3', 'Lot 3'], ['LOT4', 'Lot 4']]);
        // a vendor that has trucks cannot change its lot - except the old Lot 2/3, which may be split into Lot 2 or Lot 3 (its trucks and reports follow)
        const only23 = legacy && !canLot;
        return `<label class="vd-field">Vendor name</label><input class="vd-dlg-input" id="vdf-name" maxlength="200" value="${esc(v.name || '')}">
                <label class="vd-field">Lot</label><select class="vd-dlg-input" id="vdf-lot" ${(canLot || only23) ? '' : 'disabled'}>${opts.filter(o => !only23 || o[0] === 'LOT2/3' || o[0] === 'LOT2' || o[0] === 'LOT3').map(o => `<option value="${o[0]}"${v.lot === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select>
                ${(canLot || only23) ? '' : '<small style="color:#94a3b8;">This vendor has trucks, so its lot cannot be changed: add it under the other lot and retire this entry.</small>'}
                <label class="vd-field">PO number</label><input class="vd-dlg-input" id="vdf-po" maxlength="40" value="${esc(v.po_number || '')}" placeholder="optional">`;
    }
    function vdAddDialog() {
        vdDialog({ title: '➕ Add vendor', html: vdFormHtml({ lot: ['LOT2', 'LOT3', 'LOT4'].includes(vdState.lot) ? vdState.lot : 'LOT3' }, true) +
            '<p style="font-size:0.8rem; color:#94a3b8; margin-top:0.6rem;">A vendor that also exists under the other lot keeps the same spelling automatically.</p>', okLabel: 'Add vendor',
            onOk: async () => {
                const name = document.getElementById('vdf-name').value.trim(); if (!name) throw new Error('Type the vendor name.');
                await vdApply([{ name, lot: document.getElementById('vdf-lot').value, po_number: document.getElementById('vdf-po').value.trim() }]);
            } });
    }
    function vdEditDialog(v) {
        vdDialog({ title: `✏️ Edit ${esc(v.name)}`, html: vdFormHtml(v, v.trucks === 0) + (v.trucks ? `<p style="font-size:0.8rem; color:#94a3b8; margin-top:0.6rem;">Renaming also renames the vendor on its ${esc(v.trucks)} truck(s), composites and mixing groups. The PO of trucks already booked is not changed.</p>` : ''), okLabel: 'Save',
            onOk: async () => {
                const name = document.getElementById('vdf-name').value.trim(); if (!name) throw new Error('Type the vendor name.');
                const row = { id: v.id, name, po_number: document.getElementById('vdf-po').value.trim() };
                if (v.trucks === 0 || v.lot === 'LOT2/3') row.lot = document.getElementById('vdf-lot').value;
                const r = await vdApply([row]);
                if (r.results[0].action === 'UNCHANGED') throw new Error('Nothing was changed.');
            } });
    }

    // ---- Excel: download the vendor sheet / upload the edited one (the database is changed to match)
    async function vdDownloadSheet() {
        if (typeof ExcelJS === 'undefined') { alert('The Excel library could not be loaded. Check the internet connection and try again.'); return; }
        try {
            const rows = await window.BiomassAPI.adminVendors();
            const wb = new ExcelJS.Workbook();
            const sh = wb.addWorksheet('Vendors', { views: [{ state: 'frozen', ySplit: 1 }] });
            sh.columns = [{ header: 'ID', key: 'id', width: 8 }, { header: 'Vendor name', key: 'name', width: 52 }, { header: 'Lot', key: 'lot', width: 10 }, { header: 'PO number', key: 'po', width: 16 },
                          { header: 'Status', key: 'status', width: 11 }, { header: 'Trucks (info)', key: 'trucks', width: 13 }, { header: 'Delete?', key: 'del', width: 9 }];
            sh.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sh.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } }; });
            rows.forEach(v => sh.addRow({ id: v.id, name: v.name, lot: v.lot, po: v.po_number || '', status: v.active ? 'ACTIVE' : 'RETIRED', trucks: v.trucks, del: '' }));
            const last = rows.length + 1 + 300;                    // 300 empty lines to add new vendors
            for (let r = 2; r <= last; r++) {
                sh.getCell(r, 3).dataValidation = { type: 'list', allowBlank: true, formulae: ['"LOT2,LOT3,LOT4"'] };
                sh.getCell(r, 5).dataValidation = { type: 'list', allowBlank: true, formulae: ['"ACTIVE,RETIRED"'] };
                sh.getCell(r, 7).dataValidation = { type: 'list', allowBlank: true, formulae: ['"YES"'] };
                sh.getCell(r, 4).numFmt = '@';
                if (r <= rows.length + 1) [1, 6].forEach(c => { sh.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; });
            }
            sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } };
            const h = wb.addWorksheet('How to use');
            h.getColumn(1).width = 130;
            ['HOW TO USE THIS SHEET', '',
             '1. Edit the sheet, save it as .xlsx, then upload it in the app: Admin > Vendors > "Upload edited sheet". You see a preview first; nothing changes until you press Apply.',
             '2. To CHANGE a vendor: edit its name, lot, PO number or Status on its row. Do NOT change the ID (grey column) - the ID is how the app recognises the row.',
             '3. To ADD a vendor: type it in an empty row at the bottom (leave the ID empty): name, lot (LOT2, LOT3 or LOT4), PO number.',
             '4. To REMOVE a vendor: type YES in the "Delete?" column. A vendor that has trucks is RETIRED instead of deleted (kept for the history, hidden at the gate).',
             '5. Status RETIRED = no longer offered at gate entry. Status ACTIVE = offered.',
             '6. A vendor that has trucks cannot change its lot (add it again under the other lot and set the old row to RETIRED). One exception: an old "LOT2/3" vendor may be set to LOT2 or LOT3 - its trucks and reports follow.',
             '7. Renaming a vendor also renames it on its trucks, composites and mixing groups. The PO printed on trucks already booked is not changed.',
             '8. Rows that you leave out or do not touch are not changed. If anything in the sheet is wrong, NOTHING is applied.'].forEach((t, i) => { h.addRow([t]); if (i === 0) h.getRow(1).font = { bold: true, size: 14 }; });
            const buffer = await wb.xlsx.writeBuffer();
            const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const a = document.createElement('a'); a.href = url; a.download = `Vendors_${window.BiomassAPI.todayIST().replace(/-/g, '')}.xlsx`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch (e) { alert('Could not build the sheet: ' + e.message); }
    }
    async function vdHandleSheet(file) {
        if (typeof ExcelJS === 'undefined') { alert('The Excel library could not be loaded. Check the internet connection and try again.'); return; }
        try {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(await file.arrayBuffer());
            const sh = wb.getWorksheet('Vendors') || wb.worksheets[0];
            const cv = (cell) => { let v = cell.value; if (v && typeof v === 'object') v = v.text !== undefined ? v.text : (v.result !== undefined ? v.result : (v.richText ? v.richText.map(t => t.text).join('') : '')); return String(v === null || v === undefined ? '' : v).trim(); };
            const head = {}; sh.getRow(1).eachCell((c, i) => { head[cv(c).toLowerCase()] = i; });
            const col = (...names) => { for (const n of names) { const k = Object.keys(head).find(h => h.startsWith(n)); if (k) return head[k]; } return null; };
            const cId = col('id'), cName = col('vendor', 'name'), cLot = col('lot'), cPo = col('po'), cSt = col('status'), cDel = col('delete');
            if (!cName || !cLot) throw new Error('This does not look like the vendor sheet (columns "Vendor name" and "Lot" are missing). Download the sheet again.');
            const cur = await window.BiomassAPI.adminVendors();
            const ops = []; let same = 0;
            sh.eachRow((row, n) => {
                if (n === 1) return;
                const id = cId ? cv(row.getCell(cId)) : '', name = cv(row.getCell(cName)), lot = cv(row.getCell(cLot)), po = cPo ? cv(row.getCell(cPo)) : '';
                const st = cSt ? cv(row.getCell(cSt)).toUpperCase() : '', del = cDel ? cv(row.getCell(cDel)).toUpperCase() : '';
                if (!id && !name && !lot && !po) return;                          // empty line
                const active = st === 'ACTIVE' ? true : (st === 'RETIRED' ? false : undefined);
                if (!id) { ops.push({ name, lot, po_number: po, active, _row: n }); return; }
                const c = cur.find(x => String(x.id) === id);
                if (c && del !== 'YES' && name === c.name && vdNormLot(lot) === c.lot && po === (c.po_number || '') && (active === undefined || active === c.active)) { same++; return; }
                ops.push({ id: Number(id), name, lot, po_number: po, active, remove: del === 'YES', _row: n });
            });
            if (!ops.length) { alert(`Nothing to change: all ${same} vendor row(s) in the sheet are identical to the database.`); return; }
            const dry = await window.BiomassAPI.vendorApply(ops, true);
            const colour = { ERROR: '#ef4444', DELETED: '#f59e0b', RETIRED: '#f59e0b', ADDED: '#10b981', EDITED: '#60a5fa', RESTORED: '#10b981', UNCHANGED: '#94a3b8', SKIPPED: '#94a3b8' };
            const cnt = Object.entries(dry.counts || {}).map(([k, v]) => `<b style="color:${colour[k] || '#fff'};">${v} ${k.toLowerCase()}</b>`).join(' &middot; ');
            const list = dry.results.filter(x => x.action !== 'UNCHANGED').map(x => `<tr><td>${esc((ops[x.row - 1] && ops[x.row - 1]._row) || x.row)}</td><td style="color:${colour[x.action] || '#fff'}; font-weight:700;">${esc(x.action)}</td><td>${esc(x.message || x.name)}</td></tr>`).join('');
            vdDialog({ title: `Preview of the sheet <small style="color:#94a3b8;">(${esc(file.name)})</small>`,
                html: `<p style="font-size:0.9rem;">${cnt}${same ? ` &middot; ${same} row(s) unchanged` : ''}</p>` +
                      (dry.errors ? '<div class="alert alert-danger" style="margin:0.5rem 0;">The sheet has errors, so <b>nothing</b> would be applied. Correct the sheet and upload it again.</div>' : '<div class="alert alert-warning" style="margin:0.5rem 0;">Nothing has been changed yet. Press <b>Apply</b> to change the database as listed.</div>') +
                      `<div class="table-responsive" style="max-height:46vh; overflow:auto;"><table style="min-width:0; font-size:0.82rem;"><thead><tr><th>Sheet row</th><th>What</th><th>Details</th></tr></thead><tbody>${list}</tbody></table></div>`,
                okLabel: `Apply ${dry.results.filter(x => x.action !== 'UNCHANGED' && x.action !== 'SKIPPED').length} change(s)`, hideOk: dry.errors > 0, danger: false,
                onOk: async () => { const r = await vdApply(ops); alert('The vendors were updated: ' + Object.entries(r.counts || {}).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ') + '.'); } });
        } catch (e) { alert('The sheet could not be processed: ' + e.message); }
    }

    // ================= SUPER ADMIN CONSOLE =================
    // A console of its own (the Super Admin login has NO Admin tabs): Inspector, Toolbox, Data health, Logins and the Audit log.
    // Every change needs a reason AND the password typed again (valid for 5 minutes); the server writes it to the audit log with the IP address.
    const sx$ = (id) => document.getElementById(id);
    const SX_IDLE_MS = 10 * 60 * 1000, SX_AUTH_MS = 5 * 60 * 1000;
    let superState = { samples: [], comps: [], filter: 'all', q: '', lot: 'ALL' };
    let sxLastAuth = 0, sxLastActive = Date.now(), sxIdleTimer = null, sxCompanies = null, sxOpenTruck = null, sxGroup = null, sxWired = false, sxDetail = null;

    // Idle protection: the Super Admin session ends after 10 minutes without a click, key or touch.
    function startSuperIdleTimer() {
        if (sxIdleTimer) return;
        const bump = () => { sxLastActive = Date.now(); };
        ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => window.addEventListener(ev, bump, { passive: true }));
        sxLastActive = Date.now();
        sxIdleTimer = setInterval(() => {
            const left = SX_IDLE_MS - (Date.now() - sxLastActive);
            const chip = sx$('sx-idle-chip');
            if (chip) chip.textContent = left < 120000 ? `⏱ Signing out in ${Math.max(0, Math.ceil(left / 1000))} s` : '⏱ Auto sign-out after 10 min idle';
            if (left <= 0) hardSignOut('You were signed out after 10 minutes without activity (Super Admin).');
        }, 5000);
    }

    // Password re-check: resolves true when the Super Admin has typed the password within the last 5 minutes (or now).
    function sxEnsureAuth() {
        if (Date.now() - sxLastAuth < SX_AUTH_MS) return Promise.resolve(true);
        return new Promise(resolve => {
            const m = sx$('super-pw-modal'), pw = sx$('super-pw-input'), msg = sx$('super-pw-msg'), ok = sx$('btn-super-pw-ok'), no = sx$('btn-super-pw-cancel');
            pw.value = ''; msg.textContent = ''; m.style.display = 'flex'; pw.focus();
            const done = (v) => { m.style.display = 'none'; pw.value = ''; resolve(v); };
            no.onclick = () => done(false);
            const go = async () => {
                if (!pw.value) { msg.style.color = '#ef4444'; msg.textContent = 'Type your password.'; return; }
                ok.disabled = true; msg.style.color = ''; msg.textContent = 'Checking...';
                const good = await window.BiomassAPI.verifyPassword(pw.value);
                ok.disabled = false;
                if (good) { sxLastAuth = Date.now(); done(true); }
                else { msg.style.color = '#ef4444'; msg.textContent = 'That is not the Super Admin password.'; pw.value = ''; pw.focus(); }
            };
            ok.onclick = go;
            pw.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
        });
    }

    let sxTwoDays = null;
    function initSuperConsole() {
        if (sxWired) return;
        sxWired = true;
        startSuperIdleTimer();
        const q = sx$('super-q');
        const go = () => superSearch();
        sx$('btn-super-find').onclick = go;
        // by default only TODAY and YESTERDAY are listed; the date filter (or Clear -> change the dates) shows older days
        const twoDays = () => { const t = window.BiomassAPI.todayIST(); return [window.BiomassAPI.addDaysYMD(t, -1), t]; };
        sxTwoDays = twoDays;
        { const [f0, t0] = twoDays(); if (!sx$('super-from').value) sx$('super-from').value = f0; if (!sx$('super-to').value) sx$('super-to').value = t0; sx$('super-to').max = t0; }
        sx$('btn-super-clear').onclick = () => { const [f1, t1] = twoDays(); q.value = ''; sx$('super-from').value = f1; sx$('super-to').value = t1; sx$('sx-group-panel').style.display = 'none'; superSearch(); };
        q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
        const setFilter = (e) => {
            const b = e.target.closest('button[data-f]'); if (!b) return;
            superState.filter = b.dataset.f;
            sxRender();
        };
        sx$('sx-filter-chips').onclick = setFilter;
        sx$('sx-lot-chips').onclick = (e) => { const b = e.target.closest('button[data-lot]'); if (!b) return; superState.lot = b.dataset.lot; sxRender(); };
        sx$('sx-tiles').onclick = setFilter;
        // QR scan (camera or uploaded picture): the code goes into the search and the result opens
        setupSnapOnlyScanner({
            triggerId: 'sx-scan-trigger', readerId: 'sx-qr-reader',
            onDecode: async (decodedText) => { sxApplyScan(await processScannedCode(decodedText)); }
        });
        sx$('sx-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0]; if (!file) return;
            scanUploadedFile(file, 'sx-qr-reader',
                async (decodedText) => { try { sxApplyScan(await processScannedCode(decodedText)); } catch (err) { alert(err.message); } e.target.value = ''; },
                (msg) => { alert(msg); e.target.value = ''; });
        });
        const onGrid = (e) => {
            const b = e.target.closest('button[data-act]'); if (!b) return;
            const i = Number(b.dataset.i), act = b.dataset.act;
            if (b.dataset.k === 'c') {
                const c = superState.comps[i];
                if (act === 'cprint') superPrintComposite(c);
                else if (act === 'cedit') superEditComposite(c);
                else if (act === 'cvoid') superVoidComposite(c);
                else if (act === 'group') sxGroupPanel(c.mixing_code, c.date);
                return;
            }
            const r = superState.samples[i];
            if (act === 'open') openTruckDetail(r.truck_id);
            else if (act === 'print') superPrintSample(r);
            else if (act === 'png') superDownloadSample(r);
            else if (act === 'group') sxGroupPanel(r.mixing_code, r.entry_date);
        };
        sx$('super-samples-grid').onclick = onGrid;
        sx$('super-comps-grid').onclick = onGrid;
        sx$('btn-sxd-close').onclick = () => { sx$('super-detail-modal').style.display = 'none'; sxOpenTruck = null; };
        sx$('sxd-body').onclick = sxDetailClick;
        sx$('btn-sx-health-run').onclick = renderSuperHealth;
        sx$('btn-sx-logins-refresh').onclick = renderSuperLogins;
        sx$('btn-sx-pw-refresh').onclick = renderSuperPasswords;
        sx$('btn-sx-pw-set').onclick = superSetActionPassword;
        sx$('btn-sx-sec-refresh').onclick = renderSuperSecurity;
        sx$('btn-sx-mfa-required').onclick = superMfaSwitch;
        sx$('sx-sec-nav').onclick = (e) => { const b = e.target.closest('button[data-sec]'); if (b) secShowPane(b.dataset.sec); };
        sx$('sx-sec-overview').onclick = (e) => { const g = e.target.closest('[data-go]'); if (g) secGo(g.dataset.go); };
        sx$('sx-dev-sub').onclick = (e) => { const b = e.target.closest('button[data-sub]'); if (b) { sxSec.sub = b.dataset.sub; secRenderDevices(); } };
        sx$('sx-dev-main').onclick = secDevClick;
        sx$('btn-sx-ips-refresh').onclick = renderSuperIps;
        sx$('btn-sx-range').onclick = async () => {
            const r = sx$('sx-range').value.trim(), n = sx$('sx-range-name').value.trim();
            if (!r || !n) { alert('Type the range and a name for it.'); return; }
            const b = sx$('btn-sx-range'); b.disabled = true;
            try { const x = await window.BiomassAPI.superIpRangeLabel(r, n); alert('Range ' + x.range + ' is named "' + n + '" (' + x.addresses_named + ' listed address(es) inside it took the name).'); sx$('sx-range').value = ''; sx$('sx-range-name').value = ''; await renderSuperIps(); }
            catch (err) { alert(err.message); }
            finally { b.disabled = false; }
        };
        sx$('btn-sx-ipl-go').onclick = () => renderSuperIpLog();
        sx$('sx-ipl-ip').onchange = () => renderSuperIpLog();
        sx$('sx-ipl-q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); renderSuperIpLog(); } };
        refreshSuperIpBadge();
        superSearch();
    }

    // a scanned / uploaded QR: search it, then open the truck (or the composite's group) when it is unambiguous
    async function sxApplyScan(code) {
        sx$('super-q').value = code; sx$('super-from').value = ''; sx$('super-to').value = '';
        superState.filter = 'all';
        await superSearch();
        const S = superState.samples, C = superState.comps;
        if (S.length === 1 && !C.length) openTruckDetail(S[0].truck_id);
        else if (!S.length && C.length === 1) sxGroupPanel(C[0].mixing_code, C[0].date);
        else if (!S.length && !C.length) alert('Nothing found for the scanned code ' + code + '.');
    }

    // ---------- Inspector: search + cards ----------
    const sxF = (v, d) => (v === null || v === undefined || v === '') ? '<span style="color:#f59e0b;">&mdash;</span>' : Number(v).toFixed(d);
    function sxStatus(r) {
        if (r.cancel_status === 'VOIDED') return { cls: 'st-can', badge: '<span class="sx-pill sx-void">VOIDED</span>' };
        if (r.cancel_status === 'CANCELLED') return { cls: 'st-can', badge: '<span class="sx-pill sx-cancel">🚫 QR CANCELLED</span>' };
        const ov = r.acceptance_override ? ' <span class="sx-pill sx-ovr" title="Accept / reject was set by the Super Admin">OVERRIDE</span>' : '';
        if (r.acceptance_status === 'REJECTED') return { cls: 'st-rej', badge: '<span class="sx-pill sx-rej">REJECTED</span>' + ov };
        if (r.acceptance_status === 'ACCEPTED') return { cls: 'st-ok', badge: '<span class="sx-pill sx-ok">ACCEPTED</span>' + ov };
        return { cls: 'st-pen', badge: '<span class="sx-pill sx-pen">PENDING</span>' };
    }

    async function superSearch() {
        const note = sx$('super-note');
        note.textContent = 'Searching...';
        try {
            const q = sx$('super-q').value.trim();
            const res = await window.BiomassAPI.superFind(q, sx$('super-from').value, sx$('super-to').value);
            superState.samples = res.samples || []; superState.comps = res.composites || []; superState.q = q;
            const dd = sxTwoDays ? sxTwoDays() : null, isDefault = !!dd && sx$('super-from').value === dd[0] && sx$('super-to').value === dd[1];
            note.textContent = `${superState.samples.length} sample(s) and ${superState.comps.length} composite lot(s) found` + (superState.samples.length >= 200 ? ' (showing the newest 200 - narrow the search)' : '') + '.' +
                (isDefault ? ' Showing today and yesterday only - change the From / To dates to see older days.' : '');
            sxRender();
            // a mixing code typed exactly: open the whole group at the top
            const U = q.toUpperCase();
            if (/^[A-Z0-9]{2,8}$/.test(U)) {
                const hit = superState.samples.filter(r => String(r.mixing_code).toUpperCase() === U);
                if (hit.length) { sxGroupPanel(U, hit[0].entry_date); return; }
            }
            if (sxGroup && sx$('sx-group-panel').style.display !== 'none') sxGroupPanel(sxGroup.code, sxGroup.date);
        } catch (err) {
            note.innerHTML = `<span style="color:#ef4444;">${esc(err.message)}</span>`;
        }
    }

    function sxRender() {
        const f = superState.filter, S0 = superState.samples, C0 = superState.comps;
        const lotOK = (x) => lotMatches(x.lot, superState.lot);
        const S = S0.filter(lotOK), C = C0.filter(lotOK);              // the counts follow the Lot filter
        [...sx$('sx-lot-chips').querySelectorAll('button[data-lot]')].forEach(b => b.classList.toggle('active', b.dataset.lot === superState.lot));
        const keepS = (r) => f === 'all' || f === 'samples' || (f === 'trucks' && r.kind === 'TRUCK_SAMPLE') || (f === 'bottom' && r.kind === 'BOTTOM_SAMPLE')
            || (f === 'cancelled' && !!r.cancel_status) || (f === 'accepted' && !r.cancel_status && r.acceptance_status === 'ACCEPTED')
            || (f === 'rejected' && !r.cancel_status && r.acceptance_status === 'REJECTED')
            || (f === 'open' && !r.cancel_status && (r.moisture_pct === null || r.moisture_pct === undefined));
        const keepC = (c) => f === 'all' || f === 'comps' || (f === 'open' && (c.arb_gcv === null || c.arb_gcv === undefined));
        const showComps = f === 'all' || f === 'comps' || f === 'open';
        const n = (fn) => S.filter(fn).length;
        const tiles = [['Samples', S.length, 'samples'], ['Bottom samples', n(r => r.kind === 'BOTTOM_SAMPLE'), 'bottom'], ['Composites', C.length, 'comps'],
                       ['Accepted', n(r => !r.cancel_status && r.acceptance_status === 'ACCEPTED'), 'accepted'], ['Rejected', n(r => !r.cancel_status && r.acceptance_status === 'REJECTED'), 'rejected'],
                       ['Waiting', n(r => !r.cancel_status && (r.moisture_pct === null || r.moisture_pct === undefined)), 'open'], ['Cancelled / voided', n(r => !!r.cancel_status), 'cancelled']];
        sx$('sx-tiles').innerHTML = tiles.map(t => `<button type="button" class="sx-tile${f === t[2] ? ' active' : ''}" data-f="${t[2]}" title="Show only: ${esc(t[0])}"><small>${t[0]}</small><b>${t[1]}</b></button>`).join('');
        [...sx$('sx-filter-chips').querySelectorAll('button[data-f]')].forEach(b => b.classList.toggle('active', b.dataset.f === f));

        const sHtml = S0.map((r, i) => {
            if (!lotOK(r) || !keepS(r)) return '';
            const st = sxStatus(r), bottom = r.kind === 'BOTTOM_SAMPLE';
            const old = (r.old_codes || []).length ? `<div class="sx-qr" title="Old QR codes of this sample (no longer valid)">replaced: ${esc(r.old_codes.join(', '))}</div>` : '';
            return `<div class="sx-card ${bottom && st.cls !== 'st-can' ? 'st-bot' : st.cls}">
                <div class="sx-card-top"><div class="sx-reg">${esc(r.truck_reg_number)}</div><div>${bottom ? '<span class="sx-pill sx-bot">Bottom sample</span> ' : ''}${st.badge}</div></div>
                <div class="sx-vendor">${esc(r.company_name)}</div>
                <div class="sx-meta"><span class="sx-code">${esc(r.mixing_code)}</span><span>${esc(dmy(r.entry_date))} ${esc(r.entry_time || '')}</span><span>${esc(r.lot)}</span><span>PO ${esc(r.po_number || '-')}</span>${r.excluded_from_mix && !bottom ? '<span style="color:#fca5a5;">out of mix</span>' : ''}</div>
                ${r.cancel_status && r.cancel_reason ? `<div class="sx-meta" style="color:#d1d5db;">Reason: ${esc(r.cancel_reason)}</div>` : ''}
                <div class="sx-stats"><div><small>Moisture</small><b>${sxF(r.moisture_pct, 2)}</b></div><div><small>Fineness</small><b>${sxF(r.fineness_value, 2)}</b></div><div><small>Truck id</small><b style="font-size:0.7rem;">${esc(r.truck_id)}</b></div></div>
                <div class="sx-qr">${esc(r.sample1_barcode_id)}</div>${old}
                <div class="sx-actions">
                    <button class="btn btn-primary btn-sm" data-act="open" data-i="${i}">🔍 Open &amp; edit</button>
                    <button class="btn btn-secondary btn-sm" data-act="print" data-i="${i}">🖨️ Print QR</button>
                    <button class="btn btn-secondary btn-sm" data-act="png" data-i="${i}" title="Download the QR as a picture">⬇</button>
                    <button class="btn btn-secondary btn-sm" data-act="group" data-i="${i}" title="Everything of this mixing code">👥 Group</button>
                </div></div>`;
        }).join('');
        sx$('super-samples-grid').innerHTML = sHtml || '<div class="sx-note">No samples to show.</div>';
        sx$('sx-h-samples').style.display = f === 'comps' ? 'none' : '';
        sx$('super-samples-grid').style.display = f === 'comps' ? 'none' : '';

        const cHtml = C0.map((c, i) => {
            if (!lotOK(c) || !keepC(c)) return '';
            const l4 = c.lot === 'LOT4', tested = c.arb_gcv !== null && c.arb_gcv !== undefined;
            const vals = tested
                ? `<div class="sx-stats"><div><small>TM</small><b>${sxF(c.tm_value, 2)}</b></div><div><small>ARB GCV</small><b>${esc(c.arb_gcv)}</b></div><div><small>ARB Ash</small><b>${sxF(c.arb_ash, 2)}</b></div></div>` +
                  `<div class="sx-meta">AD: ${sxF(c.ad_moisture, 2)}% moisture / ${sxF(c.ad_gcv, 0)} GCV / ${sxF(c.ad_ash, 2)}% ash${l4 ? ` / S ${sxF(c.ad_sulphur, 2)}% / VM ${sxF(c.ad_vm, 2)}%` : ''}${l4 ? `<br>ARB: S ${sxF(c.arb_sulphur, 2)}% / VM ${sxF(c.arb_vm, 2)}%` : ''}</div>`
                : '<div class="sx-meta" style="color:#fcd34d;">⏳ AD values not entered yet</div>';
            return `<div class="sx-card st-cmp">
                <div class="sx-card-top"><div class="sx-reg">${esc(c.composite_ref_id)}</div><span class="sx-pill ${tested ? 'sx-ok' : 'sx-pen'}">${tested ? 'TESTED' : 'NOT TESTED'}</span></div>
                <div class="sx-vendor">${esc(c.company_name)}</div>
                <div class="sx-meta"><span class="sx-code">${esc(c.mixing_code)}</span><span>${esc(dmy(c.date))}</span><span>${esc(c.lot)}</span><span>${esc(c.truck_count)} truck(s)</span></div>
                ${vals}
                <div class="sx-actions">
                    <button class="btn btn-primary btn-sm" data-k="c" data-act="cedit" data-i="${i}">✏️ Edit AD values</button>
                    <button class="btn btn-secondary btn-sm" data-k="c" data-act="cprint" data-i="${i}">🖨️ Print 3 labels</button>
                    <button class="btn btn-secondary btn-sm" data-k="c" data-act="group" data-i="${i}">👥 Group</button>
                    <button class="btn btn-secondary btn-sm sx-danger" data-k="c" data-act="cvoid" data-i="${i}">🗑 Void</button>
                </div></div>`;
        }).join('');
        sx$('super-comps-grid').innerHTML = cHtml || '<div class="sx-note">No composite lots to show.</div>';
        sx$('sx-h-comps').style.display = showComps ? '' : 'none';
        sx$('super-comps-grid').style.display = showComps ? '' : 'none';
    }

    // ---------- Group (mixing code) overview ----------
    async function sxGroupPanel(code, date) {
        const box = sx$('sx-group-panel');
        code = String(code || '').toUpperCase();
        sxGroup = { code, date };
        box.style.display = 'block';
        box.innerHTML = `<div class="sx-loading">Loading mixing code ${esc(code)}...</div>`;
        try {
            const [ms, fd] = await Promise.all([window.BiomassAPI.mixingSearch(code), window.BiomassAPI.superFind(code, date, date)]);
            const rows = (ms.rows || []).filter(r => r.entry_date === date);
            const comp = (fd.composites || []).find(c => String(c.mixing_code).toUpperCase() === code && c.date === date) || null;
            const cnt = (st) => rows.filter(r => r.mix_status === st).length;
            const incl = rows.filter(r => r.mix_status === 'ACCEPTED'), scanned = incl.filter(r => r.mixing_scanned).length;
            const vendors = [...new Set(rows.map(r => r.company_name))];
            const idx = {};
            const compIdx = comp ? superState.comps.findIndex(c => c.composite_ref_id === comp.composite_ref_id) : -1;
            // the composite object must exist in superState for the shared handlers
            let cRef = comp;
            if (comp && compIdx < 0) { superState.comps.push(comp); cRef = comp; }
            box.innerHTML = `
                <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap; align-items:center;">
                    <h3>👥 Mixing code <span class="sx-code" style="font-size:1.1rem;">${esc(code)}</span> &middot; ${esc(dmy(date))}</h3>
                    <button class="btn btn-secondary btn-sm" id="sx-group-close">✕ Hide</button>
                </div>
                <div class="sx-meta" style="font-size:0.85rem; color:#e2e8f0;">${esc(vendors.join(' / ') || '-')} &middot; ${esc(rows[0] ? rows[0].lot : '')} &middot; PO ${esc(rows[0] ? rows[0].po_number || '-' : '-')}</div>
                <div class="sx-tiles" style="margin-top:0.7rem;">
                    <div class="sx-tile"><small>In the mixture</small><b>${incl.length}</b></div>
                    <div class="sx-tile"><small>Scanned (Fineness)</small><b>${scanned} / ${incl.length}</b></div>
                    <div class="sx-tile"><small>Rejected</small><b>${cnt('REJECTED')}</b></div>
                    <div class="sx-tile"><small>Cancelled</small><b>${cnt('CANCELLED')}</b></div>
                    <div class="sx-tile"><small>Waiting</small><b>${cnt('PENDING')}</b></div>
                    <div class="sx-tile"><small>Composite</small><b style="font-size:0.95rem;">${comp ? esc(comp.composite_ref_id) : 'not made'}</b></div>
                </div>
                <div class="sx-btnrow">
                    ${comp ? `<button class="btn btn-primary btn-sm" id="sx-g-print">🖨️ Print the 3 labels</button>
                              <button class="btn btn-secondary btn-sm" id="sx-g-edit">✏️ Edit AD values</button>
                              <button class="btn btn-secondary btn-sm sx-danger" id="sx-g-void">🗑 Void composite (so it can be made again)</button>`
                          : `<button class="btn btn-primary btn-sm" id="sx-g-force">⚡ Force-create the composite</button>`}
                </div>
                <div class="table-responsive"><table class="mixsearch-table" style="min-width:0; font-size:0.82rem;"><thead><tr><th>Truck</th><th>Sample QR</th><th>Type</th><th>Moisture</th><th>Fineness</th><th>Result</th><th>In mixture</th><th>Scanned</th><th></th></tr></thead><tbody>
                ${rows.map(r => {
                    const st = sxStatus(r);
                    const inMix = r.mix_status === 'ACCEPTED' ? '<span class="sx-pill sx-ok">Included</span>' : r.mix_status === 'CANCELLED' ? '<span class="sx-pill sx-cancel">Cancelled</span>' : r.mix_status === 'REJECTED' ? '<span class="sx-pill sx-rej">Left out</span>' : '<span class="sx-pill sx-pen">Waiting</span>';
                    return `<tr><td><b>${esc(r.truck_reg_number)}</b><br><small style="color:#94a3b8;">${esc(r.driver_name || '')}</small></td><td style="font-family:monospace; font-size:0.74rem;">${esc(r.sample1_barcode_id)}</td>
                        <td>${r.is_bottom_sample ? '<span class="sx-pill sx-bot">Bottom</span>' : 'Truck'}</td><td>${sxF(r.moisture_pct, 2)}</td><td>${sxF(r.fineness_value, 2)}</td><td>${st.badge}</td><td>${inMix}</td><td>${r.mixing_scanned ? '✅' : '-'}</td>
                        <td><button class="btn btn-secondary btn-sm" data-gopen="${esc(r.truck_id)}">🔍 Open</button></td></tr>`;
                }).join('') || '<tr><td colspan="9" style="color:#94a3b8;">No trucks.</td></tr>'}
                </tbody></table></div>`;
            sx$('sx-group-close').onclick = () => { box.style.display = 'none'; sxGroup = null; };
            box.onclick = (e) => { const b = e.target.closest('button[data-gopen]'); if (b) openTruckDetail(b.dataset.gopen); };
            const bind = (id, fn) => { const el = sx$(id); if (el) el.onclick = fn; };
            bind('sx-g-print', () => superPrintComposite(cRef));
            bind('sx-g-edit', () => superEditComposite(cRef));
            bind('sx-g-void', () => superVoidComposite(cRef));
            bind('sx-g-force', () => superForceComposite(code, date));
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
            box.innerHTML = `<div style="color:#ef4444;">${esc(e.message)}</div>`;
        }
    }

    // ---------- Printing ----------
    function superPrintSample(r) {
        window.BiomassAPI.superLogAction('QR_PRINT', `Printed the label of ${r.kind === 'BOTTOM_SAMPLE' ? 'BOTTOM sample' : 'sample'} ${r.sample1_barcode_id} (truck ${r.truck_reg_number}, mixing code ${r.mixing_code}, ${dmy(r.entry_date)})`);
        window.printSampleLabel(r.sample1_barcode_id, r.entry_date);
    }
    async function superDownloadSample(r) {
        window.BiomassAPI.superLogAction('QR_DOWNLOAD', `Downloaded the QR image of ${r.kind === 'BOTTOM_SAMPLE' ? 'BOTTOM sample' : 'sample'} ${r.sample1_barcode_id} (truck ${r.truck_reg_number}, ${dmy(r.entry_date)})`);
        const enc = await encryptPayload(r.sample1_barcode_id);
        QRCode.toCanvas(sx$('qr-canvas-super'), enc, { errorCorrectionLevel: 'M', width: 246, margin: 4 }, function(err) {
            if (err) { alert('Could not draw the QR.'); return; }
            downloadQrAsPng('#qr-canvas-super', `Sample_${r.sample1_barcode_id}`, dmy(r.entry_date), r.sample1_barcode_id);
        });
    }
    // The three composite labels (Test / Referee / Vendor), same layout as at Lab 2: 50 x 50 mm, one page each; Vendor and Referee carry the COMPLETE vendor name.
    async function superPrintComposite(c) {
        window.BiomassAPI.superLogAction('QR_PRINT', `Printed the 3 labels (T/R/V) of composite ${c.composite_ref_id} (mixing code ${c.mixing_code}, ${dmy(c.date)})`);
        const initials = String(c.vendor_initials || '').toUpperCase(), group = String(c.mixing_code || '').toUpperCase();
        const lots = [[c.test_lot, 'TEST LOT (-T)', false], [c.referee_lot, 'REFEREE LOT (-R)', true], [c.vendor_lot, 'VENDOR LOT (-V)', true]];
        const vendorLabel = String(c.company_name || '').trim().toUpperCase() || initials;
        const label = (lotId, name, withInit, canvasId) => labelHtmlFor(lotId, name, withInit ? vendorLabel : '', group, c.date, canvasId);
        const box = document.getElementById('print-section');
        box.innerHTML = lots.map((l, i) => `<div class="label-page">${label(l[0], l[1], l[2], 'super-qr-' + i)}</div>`).join('');
        for (let i = 0; i < lots.length; i++) {
            const enc = await encryptPayload(lots[i][0]);
            await new Promise(res => QRCode.toCanvas(document.getElementById('super-qr-' + i), enc, { errorCorrectionLevel: 'M', width: 410, margin: 4 }, () => res()));
        }
        document.body.classList.add('printing-label'); setLabelPageSize(true);
        setTimeout(() => { window.print(); document.body.classList.remove('printing-label'); setLabelPageSize(false); }, 250);
    }

    // ---------- The generic "change something" dialog ----------
    // fields = [{id, label, value, type: number|text|date|select|textarea, step, hint, options:[{v,l}]}]; onSave(values, reason) does the work.
    function openSuperEdit(title, info, fields, onSave, opts) {
        opts = opts || {};
        const modal = sx$('super-edit-modal'), box = sx$('super-edit-fields');
        sx$('super-edit-title').textContent = title;
        sx$('super-edit-info').innerHTML = info;
        box.innerHTML = fields.map(f => {
            const val = f.value === null || f.value === undefined ? '' : String(f.value);
            const lab = `<label style="display:block; font-size:0.8rem; margin:0.4rem 0 0.15rem;">${esc(f.label)}${f.hint ? ` <small style="color:#94a3b8;">${esc(f.hint)}</small>` : ''}</label>`;
            let inp;
            if (f.type === 'select') inp = `<select id="se-${f.id}" style="width:100%; padding:0.5rem;">${(f.options || []).map(o => `<option value="${esc(o.v)}"${String(o.v) === val ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
            else if (f.type === 'textarea') inp = `<textarea id="se-${f.id}" rows="2" style="width:100%; padding:0.5rem;">${esc(val)}</textarea>`;
            else if (f.type === 'password') inp = `<input type="password" id="se-${f.id}" autocomplete="new-password" maxlength="100" style="width:100%; padding:0.5rem;">`;
            else if (f.type === 'text' || f.type === 'date') inp = `<input type="${f.type}" id="se-${f.id}" value="${esc(val)}" style="width:100%; padding:0.5rem;">`;
            else inp = `<input type="number" step="${f.step || 'any'}" id="se-${f.id}" value="${esc(val)}" style="width:100%; padding:0.5rem;">`;
            return lab + inp;
        }).join('');
        if (opts.onRender) opts.onRender(box);
        const reason = sx$('super-edit-reason'), msg = sx$('super-edit-msg'), save = sx$('btn-super-edit-save');
        reason.value = ''; msg.textContent = ''; save.disabled = false;
        save.textContent = opts.saveLabel || 'Save & record';
        save.style.background = opts.danger === false ? '' : '#dc2626';
        modal.style.display = 'flex';
        sx$('btn-super-edit-cancel').onclick = () => { modal.style.display = 'none'; };
        save.onclick = async () => {
            const vals = {}; fields.forEach(f => { vals[f.id] = f.type === 'password' ? sx$('se-' + f.id).value : sx$('se-' + f.id).value.trim(); });
            const why = reason.value.trim();
            if (why.length < 5) { msg.style.color = '#ef4444'; msg.textContent = 'Please type a reason (at least 5 characters).'; return; }
            save.disabled = true;
            if (!(await sxEnsureAuth())) { msg.style.color = '#ef4444'; msg.textContent = 'The password was not confirmed - nothing was changed.'; save.disabled = false; return; }
            msg.style.color = ''; msg.textContent = 'Saving...';
            try {
                await onSave(vals, why);
                modal.style.display = 'none';
                if (opts.after) opts.after(); else sxAfter();
            } catch (e) {
                msg.style.color = '#ef4444'; msg.textContent = e.message || String(e); save.disabled = false;
            }
        };
    }
    // after any change: refresh the search, the open group and the open truck
    function sxAfter() {
        superSearch();
        if (sxOpenTruck && sx$('super-detail-modal').style.display !== 'none') openTruckDetail(sxOpenTruck, true);
    }

    function superEditLab1(r) {
        openSuperEdit('Feed / correct moisture & fineness', `Sample <b>${esc(r.sample1_barcode_id)}</b> &bull; truck ${esc(r.truck_reg_number)} &bull; mixing code ${esc(r.mixing_code)}.<br>Leave a box empty to keep that value. Locked values can be overwritten here. A moisture change recalculates every composite that contains the truck.`, [
            { id: 'moisture', label: 'Moisture (%)', value: r.moisture_pct, step: '0.001' },
            { id: 'fineness_value', label: 'Fineness (%) - typed directly', value: r.fineness_value, step: '0.01', hint: '(ignored when both weights below are given)' },
            { id: 'fineness_initial_weight', label: 'Fineness initial weight (kg)', value: r.fineness_initial_weight, step: '0.001' },
            { id: 'fineness_final_weight', label: 'Fineness final weight (kg)', value: r.fineness_final_weight, step: '0.001' }
        ], async (v, why) => {
            const p = { barcode: r.sample1_barcode_id, reason: why };
            ['moisture', 'fineness_value', 'fineness_initial_weight', 'fineness_final_weight'].forEach(k => { if (v[k] !== '') p[k] = v[k]; });
            const hasW = p.fineness_initial_weight !== undefined && p.fineness_final_weight !== undefined;
            if (hasW) delete p.fineness_value;
            // unchanged values are not sent (so only real changes are written and logged)
            if (p.moisture !== undefined && r.moisture_pct !== null && r.moisture_pct !== undefined && Number(p.moisture) === Number(r.moisture_pct)) delete p.moisture;
            if (!hasW && p.fineness_value !== undefined && r.fineness_value !== null && r.fineness_value !== undefined && Number(p.fineness_value) === Number(r.fineness_value)) delete p.fineness_value;
            if (hasW && Number(p.fineness_initial_weight) === Number(r.fineness_initial_weight) && Number(p.fineness_final_weight) === Number(r.fineness_final_weight)) { delete p.fineness_initial_weight; delete p.fineness_final_weight; }
            if ((p.fineness_initial_weight !== undefined) !== (p.fineness_final_weight !== undefined)) throw new Error('Enter BOTH weights, or none.');
            if (p.moisture === undefined && p.fineness_value === undefined && p.fineness_initial_weight === undefined) throw new Error('Nothing was changed.');
            const res = await window.BiomassAPI.superFeedLab1(p);
            alert(`Saved and recorded.\n\nMoisture ${res.moisture_pct}  |  Fineness ${res.fineness_value}  |  ${res.acceptance_status}\nAny composite containing this truck was recalculated.`);
        });
    }
    function superEditComposite(c) {
        const l4 = c.lot === 'LOT4';
        const fields = [
            { id: 'ad_moisture', label: 'AD Moisture (%)', value: c.ad_moisture, step: '0.001' },
            { id: 'ad_gcv', label: 'AD GCV (kcal/kg)', value: c.ad_gcv, step: '0.01' },
            { id: 'ad_ash', label: 'AD Ash (%)', value: c.ad_ash, step: '0.001' }
        ].concat(l4 ? [{ id: 'ad_sulphur', label: 'AD Sulphur (%)', value: c.ad_sulphur, step: '0.001' }, { id: 'ad_vm', label: 'AD VM (%)', value: c.ad_vm, step: '0.001' }] : []);
        openSuperEdit('Feed / correct the AD values', `Composite <b>${esc(c.composite_ref_id)}</b> (${esc(c.lot)}), mixing code ${esc(c.mixing_code)}. TM, X and the ARB values are recalculated from what you save. All values are needed.`, fields, async (v, why) => {
            const p = { code: c.composite_ref_id, reason: why };
            fields.forEach(f => { if (v[f.id] === '') throw new Error('Fill in ' + f.label + '.'); p[f.id] = v[f.id]; });
            const res = await window.BiomassAPI.superFeedComposite(p);
            alert(`Saved and recorded.\n\nTM ${Number(res.tm).toFixed(2)} %  |  X ${Number(res.x).toFixed(6)}\nARB GCV ${res.arb_gcv}  |  ARB Ash ${Number(res.arb_ash).toFixed(2)} %` +
                  (res.arb_sulphur !== null && res.arb_sulphur !== undefined ? `\nARB Sulphur ${Number(res.arb_sulphur).toFixed(2)} %  |  ARB VM ${Number(res.arb_vm).toFixed(2)} %` : ''));
        });
    }
    // Tool 1: composite although some accepted containers were not scanned in the Fineness login
    function superForceComposite(code, date) {
        openSuperEdit('Force-create the composite', `Mixing code <b>${esc(code)}</b>, ${esc(dmy(date))}. The composite is made <b>without</b> waiting for every accepted container to be scanned in the Fineness login. Everything else is still checked (no waiting moisture results, at least one accepted sample, no earlier composite). Only the trucks that are ACCEPTED are mixed - make sure the physical mixture matches.`, [], async (v, why) => {
            const res = await window.BiomassAPI.superForceComposite({ group_code: code, date, reason: why });
            const b = res.batch;
            alert(`Composite ${b.composite_ref_id} created for mixing code ${code}.`);
            if (confirm('Print the 3 labels (Test / Referee / Vendor) now?')) {
                superPrintComposite({ composite_ref_id: b.composite_ref_id, test_lot: b.test_lot, referee_lot: b.referee_lot, vendor_lot: b.vendor_lot,
                    company_name: b.vendor_name, vendor_initials: b.vendor_initials, mixing_code: b.daily_group_code, date: b.date });
            }
        }, { saveLabel: 'Create composite' });
    }
    // Tool 5: void a composite so the group can be mixed again
    function superVoidComposite(c) {
        openSuperEdit('Void composite', `Composite <b>${esc(c.composite_ref_id)}</b> (mixing code ${esc(c.mixing_code)}, ${esc(dmy(c.date))}) will be voided: its record (including any GCV / ash already entered) is <b>archived</b>, its trucks are released and the labels it printed stop working. The group can then be mixed again. If a truck must <b>move</b> to another group, void its composite first, then edit the truck's vendor / date.`, [], async (v, why) => {
            await window.BiomassAPI.superVoidComposite({ code: c.composite_ref_id, reason: why });
            alert('Composite voided. The mixing group can create a new composite.');
        }, { saveLabel: 'Void composite' });
    }

    // ---------- Truck detail ----------
    async function openTruckDetail(truckId, keep) {
        const modal = sx$('super-detail-modal'), body = sx$('sxd-body');
        sxOpenTruck = truckId;
        modal.style.display = 'flex';
        if (!keep) body.innerHTML = '<div class="sx-loading">Loading...</div>';
        let d;
        try { d = await window.BiomassAPI.superDetail({ truck_id: truckId }); }
        catch (e) { body.innerHTML = `<div style="color:#ef4444; padding:1rem;">${esc(e.message)}</div>`; return; }
        sxDetail = d;
        const t = d.truck, l = d.lab1 || {}, tr = { truck_id: t.truck_id };
        const st = sxStatus({ cancel_status: t.cancel_status, acceptance_status: d.status, acceptance_override: t.acceptance_override });
        const kv = (k, v) => `<div><small>${k}</small>${v === null || v === undefined || v === '' ? '<span style="color:#94a3b8;">-</span>' : v}</div>`;
        const wt = (v) => Number(v) > 0 ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-';
        const locked = (d.group_composite || (d.composites || []).length);
        const btn = (act, label, cls, extra) => `<button class="btn ${cls || 'btn-secondary'} btn-sm" data-act="${act}" ${extra || ''}>${label}</button>`;
        const photoBtns = [['truck', t.has_photo, 'Truck photo'], ['moisture', l.has_moisture_photo, 'Moisture photo'], ['fineness_initial', l.has_fineness_initial_photo, 'Fineness (before)'], ['fineness_final', l.has_fineness_final_photo, 'Fineness (after)']]
            .filter(x => x[1]).map(x => btn('photo', '🖼 ' + x[2], 'btn-secondary', `data-kind="${x[0]}" data-id="${esc(x[0] === 'truck' ? t.truck_id : t.sample1_barcode_id)}"`)).join(' ');
        const comps = d.composites || [];
        const bs = d.bottom_sample, br = d.bottom_request;
        const bottomState = bs && !bs.cancel_status ? `Generated: <span style="font-family:monospace;">${esc(bs.sample1_barcode_id)}</span> (mixing code ${esc(bs.daily_group_code)})`
            : br && br.status === 'REQUESTED' ? 'Requested - waiting for the Entry login to generate the label' : 'No bottom sample';
        const isCancelled = !!t.cancel_status;
        const html = `
            <div class="sxd-sec" style="border-color:rgba(239,68,68,0.5);">
                <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap; align-items:center;">
                    <div><span class="sx-code" style="font-size:1.05rem;">${esc(t.daily_group_code)}</span> &nbsp; ${st.badge} ${d.mix_status === 'REJECTED' && d.status === 'ACCEPTED' ? '<span class="sx-pill sx-bot">replaced by bottom sample</span>' : ''}
                        ${t.cancel_status ? `<div style="font-size:0.85rem; margin-top:0.4rem; color:#d1d5db;">${esc(t.cancel_status)}: ${esc(t.cancel_reason || '')} <small>(by ${esc(t.cancelled_by || '-')})</small></div>` : ''}
                        ${t.acceptance_override ? `<div style="font-size:0.85rem; margin-top:0.4rem; color:#c4b5fd;">Super Admin override: ${esc(t.acceptance_override)} - ${esc(t.override_reason || '')}</div>` : ''}</div>
                    <div>${photoBtns}</div>
                </div>
            </div>

            <div class="sxd-sec"><h5>Registration</h5>
                <div class="sxd-kv">${kv('Vehicle no.', `<b>${esc(t.truck_reg_number)}</b>`)}${kv('Driver', esc(t.driver_name))}${kv('Invoice / challan', esc(t.invoice_no || t.challan_no))}
                    ${kv('Vendor', esc(t.company_name))}${kv('Lot', esc(t.lot))}${kv('PO number', esc(t.po_number))}${kv('Entry', esc(dmy(t.entry_date)) + ' ' + esc(t.entry_time || ''))}${kv('Truck id', esc(t.truck_id))}</div>
                <div class="sx-btnrow">${btn('edit-reg', '✏️ Edit registration details', 'btn-primary')}</div>
                <div class="sx-meta">Changing the vehicle number, driver or invoice never changes the mixing group. Changing the <b>vendor</b> (or the date) moves the truck to that vendor's mixing group.</div>
            </div>

            <div class="sxd-sec"><h5>Weighment</h5>
                <div class="sxd-kv">${kv('Gross (kg)', wt(t.gross_weight))}${kv('Final / tare (kg)', wt(t.tare_weight))}${kv('Net (kg)', wt(t.net_weight))}</div></div>

            <div class="sxd-sec"><h5>Lab 1 results</h5>
                <div class="sxd-kv">${kv('Moisture %', sxF(l.moisture_pct, 3))}${kv('Fineness %', sxF(l.fineness_value, 2))}${kv('Fineness weights (kg)', l.fineness_initial_weight ? `${esc(l.fineness_initial_weight)} &rarr; ${esc(l.fineness_final_weight)}` : '')}${kv('Tested', esc(l.tested_at || ''))}${kv('Scanned for mixing', d.mixing_scanned ? '✅ yes' : 'no')}</div>
                <div class="sx-btnrow">${btn('feed-lab1', '✏️ Feed / correct results', 'btn-primary')}</div></div>

            <div class="sxd-sec"><h5>Accept / reject decision</h5>
                <div class="sx-meta" style="margin-bottom:0.4rem;">Normally decided by the moisture rule. Use an override only for a documented exception (needs a reason; the group's composite must not exist yet).</div>
                <div class="sx-btnrow">${btn('ovr', '✅ Force ACCEPT', 'btn-secondary', 'data-st="ACCEPTED"')}${btn('ovr', '⛔ Force REJECT', 'btn-secondary sx-danger', 'data-st="REJECTED"')}${t.acceptance_override ? btn('ovr', '↩ Back to the moisture rule', 'btn-secondary', 'data-st="NONE"') : ''}</div></div>

            <div class="sxd-sec"><h5>Sample QR code</h5>
                <div class="sx-qr" style="font-size:0.85rem; color:#fff;">${esc(t.sample1_barcode_id)}</div>
                ${(d.qr_history || []).length ? `<div class="sx-meta">Replaced earlier (no longer valid): ${d.qr_history.map(h => esc(h.old_barcode)).join(', ')}</div>` : ''}
                <div class="sx-btnrow">${btn('print-qr', '🖨️ Print the QR label')}${btn('png-qr', '⬇ Download picture')}${btn('replace-qr', '🔁 Replace lost / damaged QR', 'btn-secondary sx-danger')}</div></div>

            <div class="sxd-sec"><h5>Bottom sample</h5>
                <div style="font-size:0.85rem; margin-bottom:0.4rem;">${bottomState}</div>
                <div class="sx-btnrow">
                    ${!br && !isCancelled ? btn('bottom', '➕ Request a bottom sample (no password)', 'btn-secondary', 'data-b="REQUEST"') : ''}
                    ${br && br.status === 'REQUESTED' ? btn('bottom', '✖ Cancel the request', 'btn-secondary', 'data-b="CANCEL_REQUEST"') : ''}
                    ${br && br.status === 'GENERATED' && bs && !bs.cancel_status ? btn('bottom', '↩ Undo the bottom sample', 'btn-secondary sx-danger', 'data-b="UNDO"') : ''}
                </div></div>

            <div class="sxd-sec"><h5>Composite</h5>
                ${comps.length ? comps.map((c, i) => `<div style="display:flex; justify-content:space-between; gap:0.5rem; flex-wrap:wrap; align-items:center; padding:0.3rem 0; border-top:1px dashed rgba(255,255,255,0.1);">
                    <div><b>${esc(c.composite_ref_id)}</b> &middot; code ${esc(c.daily_group_code)} &middot; ${esc(dmy(c.date))} ${c.gcv_value != null ? `&middot; ARB GCV ${esc(c.gcv_value)} / ash ${esc(c.ash_pct)}` : '&middot; not tested'}</div>
                    <div>${btn('comp-void', '🗑 Void composite', 'btn-secondary sx-danger', `data-ref="${esc(c.composite_ref_id)}"`)}</div></div>`).join('')
                    : (d.group_composite ? `<div>The group's composite <b>${esc(d.group_composite.composite_ref_id)}</b> was made without this truck.</div>` : '<div style="color:#94a3b8;">This truck is not in a composite yet.</div>')}
            </div>

            <div class="sxd-sec"><h5>Cancel / void</h5>
                <div class="sx-meta" style="margin-bottom:0.4rem;"><b>Cancel QR</b>: the truck stays in the reports as "QR cancelled" with the reason (the sample is left out of the mixture). <b>Void</b>: the truck was registered by mistake - it disappears from every list and report (nothing is deleted).</div>
                <div class="sx-btnrow">
                    ${!isCancelled ? btn('cancel', '🚫 Cancel the QR', 'btn-secondary sx-danger') + btn('void', '🗑 Void this registration', 'btn-secondary sx-danger') : btn('restore', `↩ Restore (${esc(t.cancel_status)})`, 'btn-primary')}
                </div>${locked ? '<div class="sx-meta">⚠ This truck\'s mixing group already has a composite - void that composite first for these actions.</div>' : ''}</div>

            <div class="sxd-sec"><h5>Audit trail of this truck</h5>
                <div class="sxd-trail">${(d.audit || []).map(a => `<div><b>${esc(a.timestamp)}</b> &middot; ${esc(a.username)} &middot; <span style="color:#fca5a5;">${esc(a.action)}</span><br>${esc(a.details)}${a.ip ? ` <small style="color:#94a3b8;">[${esc(a.ip)}]</small>` : ''}</div>`).join('') || '<div>No entries.</div>'}</div></div>`;
        sx$('sxd-title').innerHTML = `${esc(t.truck_reg_number)} <span style="font-size:0.9rem; font-weight:500; color:#94a3b8;">&middot; ${esc(t.company_name)}</span>`;
        sx$('sxd-body').innerHTML = html;
    }

    async function sxLoadCompanies() {
        if (!sxCompanies) sxCompanies = await window.BiomassAPI.getCompaniesDetailed();
        return sxCompanies;
    }

    async function sxDetailClick(e) {
        const b = e.target.closest('button[data-act]'); if (!b || !sxDetail) return;
        const d = sxDetail, t = d.truck, l = d.lab1 || {}, act = b.dataset.act;
        const sample = { sample1_barcode_id: t.sample1_barcode_id, truck_reg_number: t.truck_reg_number, mixing_code: t.daily_group_code, entry_date: t.entry_date, truck_id: t.truck_id,
            kind: 'TRUCK_SAMPLE', moisture_pct: l.moisture_pct, fineness_value: l.fineness_value, fineness_initial_weight: l.fineness_initial_weight, fineness_final_weight: l.fineness_final_weight };
        if (act === 'edit-reg') return superEditRegistration(d);
        if (act === 'feed-lab1') return superEditLab1(sample);
        if (act === 'print-qr') return superPrintSample(sample);
        if (act === 'png-qr') return superDownloadSample(sample);
        if (act === 'photo') {
            try { const src = await window.BiomassAPI.getEvidencePhoto(b.dataset.kind, b.dataset.id); sxShowPhoto(src); } catch (err) { alert(err.message); }
            return;
        }
        if (act === 'ovr') {
            const st = b.dataset.st;
            return openSuperEdit('Accept / reject override', `Truck <b>${esc(t.truck_reg_number)}</b> (moisture ${l.moisture_pct != null ? esc(l.moisture_pct) + ' %' : 'not entered'}). New decision: <b>${st === 'NONE' ? 'back to the moisture rule' : esc(st)}</b>. The group's composite must not exist yet. Recorded in the audit log.`, [],
                async (v, why) => { await window.BiomassAPI.superOverride({ truck_id: t.truck_id, status: st, reason: why }); }, { saveLabel: 'Apply decision' });
        }
        if (act === 'replace-qr') {
            return openSuperEdit('Replace the sample QR', `Truck <b>${esc(t.truck_reg_number)}</b>, current code <span style="font-family:monospace;">${esc(t.sample1_barcode_id)}</span>. A <b>new</b> QR code is issued for the same sample; the old code stops working; the moisture / fineness results and the mixing scan follow the new code. The new label is printed straight away.`, [],
                async (v, why) => {
                    const r = await window.BiomassAPI.superReplaceQr({ barcode: t.sample1_barcode_id, reason: why });
                    alert(`New QR: ${r.sample1_barcode_id}\n(old code ${r.old_barcode} no longer works)`);
                    window.printSampleLabel(r.sample1_barcode_id, r.entry_date);
                }, { saveLabel: 'Issue new QR' });
        }
        if (act === 'bottom') {
            const a = b.dataset.b, txt = { REQUEST: 'Request a bottom sample now (no password needed). The Entry login then generates the label.', CANCEL_REQUEST: 'Cancel the pending bottom-sample request.', UNDO: 'Undo the generated bottom sample: its QR becomes void and the original sample is part of its mixture again.' }[a];
            return openSuperEdit('Bottom sample', `Truck <b>${esc(t.truck_reg_number)}</b>. ${txt}`, [], async (v, why) => { await window.BiomassAPI.superBottom({ truck_id: t.truck_id, action: a, reason: why }); }, { saveLabel: 'Do it' });
        }
        if (act === 'cancel') {
            return openSuperEdit('Cancel the QR', `Truck <b>${esc(t.truck_reg_number)}</b> will be shown as "QR cancelled" with the reason below in every report; its sample is left out of the mixture and never blocks the composite.`, [], async (v, why) => { await window.BiomassAPI.superCancelQr({ truck_id: t.truck_id, reason: why }); }, { saveLabel: 'Cancel the QR' });
        }
        if (act === 'void') {
            return openSuperEdit('Void this registration', `Truck <b>${esc(t.truck_reg_number)}</b> (${esc(t.company_name)}) was registered by mistake. It disappears from every list and report. Nothing is deleted - it can be restored here.`, [], async (v, why) => { await window.BiomassAPI.superVoidTruck({ truck_id: t.truck_id, reason: why }); }, { saveLabel: 'Void it' });
        }
        if (act === 'restore') {
            return openSuperEdit('Restore this truck', `Truck <b>${esc(t.truck_reg_number)}</b> (${esc(t.cancel_status)}: ${esc(t.cancel_reason || '')}) becomes an ordinary truck again.`, [], async (v, why) => { await window.BiomassAPI.superRestoreTruck({ truck_id: t.truck_id, reason: why }); }, { saveLabel: 'Restore', danger: false });
        }
        if (act === 'comp-void') {
            const c = (d.composites || []).find(x => x.composite_ref_id === b.dataset.ref);
            return superVoidComposite({ composite_ref_id: b.dataset.ref, mixing_code: c ? c.daily_group_code : '', date: c ? c.date : '' });
        }
    }

    // Tool 2: registration details. Vehicle / driver / invoice never regroup. Changing the Lot / vendor / date regroups the truck automatically; or the mixing code can be chosen by hand
    // (one of the vendor's other codes of that day - the truck takes over its lot and PO, and its Fineness scan goes along).
    async function superEditRegistration(d) {
        const t = d.truck;
        let comps, codes = {};
        try {
            comps = await window.BiomassAPI.getCompaniesAll();
            const fr = await window.BiomassAPI.superFind('', t.entry_date, t.entry_date);
            const nv = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
            (fr.samples || []).filter(x => x.kind === 'TRUCK_SAMPLE' && !x.cancel_status && nv(x.company_name) === nv(t.company_name) && x.mixing_code !== t.daily_group_code)
                .forEach(x => { const c = codes[x.mixing_code] || (codes[x.mixing_code] = { lot: x.lot, po: x.po_number, n: 0 }); c.n++; });
        } catch (e) { alert(e.message); return; }
        const cur = comps.findIndex(c => c.name === t.company_name && c.lot === t.lot);
        const vendorOpts = (lot) => comps.map((c, i) => ({ c, i })).filter(x => x.c.lot === lot && (x.c.active || x.i === cur))
            .map(x => ({ v: x.i, l: `${x.c.name}${x.c.po_number ? ' - PO ' + x.c.po_number : ''}${x.c.active ? '' : ' (retired - this truck\'s present entry)'}` }));
        const codeOpts = [{ v: '', l: `Keep the present mixing code (${t.daily_group_code}) - automatic` }].concat(Object.entries(codes).map(([k, c]) =>
            ({ v: k, l: `${k} - ${c.lot}, ${c.n} truck(s) of this vendor today, PO ${c.po || '-'}` })));
        openSuperEdit('Edit registration details', `Truck <b>${esc(t.truck_reg_number)}</b> &bull; mixing code <b>${esc(t.daily_group_code)}</b> &bull; ${esc(t.lot)}.<br>Vehicle number, driver and invoice can be corrected freely - the mixing group stays. <b>Changing the Lot / vendor / date</b> moves the truck to the mixing group of that vendor (the container must be scanned again). Or <b>choose the mixing code yourself</b> below: the truck joins that code with its Lot and PO and <b>keeps its scan</b>. Not possible while a composite exists for the old or the new code.`, [
            { id: 'truck_reg_number', label: 'Vehicle number', value: t.truck_reg_number, type: 'text' },
            { id: 'driver_name', label: 'Driver name', value: t.driver_name, type: 'text' },
            { id: 'invoice_no', label: 'Invoice / challan number', value: t.invoice_no || t.challan_no, type: 'text' },
            { id: 'code', label: 'Mixing code (join another code of this vendor today)', value: '', type: 'select', options: codeOpts, hint: Object.keys(codes).length ? '' : '(this vendor has no other code today)' },
            { id: 'lot', label: 'Lot (changes the mixing group)', value: t.lot, type: 'select', options: (t.lot === 'LOT2/3' ? [{ v: 'LOT2/3', l: 'Lot 2/3 (old)' }] : []).concat([{ v: 'LOT2', l: 'Lot 2' }, { v: 'LOT3', l: 'Lot 3' }, { v: 'LOT4', l: 'Lot 4' }]) },
            { id: 'vendor', label: 'Vendor entry of that lot', value: cur, type: 'select', options: vendorOpts(t.lot) },
            { id: 'entry_date', label: 'Entry date', value: t.entry_date, type: 'date' }
        ], async (v, why) => {
            const p = { truck_id: t.truck_id, reason: why };
            if (v.truck_reg_number && v.truck_reg_number !== t.truck_reg_number) p.truck_reg_number = v.truck_reg_number;
            if (v.driver_name && v.driver_name !== (t.driver_name || '')) p.driver_name = v.driver_name;
            if (v.invoice_no && v.invoice_no !== (t.invoice_no || '')) p.invoice_no = v.invoice_no;
            if (v.code) {                                                    // join another mixing code
                const pv = await window.BiomassAPI.superMergeGroup({ date: t.entry_date, from_code: t.daily_group_code, to_code: v.code, truck_id: t.truck_id, dry_run: 'true' });
                let keep = false;
                if (pv.turning_accepted > 0) keep = confirm('This truck was REJECTED under the Lot-3 rule and the new code is Lot 4.\n\nOK = keep it REJECTED\nCancel = it counts as ACCEPTED (Lot-4 rule: never rejected for moisture)');
                if (Object.keys(p).length > 2) await window.BiomassAPI.superEditTruck(p);
                const r = await window.BiomassAPI.superMergeGroup({ date: t.entry_date, from_code: t.daily_group_code, to_code: v.code, truck_id: t.truck_id, keep_rejected: keep ? 'true' : 'false', reason: why });
                alert(`The truck is now in mixing code ${r.to_code} (${r.target_lot}, PO ${r.target_po || '-'}).\nThat code now has ${r.target_after.accepted_total} accepted sample(s), ${r.target_after.accepted_scanned} of them scanned.`);
                return;
            }
            const c = comps[Number(v.vendor)];
            if (c && (c.name !== t.company_name || c.lot !== t.lot)) { p.company_name = c.name; p.lot = c.lot; }
            if (v.entry_date && v.entry_date !== t.entry_date) p.entry_date = v.entry_date;
            if (Object.keys(p).length === 2) throw new Error('Nothing was changed.');
            const res = await window.BiomassAPI.superEditTruck(p);
            alert(res.regrouped ? `Saved. The truck moved to mixing code ${res.daily_group_code}. It must be scanned again in the Fineness login for that group.` : 'Saved and recorded. The mixing group is unchanged.');
        }, { onRender: (box) => {
            const lotSel = box.querySelector('#se-lot'), venSel = box.querySelector('#se-vendor'), codeSel = box.querySelector('#se-code'), dateIn = box.querySelector('#se-entry_date');
            lotSel.onchange = () => {                                      // vendor list follows the Lot; the same vendor is preselected
                const o = vendorOpts(lotSel.value), same = o.find(x => comps[x.v].name === t.company_name);
                venSel.innerHTML = o.map(x => `<option value="${x.v}">${esc(x.l)}</option>`).join('');
                if (same) venSel.value = String(same.v);
            };
            const lockOthers = () => { const on = !!codeSel.value; [lotSel, venSel, dateIn].forEach(x => { x.disabled = on; x.style.opacity = on ? 0.45 : 1; }); };
            codeSel.onchange = lockOthers; lockOthers();
        } });
    }

    // Tool 12: combine two mixing codes of the same vendor and day (all trucks of one code move into the other; scans go along)
    async function superMergeDialog(date, from, to) {
        let pv;
        try { pv = await window.BiomassAPI.superMergeGroup({ date, from_code: from, to_code: to, dry_run: 'true' }); } catch (e) { alert(e.message); return; }
        const bf = pv.target_before || {};
        openSuperEdit(`Combine mixing code ${pv.from_code} into ${pv.to_code}`,
            `On <b>${esc(dmy(pv.date))}</b>: <b>${esc(pv.moved)}</b> truck(s) of code <b>${esc(pv.from_code)}</b> (${esc(pv.moved_scanned)} already scanned in the Fineness login) move into code <b>${esc(pv.to_code)}</b> of ${esc(pv.target_name)}.<br>` +
            `They take over <b>${esc(pv.target_lot)}</b> and the PO <b>${esc(pv.target_po || '-')}</b>. Their scans go along - nothing has to be scanned again.<br>` +
            `Code ${esc(pv.to_code)} now has ${esc(bf.accepted_total)} accepted sample(s) (${esc(bf.accepted_scanned)} scanned); afterwards <b>${esc(pv.target_after.accepted_total)}</b> accepted, <b>${esc(pv.target_after.accepted_scanned)}</b> scanned.` +
            (pv.turning_accepted ? `<br><b>${esc(pv.turning_accepted)}</b> truck(s) were rejected under the Lot-3 rule - choose below what happens to them.` : ''),
            pv.turning_accepted ? [{ id: 'keep', label: 'Trucks rejected under the Lot-3 rule', type: 'select', value: 'keep', options: [{ v: 'keep', l: 'Keep them REJECTED' }, { v: 'accept', l: 'They count as ACCEPTED (Lot 4 never rejects for moisture)' }] }] : [],
            async (v, why) => {
                const r = await window.BiomassAPI.superMergeGroup({ date, from_code: from, to_code: to, keep_rejected: v.keep === 'keep' ? 'true' : 'false', reason: why });
                alert(`Done. Mixing code ${r.to_code} now has ${r.target_after.accepted_total} accepted sample(s), ${r.target_after.accepted_scanned} of them scanned. Lab 2 can create the composite when all are scanned.`);
            }, { saveLabel: 'Combine the codes' });
    }

    function sxShowPhoto(src) {
        if (!src) { alert('There is no picture.'); return; }
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed; inset:0; z-index:99994; background:rgba(0,0,0,0.92); display:flex; align-items:center; justify-content:center; padding:1rem; cursor:zoom-out;';
        o.innerHTML = `<img src="${esc(src)}" style="max-width:100%; max-height:100%; border-radius:8px;">`;
        o.onclick = () => o.remove();
        document.body.appendChild(o);
    }

    // ---------- Toolbox: what the 10 tools are for ----------
    const SX_TOOLS = [
        { n: 1, icon: '⚡', title: 'Force-create a composite',
          use: 'The Fineness technician forgot to scan one container, or a scan was lost, and the whole group is stuck although the mixture is physically ready.',
          how: ['Type the mixing code and pick the date below.', 'Press <b>Force-create…</b>, type a reason and confirm with your password.', 'The composite is made from all ACCEPTED trucks; the 3 labels can be printed at once.'],
          note: 'Only the "every accepted container scanned" rule is skipped. Pending moisture results and rejected trucks are still respected.', kind: 'force' },
        { n: 2, icon: '✏️', title: 'Edit registration details',
          use: 'The gate operator typed the wrong vehicle number, driver name or invoice, or chose the wrong vendor.',
          how: ['Find the truck (vehicle number, mixing code or QR).', 'In the truck window press <b>Edit registration details</b>.', 'Vehicle / driver / invoice: nothing else changes. <b>Vendor or date</b>: the truck moves to that vendor\'s mixing group (created if needed).'],
          note: 'Not possible while the old or the new group already has a composite - void it first (tool 5).', kind: 'find' },
        { n: 3, icon: '🗑', title: 'Void a wrong truck registration',
          use: 'A truck was registered twice or by mistake and never came. It must disappear from every list and report but must not be deleted.',
          how: ['Find the truck.', 'In the truck window press <b>Void this registration</b>.', 'It can be restored from the same window.'],
          note: 'Different from "Cancel QR": a cancelled QR stays in the reports with its reason; a voided truck is hidden.', kind: 'find' },
        { n: 4, icon: '🔁', title: 'Replace a lost or damaged QR',
          use: 'The sticker was lost, soaked or torn, and the sample can no longer be scanned.',
          how: ['Find the truck (or paste the old QR code).', 'Press <b>Replace lost / damaged QR</b>.', 'A new label prints; the old code stops working; moisture / fineness and scan follow the new code.'],
          note: 'The old code is kept in the history shown in the truck window.', kind: 'find' },
        { n: 5, icon: '🗑', title: 'Void a composite / move a truck',
          use: 'A composite was made too early, with the wrong trucks, or a truck has to move to another group.',
          how: ['Type the composite code (CMP-…) below and press <b>Void…</b>, or use <b>Void</b> on its card.', 'The record is archived (nothing is lost) and the group can be mixed again.', 'To move a truck: void the composite, then change the truck\'s vendor / date (tool 2).'],
          note: 'Labels already printed for the voided composite stop working.', kind: 'void-comp' },
        { n: 6, icon: '🧪', title: 'Bottom-sample controls without the password',
          use: 'A bottom sample has to be requested, cancelled or undone but the unloading password is not at hand.',
          how: ['Find the truck.', 'In the <b>Bottom sample</b> section press Request / Cancel the request / Undo.'],
          note: 'Undo returns the original sample to its mixture (if the composite is not made yet).', kind: 'find' },
        { n: 7, icon: '⚖️', title: 'Accept / reject override',
          use: 'A documented exception: a truck just above the moisture limit is accepted by management, or a truck below the limit is rejected for another reason.',
          how: ['Find the truck.', 'In <b>Accept / reject decision</b> press Force ACCEPT / Force REJECT.', 'Use "Back to the moisture rule" to remove the override.'],
          note: 'Marked with an OVERRIDE badge everywhere and recorded with your reason.', kind: 'find' },
        { n: 8, icon: '🔑', title: 'Reset / unlock / disable logins',
          use: 'A worker is locked out by wrong passwords, a phone was lost, or someone left the company.',
          how: ['Open the <b>Logins</b> tab.', 'Unlock a locked login, or Disable / Enable one.'],
          note: 'The last active Admin and the Super Admin itself cannot be disabled. Passwords are changed in Supabase → Authentication.', kind: 'logins' },
        { n: 9, icon: '🩺', title: 'Data-health check',
          use: 'A routine look every morning: groups waiting for results, trucks that never left, composites without results, broken links.',
          how: ['Open the <b>Data health</b> tab and press Run the check.', 'Each finding explains itself; <b>Open</b> jumps to the records, <b>Fix</b> repairs harmless leftovers.'],
          note: 'Nothing changes unless you press Fix.', kind: 'health' },
        { n: 12, icon: '🧩', title: 'Combine two mixing codes of the same vendor and day',
          use: 'The same vendor, day, lot and PO ended up with two mixing codes (for example a Lot-3 code and a Lot-4 code), and no composite has been made yet. They must be ONE mixing code.',
          how: ['Type the date, the code that goes away (FROM) and the code that stays (TO).', 'Press <b>Preview…</b>: you see how many trucks move and how many accepted / scanned samples the code will have afterwards.', 'Confirm with a reason: the trucks take the Lot and PO of the TO code and <b>keep their Fineness scans</b>. In Lab 2 you then see one code with all samples scanned.', 'To move just ONE truck, use Inspector &rarr; Open truck &rarr; Edit registration &rarr; Mixing code.'],
          note: 'Refused when a composite exists for either code (void it first, tool 5) or when the codes belong to different vendors.', kind: 'merge' },
        { n: 11, icon: '🔁', title: 'Convert a vendor\'s existing samples to Lot 4 (in place)',
          use: 'A vendor already has samples, mixing codes and composites under Lot 2/3 but is to be treated as Lot 4 (it finished its Lot-3 quantity). Re-booking everything would create havoc; this changes only the lot.',
          how: ['Type the vendor (it needs an active LOT4 entry in Admin > Vendors). Optionally limit it to a date range.', 'Press <b>Preview…</b>: you see how many trucks, mixing codes and composites are affected - nothing is changed yet.', 'Confirm with a reason: trucks, mixing codes, scans, composites and labels stay exactly as they are; only the lot becomes LOT4.', 'Composites <b>not yet tested</b>: Lab 2 now also asks for sulphur and VM. Composites <b>already tested</b>: Inspector &rarr; Edit AD values (the old values are pre-filled) &rarr; add AD sulphur and VM; GCV / ash stay the same.'],
          note: 'A truck that was rejected under the Lot-3 rule stays rejected. The PO of the trucks is kept unless you choose to switch it. Refused when the vendor has both a Lot-3 and a LOT4 mixing code on the same day.', kind: 'convert' },
        { n: 10, icon: '🛡️', title: 'Protection of this console',
          use: 'The Super Admin can change almost anything, so the console protects itself.',
          how: ['<b>Idle sign-out</b>: after 10 minutes without activity you are signed out.', '<b>Password re-check</b>: the first change (and then every 5 minutes) asks for your password again.', '<b>Alerts</b>: the Admin sees a red badge on the Activity Log until the Super Admin changes are acknowledged.', '<b>Export</b>: the full audit log can be downloaded as Excel.'],
          note: 'Every line carries the IP address and device from which it was done.', kind: 'protect' }
    ];
    function renderSuperTools() {
        const box = sx$('sx-tools-grid');
        if (box.dataset.done) return;
        box.dataset.done = '1';
        const today = window.BiomassAPI.todayIST();
        box.innerHTML = SX_TOOLS.slice().sort((a, b) => a.n - b.n).map(t => {
            let act = '';
            if (t.kind === 'force') act = `<input id="sxt-force-code" placeholder="Mixing code" maxlength="12" style="text-transform:uppercase; max-width:130px;"><input type="date" id="sxt-force-date" value="${today}" style="max-width:160px;"><button class="btn btn-primary btn-sm" data-tool="force">⚡ Force-create…</button>`;
            else if (t.kind === 'find') act = `<input id="sxt-find-${t.n}" placeholder="Vehicle no., QR or mixing code"><button class="btn btn-primary btn-sm" data-tool="find" data-n="${t.n}">🔍 Find the truck</button>`;
            else if (t.kind === 'void-comp') act = `<input id="sxt-void-code" placeholder="Composite code, e.g. CMP-20261021-001"><button class="btn btn-primary btn-sm" data-tool="void-comp">🗑 Void…</button>`;
            else if (t.kind === 'merge') act = `<input type="date" id="sxt-mg-date" value="${today}" style="max-width:150px; flex:0 0 auto;"><input id="sxt-mg-from" placeholder="FROM code, e.g. MRQ" maxlength="12" style="text-transform:uppercase; max-width:150px;"><input id="sxt-mg-to" placeholder="TO code, e.g. NRB" maxlength="12" style="text-transform:uppercase; max-width:150px;"><button class="btn btn-primary btn-sm" data-tool="merge">🧩 Preview…</button>`;
            else if (t.kind === 'convert') act = `<input id="sxt-conv-name" list="sxt-conv-list" placeholder="Vendor, e.g. KARNI TRADING COMPANY"><datalist id="sxt-conv-list"></datalist><input type="date" id="sxt-conv-from" title="From (optional)" style="max-width:150px; flex:0 0 auto;"><input type="date" id="sxt-conv-to" title="To (optional)" style="max-width:150px; flex:0 0 auto;"><label style="font-size:0.78rem; color:#cbd5e1; display:flex; gap:0.35rem; align-items:center; flex-basis:100%;"><input type="checkbox" id="sxt-conv-both" style="flex:0 0 auto; min-width:0;"> If the vendor already has a LOT4 mixing code that day, keep BOTH codes (the Lot-3 code stays as it is)</label><button class="btn btn-primary btn-sm" data-tool="convert">🔁 Preview…</button>`;
            else if (t.kind === 'logins') act = `<button class="btn btn-primary btn-sm" data-tool="goto" data-tab="super-logins">👥 Open Logins</button>`;
            else if (t.kind === 'health') act = `<button class="btn btn-primary btn-sm" data-tool="goto" data-tab="super-health">🩺 Open Data health</button>`;
            else act = `<button class="btn btn-secondary btn-sm" data-tool="goto" data-tab="admin-activity">📜 Open the Audit log</button><button class="btn btn-secondary btn-sm" data-tool="export">⬇ Export audit log (Excel)</button>`;
            return `<div class="sx-tool" data-n="${t.n}"><span class="sx-tool-n">${t.n}</span><h4>${t.icon} ${t.title}</h4>
                <div class="lbl">Useful when</div><p>${t.use}</p>
                <div class="lbl">How to use</div><ol>${t.how.map(h => `<li>${h}</li>`).join('')}</ol>
                <p style="font-size:0.76rem; color:#94a3b8;">${t.note}</p>
                <div class="sx-tool-act">${act}</div></div>`;
        }).join('');
        // the vertical menu: one tool at a time (typed values are kept while you switch)
        const groups = [['Fix a truck', [2, 3, 4, 6, 7]], ['Mixing & composites', [1, 5, 12, 11]], ['The console itself', [8, 9, 10]]];
        const nav = sx$('sx-tools-nav'), cards = [...box.querySelectorAll('.sx-tool')];
        const showTool = (n) => {
            cards.forEach(c => c.classList.toggle('active', c.dataset.n === String(n)));
            nav.querySelectorAll('button[data-tool-n]').forEach(b => b.classList.toggle('active', b.dataset.toolN === String(n)));
        };
        nav.innerHTML = groups.map(([g, ns]) => `<div class="sec-navhead">${esc(g)}</div>` + ns.map(n => { const t = SX_TOOLS.find(x => x.n === n); return `<button type="button" data-tool-n="${n}"><span><span class="sec-n">${n}</span>${t.icon} ${esc(t.title)}</span></button>`; }).join('')).join('');
        nav.onclick = (e) => { const b = e.target.closest('button[data-tool-n]'); if (b) showTool(b.dataset.toolN); };
        showTool(1);
        sxLoadCompanies().then(cs => { const dl = sx$('sxt-conv-list'); if (dl) dl.innerHTML = [...new Set(cs.filter(c => c.lot === 'LOT4').map(c => c.name))].map(n => `<option value="${esc(n)}">`).join(''); }).catch(() => { });
        box.onclick = async (e) => {
            const b = e.target.closest('button[data-tool]'); if (!b) return;
            const k = b.dataset.tool;
            if (k === 'goto') { sxGoTab(b.dataset.tab); return; }
            if (k === 'export') { exportAuditLog(false); return; }
            if (k === 'merge') {
                const date = sx$('sxt-mg-date').value, f = sx$('sxt-mg-from').value.trim().toUpperCase(), to = sx$('sxt-mg-to').value.trim().toUpperCase();
                if (!date || !f || !to) { alert('Pick the date and type both mixing codes.'); return; }
                superMergeDialog(date, f, to); return;
            }
            if (k === 'convert') {
                const name = sx$('sxt-conv-name').value.trim(), from = sx$('sxt-conv-from').value, to = sx$('sxt-conv-to').value;
                if (!name) { alert('Type the vendor first.'); return; }
                try {
                    const base = { company_name: name, from: from || null, to: to || null, keep_both: sx$('sxt-conv-both').checked ? 'true' : 'false' };
                    const pv = await window.BiomassAPI.superConvertLot(Object.assign({ dry_run: 'true' }, base));
                    openSuperEdit('Convert to Lot 4: ' + pv.company_name,
                        `<b>${esc(pv.trucks)}</b> truck(s) (+ ${esc(pv.bottom_samples)} bottom sample(s)) in <b>${esc(pv.groups)}</b> mixing code(s) and <b>${esc(pv.composites_to_test + pv.composites_tested)}</b> composite(s) ` +
                        `(${esc(pv.composites_to_test)} still to be tested, ${esc(pv.composites_tested)} already tested) will become <b>LOT4</b> - ${from || to ? 'in the chosen period' : 'all dates'}.<br>` +
                        `Mixing codes, scans, composites and labels stay exactly the same. ${pv.kept_rejected ? `<b>${esc(pv.kept_rejected)}</b> truck(s) rejected under the Lot-3 rule stay rejected. ` : ''}` +
                        `${(pv.both_codes_days || []).length ? `<b>On ${esc(pv.both_codes_days.map(d => dmy(d)).join(', '))} the vendor already has a LOT4 mixing code: both codes stay (the Lot-3 code keeps its number, both are Lot 4).</b> ` : ''}${pv.composites_tested ? 'For the already tested composite(s) add sulphur and VM afterwards in the Inspector (Edit AD values). ' : ''}${pv.composites_to_test ? 'Lab 2 will ask for sulphur and VM on the untested composite(s).' : ''}`,
                        [{ id: 'switch_po', label: 'PO number of these trucks', type: 'select', value: 'keep', options: [{ v: 'keep', l: 'Keep the PO each truck already has' }, { v: 'switch', l: 'Switch to the Lot-4 PO (' + (pv.lot4_po || 'none') + ')' }] }],
                        async (v, why) => {
                            const r = await window.BiomassAPI.superConvertLot(Object.assign({ switch_po: v.switch_po === 'switch' ? 'true' : 'false', reason: why }, base));
                            alert(`Done: ${r.trucks} truck(s), ${r.groups} mixing code(s) and ${r.composites_to_test + r.composites_tested} composite(s) are Lot 4 now.`);
                        }, { saveLabel: 'Convert to Lot 4' });
                } catch (err) { alert(err.message); }
                return;
            }
            if (k === 'force') {
                const code = sx$('sxt-force-code').value.trim().toUpperCase(), date = sx$('sxt-force-date').value;
                if (!code || !date) { alert('Type the mixing code and pick the date.'); return; }
                superForceComposite(code, date); return;
            }
            if (k === 'void-comp') {
                const code = sx$('sxt-void-code').value.trim();
                if (!code) { alert('Type the composite code.'); return; }
                try {
                    const res = await window.BiomassAPI.superFind(code, null, null);
                    const c = (res.composites || [])[0];
                    if (!c) { alert('No composite found for "' + code + '".'); return; }
                    superVoidComposite(c);
                } catch (err) { alert(err.message); }
                return;
            }
            if (k === 'find') {
                const q = sx$('sxt-find-' + b.dataset.n).value.trim();
                if (!q) { alert('Type the vehicle number, QR code or mixing code.'); return; }
                sxQuickFind(q);
            }
        };
    }
    function sxGoTab(tab) {
        const btn = document.querySelector(`#screen-admin .tab-btn[data-tab="${tab}"]`);
        if (btn) btn.click();
    }
    // open one truck directly when the search finds exactly one; otherwise show the matches in the Inspector
    async function sxQuickFind(q) {
        try {
            const res = await window.BiomassAPI.superFind(q, null, null);
            const trucks = (res.samples || []).filter(r => !r.cancel_status || r.cancel_status);
            const ids = [...new Set(trucks.map(r => r.truck_id))];
            if (ids.length === 1) { sxGoTab('super-inspector'); sx$('super-q').value = q; openTruckDetail(ids[0]); superSearch(); return; }
            sxGoTab('super-inspector');
            sx$('super-q').value = q;
            superSearch();
            if (!ids.length) alert('Nothing found for "' + q + '".');
        } catch (err) { alert(err.message); }
    }

    // ---------- Data health ----------
    // The vertical menu lists the findings of the last check (Overview first); one finding is shown at a time.
    const sxHealth = { res: null, sel: 'overview' };
    async function renderSuperHealth() {
        const box = sx$('sx-health-body'), nav = sx$('sx-health-nav');
        box.innerHTML = '<div class="sx-loading">Checking...</div>'; nav.innerHTML = '';
        try {
            sxHealth.res = await window.BiomassAPI.superHealth();
            nav.onclick = (e) => { const b = e.target.closest('button[data-hk]'); if (b) { sxHealth.sel = b.dataset.hk; sxHealthShow(); } };
            box.onclick = (e) => {
                const g = e.target.closest('[data-hk-go]'); if (g) { sxHealth.sel = g.dataset.hkGo; sxHealthShow(); return; }
                const o = e.target.closest('button[data-open]');
                if (o) { sxGoTab('super-inspector'); sx$('super-q').value = o.dataset.open; sx$('super-from').value = o.dataset.date; sx$('super-to').value = o.dataset.date; superSearch(); return; }
                const f = e.target.closest('button[data-fix]');
                if (f) openSuperEdit('Fix: ' + f.dataset.fix, 'Repairs the harmless leftovers listed in this finding. Recorded in the audit log.', [], async (v, why) => {
                    const r = await window.BiomassAPI.superHealthFix({ fix: f.dataset.fix, reason: why });
                    alert(`${r.fixed} record(s) fixed.`);
                }, { saveLabel: 'Fix it', after: renderSuperHealth });
            };
            sxHealthShow();
        } catch (e) {
            box.innerHTML = `<div style="color:#ef4444;">${esc(e.message)}</div>`;
        }
    }
    function sxHealthShow() {
        const res = sxHealth.res, box = sx$('sx-health-body'), nav = sx$('sx-health-nav'), issues = res.issues || [];
        if (sxHealth.sel !== 'overview' && !issues[Number(sxHealth.sel)]) sxHealth.sel = 'overview';
        const sel = sxHealth.sel;
        nav.innerHTML = `<button type="button" data-hk="overview" class="${sel === 'overview' ? 'active' : ''}"><span>&#128202; Overview</span><small>${issues.length ? issues.length + ' finding(s)' : 'all clear'}</small></button>` +
            issues.map((is, k) => `<button type="button" data-hk="${k}" class="${String(k) === sel ? 'active' : ''}"><span>${is.severity === 'INFO' ? '&#8505;&#65039;' : '&#9888;&#65039;'} ${esc(is.title)}</span><small>${(is.items || []).length} item(s)</small></button>`).join('');
        if (sel === 'overview') {
            box.innerHTML = !issues.length ? `<div class="sx-ok-banner">✅ Nothing to worry about. Checked ${esc(res.checked_at || '')}.</div>` :
                `<div class="sx-note" style="margin-bottom:0.6rem;">${issues.length} finding(s) &middot; checked ${esc(res.checked_at || '')} &middot; pick one on the left, or click it here</div>` +
                issues.map((is, k) => `<div class="sx-issue ${is.severity === 'INFO' ? 'info' : ''}" data-hk-go="${k}" style="cursor:pointer;"><h4>${is.severity === 'INFO' ? 'ℹ️' : '⚠️'} ${esc(is.title)} <span class="sx-pill sx-pen">${(is.items || []).length}</span></h4><div class="sx-note" style="margin:0;">${esc(is.help || '')}</div></div>`).join('');
            return;
        }
        const is = issues[Number(sel)], k = Number(sel);
        box.innerHTML = `<div class="sx-note" style="margin-bottom:0.6rem;">checked ${esc(res.checked_at || '')}</div><div class="sx-issue ${is.severity === 'INFO' ? 'info' : ''}">
            <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap;"><h4>${is.severity === 'INFO' ? 'ℹ️' : '⚠️'} ${esc(is.title)} <span class="sx-pill sx-pen">${(is.items || []).length}</span></h4>
                ${is.fix ? `<button class="btn btn-primary btn-sm" data-fix="${esc(is.fix)}" data-k="${k}">🛠 Fix</button>` : ''}</div>
            <div class="sx-note" style="margin:0 0 0.4rem;">${esc(is.help || '')}</div>
            ${(is.items || []).slice(0, 40).map(it => `<div class="sx-item"><span>${it.date ? esc(dmy(it.date)) + ' &middot; ' : ''}${it.code ? `<span class="sx-code">${esc(it.code)}</span> ` : ''}${esc(it.detail)}</span>
                <button class="btn btn-secondary btn-sm" data-open="${esc(it.code || String(it.detail).split(' ')[0])}" data-date="${esc(it.date || '')}">🔍 Open</button></div>`).join('')}
            ${(is.items || []).length > 40 ? `<div class="sx-note">… and ${(is.items || []).length - 40} more</div>` : ''}
        </div>`;
    }

    // ---------- Logins ----------
    async function renderSuperLogins() {
        const body = sx$('sx-logins-body');
        body.innerHTML = '<tr><td colspan="5" class="sx-loading">Loading...</td></tr>';
        try {
            const res = await window.BiomassAPI.superLogins();
            const L = res.logins || [];
            body.innerHTML = L.map((u, i) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.name || '')}</td><td>${esc(u.role)}</td>
                <td>${u.active ? '<span class="sx-pill sx-ok">ACTIVE</span>' : '<span class="sx-pill sx-rej">DISABLED</span>'} ${u.locked ? '<span class="sx-pill sx-pen">🔒 LOCKED (wrong passwords)</span>' : ''}</td>
                <td>${u.locked ? `<button class="btn btn-secondary btn-sm" data-a="UNLOCK" data-i="${i}">🔓 Unlock</button>` : ''}
                    ${u.role === 'superadmin' ? '' : (u.active ? `<button class="btn btn-secondary btn-sm sx-danger" data-a="DISABLE" data-i="${i}">⛔ Disable</button>` : `<button class="btn btn-secondary btn-sm" data-a="ENABLE" data-i="${i}">✅ Enable</button>`)}</td></tr>`).join('');
            body.onclick = (e) => {
                const b = e.target.closest('button[data-a]'); if (!b) return;
                const u = L[Number(b.dataset.i)], a = b.dataset.a;
                openSuperEdit({ UNLOCK: 'Unlock login', DISABLE: 'Disable login', ENABLE: 'Enable login' }[a] + ': ' + u.username,
                    { UNLOCK: 'Clears the wrong-password lock so this login can use its password-protected actions again.', DISABLE: 'This login can no longer use any function of the app until it is enabled again.', ENABLE: 'This login can use the app again.' }[a],
                    [], async (v, why) => { await window.BiomassAPI.superSetLogin({ username: u.username, action: a, reason: why }); }, { saveLabel: 'Confirm', after: renderSuperLogins });
            };
        } catch (e) {
            body.innerHTML = `<tr><td colspan="5" style="color:#ef4444;">${esc(e.message)}</td></tr>`;
        }
    }

    // ---------- Passwords (Super Admin): the unloading actions password ----------
    async function renderSuperPasswords() {
        const box = sx$('sx-pw-status');
        try {
            const st = await window.BiomassAPI.superActionPasswordStatus();
            box.innerHTML = (st.password_set ? '\u2705 A password is set' + (st.changed_at ? ' (last changed ' + esc(String(st.changed_at).replace('T', ' ').slice(0, 16)) + ' UTC)' : '') + '.' : '\u26A0\uFE0F <strong>No password is set yet</strong> - the Unloading team cannot request bottom samples, cancel QRs or download the report.') +
                ` Bottom-sample requests waiting: <strong>${st.pending_requests}</strong> &bull; generated so far: <strong>${st.generated}</strong>.`;
        } catch (e) { box.innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; }
    }
    function superSetActionPassword() {
        openSuperEdit('Set / change the unloading actions password',
            'Used by the Unloading team for <b>bottom-sample requests</b>, <b>Cancel QR</b> and the <b>daily report PDF</b>. Tell it only to the people who may do these things. Minimum 6 characters.',
            [{ id: 'pw1', label: 'New password', type: 'password' }, { id: 'pw2', label: 'Type it again', type: 'password' }],
            async (v, why) => {
                if (v.pw1.length < 6) throw new Error('Use at least 6 characters.');
                if (v.pw1 !== v.pw2) throw new Error('The two passwords are not the same.');
                await window.BiomassAPI.superSetActionPassword({ password: v.pw1, reason: why });
                alert('The unloading actions password was saved.');
            }, { saveLabel: 'Save password', danger: false, after: renderSuperPasswords });
    }

    // ---------- Security: second step (authenticator app) and trusted computers ----------
    const sxSec = { mfaRequired: false, lock: false, thisStatus: null, aal: 'aal1', pane: 'overview', sub: 'overview', mfa: null, dev: null };

    // The person's own authenticator-app card (Admin: Settings tab, Super Admin: Security tab)
    async function renderMfaBox(box) {
        if (!box) return;
        box.textContent = 'Loading...';
        try {
            const [factors, sec] = await Promise.all([window.BiomassAPI.mfaFactors(), window.BiomassAPI.mySecurity()]);
            const ok = factors.filter(f => f.status === 'verified');
            if (ok.length) {
                box.innerHTML = `<div>✅ <b>Set up</b> on this login (${esc(ok[0].friendly_name || 'authenticator app')}). ${sec.mfa_required ? 'The second step is <b>required</b> for the Admin logins.' : 'You are asked for the code every time you sign in.'}</div>` +
                    `<div style="margin-top:0.6rem;"><button type="button" class="btn btn-secondary btn-sm" id="mfa-remove-btn" style="border-color:#ef4444; color:#fca5a5;">Remove the authenticator app</button> <span id="mfa-msg" style="font-size:0.85rem;"></span></div>`;
                box.querySelector('#mfa-remove-btn').onclick = async () => {
                    const msg = box.querySelector('#mfa-msg');
                    if (sec.mfa_required) { msg.style.color = '#f59e0b'; msg.textContent = 'The second step is required, so it cannot be removed. The Super Admin must switch it off first.'; return; }
                    if (!confirm('Remove the authenticator app from this login? You will sign in with the password only.')) return;
                    try { await window.BiomassAPI.mfaRemove(ok[0].id); } catch (e) { msg.style.color = '#ef4444'; msg.textContent = e.message; return; }
                    renderMfaBox(box);
                };
                return;
            }
            box.innerHTML = '<div>⚠️ Not set up yet. Your log-in uses the password only.</div><div style="margin-top:0.6rem;"><button type="button" class="btn btn-primary" id="mfa-start-btn">Set up Google Authenticator</button></div><div id="mfa-setup" style="margin-top:0.9rem;"></div>';
            box.querySelector('#mfa-start-btn').onclick = async () => {
                const btn = box.querySelector('#mfa-start-btn'), setup = box.querySelector('#mfa-setup');
                btn.disabled = true; setup.textContent = 'Preparing...';
                try {
                    for (const f of factors.filter(x => x.status !== 'verified')) { try { await window.BiomassAPI.mfaRemove(f.id); } catch (e) { /* an old unfinished set-up */ } }
                    const en = await window.BiomassAPI.mfaEnroll('Authenticator ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
                    setup.innerHTML = '<ol style="padding-left:1.2rem; font-size:0.9rem; line-height:1.6;"><li>Install <b>Google Authenticator</b> on your phone (Play Store / App Store).</li><li>In the app press <b>+</b> and <b>Scan a QR code</b>, and scan this picture (or choose &ldquo;Enter a setup key&rdquo; and type the key below):' +
                        '<div style="margin:0.6rem 0;"><canvas id="mfa-qr" style="background:#fff; padding:6px; border-radius:6px;"></canvas></div><div style="font-family:monospace; word-break:break-all;">' + esc(en.totp.secret) + '</div></li>' +
                        '<li>Type the 6-digit code the app now shows:<div style="margin-top:0.4rem; display:flex; gap:0.5rem; flex-wrap:wrap;"><input type="text" id="mfa-code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="123456" style="padding:0.5rem; width:9rem; letter-spacing:0.2em; text-align:center;"><button type="button" class="btn btn-primary" id="mfa-confirm">Confirm</button></div><div id="mfa-setup-msg" style="margin-top:0.5rem; font-size:0.88rem;"></div></li></ol>';
                    QRCode.toCanvas(setup.querySelector('#mfa-qr'), en.totp.uri, { width: 200, margin: 1 }, () => { });
                    setup.querySelector('#mfa-confirm').onclick = async () => {
                        const m = setup.querySelector('#mfa-setup-msg'), code = setup.querySelector('#mfa-code').value;
                        if (!code.trim()) { m.style.color = '#ef4444'; m.textContent = 'Type the 6-digit code.'; return; }
                        try { await window.BiomassAPI.mfaConfirm(en.id, code); } catch (e) { m.style.color = '#ef4444'; m.textContent = 'That code is not correct or has expired. Wait for the next code and try again.'; return; }
                        alert('Done. From now on, sign in with your password and then the 6-digit code.');
                        renderMfaBox(box);
                        if (document.getElementById('tab-super-security') && document.getElementById('tab-super-security').classList.contains('active')) renderSuperSecurity();
                    };
                } catch (e) { setup.innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; btn.disabled = false; }
            };
        } catch (e) {
            if (e.code === 'session_not_found' || /session_id/i.test(e.message || '')) {
                // Supabase has ended this sign-in in the background (signed in elsewhere, signed out, or the session timed out); the app's own checks still pass until the access token runs out
                box.innerHTML = '<div style="color:#f59e0b;">This sign-in has been ended by the server (usually because the same login was used on another device, or it timed out).</div><div style="margin-top:0.6rem;"><button type="button" class="btn btn-primary btn-sm" id="mfa-resign">Sign out and sign in again</button></div>';
                box.querySelector('#mfa-resign').onclick = () => { window.BiomassAPI.logout(); routeSession(); };
                return;
            }
            box.innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`;
        }
    }

    async function renderSuperSecurity() {
        renderMfaBox(sx$('sx-mfa-mine'));
        try {
            sxSec.mfa = await window.BiomassAPI.superMfaOverview();
            sxSec.mfaRequired = !!sxSec.mfa.required; sxSec.aal = sxSec.mfa.aal;
            secRenderMfaPeople();
        } catch (e) { sxSec.mfa = null; sx$('sx-mfa-people').innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; }
        try {
            sxSec.dev = await window.BiomassAPI.deviceList();
            sxSec.lock = !!sxSec.dev.lock;
            const me = sxSec.dev.devices.find(x => x.this_device);
            sxSec.thisStatus = me ? me.status : null;
            secRenderDevices();
        } catch (e) { sxSec.dev = null; sx$('sx-dev-main').innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; }
        secRenderOverview();
        secShowPane(sxSec.pane);
    }

    // ---- the vertical feature tabs ----
    function secShowPane(p) {
        sxSec.pane = p;
        sx$('sx-sec-nav').querySelectorAll('button[data-sec]').forEach(b => b.classList.toggle('active', b.dataset.sec === p));
        document.querySelectorAll('#tab-super-security .sec-pane').forEach(x => x.classList.toggle('active', x.id === 'sec-pane-' + p));
    }
    // 'mfa' | 'devices' | 'devices:<login>' | 'help'
    function secGo(target) {
        const [pane, sub] = String(target).split(':');
        if (pane === 'devices') { sxSec.sub = sub || 'overview'; secRenderDevices(); }
        secShowPane(pane);
    }

    function secRenderOverview() {
        const m = sxSec.mfa, d = sxSec.dev, box = sx$('sx-sec-overview');
        if (!m || !d) { box.innerHTML = '<p style="color:var(--text-muted);">Loading... (or press Refresh)</p>'; return; }
        const people = m.people || [], setUp = people.filter(x => x.enrolled || x.exempt).length;
        const staff = d.logins.filter(x => x.role !== 'superadmin' && !x.exempt), lockedN = staff.filter(x => x.lock).length;
        const waiting = d.devices.filter(x => x.status === 'PENDING').length;
        const meOk = d.devices.some(x => x.mine && x.status === 'TRUSTED');
        const tile = (label, val, ok, go) => `<button type="button" class="sec-tile ${ok ? 'ok' : 'warn'}" data-go="${go}"><small>${label}</small><b>${val}</b></button>`;
        const chk = (ok, text, go) => `<li data-go="${go}"><span>${ok ? '&#9989;' : '&#11036;'}</span><span>${text}</span></li>`;
        box.innerHTML = '<div class="sec-tiles">' +
            tile('Second step (authenticator)', m.required ? 'REQUIRED' : 'not required', m.required, 'mfa') +
            tile('Super Admin computer lock', d.lock ? 'ON' : 'OFF', d.lock, 'devices:superadmin') +
            tile('Other logins locked', `${lockedN} of ${staff.length}`, staff.length > 0 && lockedN === staff.length, 'devices') +
            tile('Computers waiting for approval', String(waiting), waiting === 0, 'devices') + '</div>' +
            '<h4 style="margin:0 0 0.3rem;">Checklist (click a line to go there)</h4><ul class="sec-check">' +
            chk(setUp === people.length, 'Every Admin / Super Admin login has set up the authenticator app (or is a machine login)', 'mfa') +
            chk(m.required, 'The second step is required', 'mfa') +
            chk(meOk, 'Your own computer is trusted', 'devices:superadmin') +
            chk(d.lock, 'The Super Admin lock is ON', 'devices:superadmin') +
            chk(staff.every(x => x.trusted > 0), 'Every other login has at least one approved computer', 'devices') +
            chk(staff.length > 0 && lockedN === staff.length, 'Every other login is locked to its approved computers', 'devices') + '</ul>';
        const badge = sx$('sx-sec-badge'); badge.textContent = String(waiting); badge.style.display = waiting ? 'inline-block' : 'none';
    }

    function secRenderMfaPeople() {
        const o = sxSec.mfa;
        sx$('sx-mfa-people').innerHTML = '<div class="table-responsive"><table style="min-width:0; font-size:0.88rem;"><thead><tr><th>Login</th><th>Name</th><th>Role</th><th>Authenticator app</th><th></th></tr></thead><tbody>' +
            o.people.map(x => `<tr><td><b>${esc(x.username)}</b></td><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${x.exempt ? '<span class="mixr-pill info">machine login &ndash; password only</span>' : (x.enrolled ? '<span class="mixr-pill ok">set up</span>' : '<span class="mixr-pill wait">not yet</span>')}</td>` +
                `<td>${x.role === 'admin' ? `<button type="button" class="btn btn-secondary btn-sm" data-mx="${esc(x.username)}" data-on="${x.exempt ? 0 : 1}">${x.exempt ? 'Needs the code again' : 'Machine login (no code)'}</button>` : ''}</td></tr>`).join('') + '</tbody></table></div>';
        sx$('sx-mfa-people').onclick = (e) => {
            const b = e.target.closest('button[data-mx]'); if (!b) return;
            const who = b.dataset.mx, on = b.dataset.on === '1';
            openSuperEdit(on ? 'Machine login: ' + who : who + ' needs the code again',
                on ? '<b>Only for a login that no person types into</b> &ndash; for example the daily-backup tool. This login will work with its password alone even when the second step is required, and it is never held back by a computer lock, so give it a long random password and keep it only on the backup computer. Never do this for a login a person uses.' : 'This login will need the 6-digit code like the others (the backup tool would stop working until it is exempted again or enrols an authenticator).',
                [], async (v, why) => { await window.BiomassAPI.superMfaExempt(who, on, why); }, { saveLabel: on ? 'Make it a machine login' : 'Require the code', danger: !on, after: renderSuperSecurity });
        };
        sx$('sx-mfa-required').innerHTML = o.required ? '&#9989; The second step is <b>REQUIRED</b>: the Admin and Super Admin can do nothing without the code.' : 'The second step is <b>not required yet</b> (everyone who has set the app up is still asked for the code at sign-in).';
        sx$('btn-sx-mfa-required').textContent = o.required ? 'Switch the second step OFF…' : 'Switch the second step ON for the Admin and Super Admin logins…';
    }

    // ---- Registered computers: an Overview tab and one tab per login ----
    const secLockPill = (x) => x.exempt ? '<span class="mixr-pill info">machine login &ndash; never locked</span>' : (x.lock ? '<span class="mixr-pill ok">LOCKED to approved computers</span>' : '<span class="mixr-pill wait">not locked</span>');
    const secCount = (x) => `${x.trusted} approved${x.pending ? ` &middot; <b style="color:#fbbf24;">${x.pending} waiting</b>` : ''}`;
    function secDevRows(list, showLogin) {
        const cols = showLogin ? 6 : 5;
        return '<div class="table-responsive"><table style="min-width:0; font-size:0.88rem;"><thead><tr>' + (showLogin ? '<th>Login</th>' : '') + '<th>Computer</th><th>Status</th><th>Where</th><th>Last seen</th><th></th></tr></thead><tbody>' +
            (list.map(x => {
                const pill = x.status === 'TRUSTED' ? '<span class="mixr-pill ok">APPROVED</span>' : (x.status === 'PENDING' ? '<span class="mixr-pill wait">WAITING FOR APPROVAL</span>' : '<span class="mixr-pill bad">REVOKED</span>');
                const where = `${x.ip_label ? '<span class="ip-tag known">' + esc(x.ip_label) + '</span><br>' : ''}<small style="font-family:monospace; color:#94a3b8;">${esc(x.last_ip || '-')}</small>${x.agent ? '<br><small style="color:#94a3b8; font-size:0.7rem; overflow-wrap:anywhere;">' + esc(String(x.agent).slice(0, 70)) + '</small>' : ''}`;
                const acts = `${x.status !== 'TRUSTED' ? `<button type="button" class="btn btn-primary btn-sm" data-dev="${x.id}" data-act="approve">Approve</button> ` : ''}` +
                    `${x.status === 'TRUSTED' && !x.this_device ? `<button type="button" class="btn btn-secondary btn-sm" data-dev="${x.id}" data-act="revoke" style="border-color:#ef4444; color:#fca5a5;">Revoke</button> ` : ''}` +
                    `${!x.this_device && x.status !== 'TRUSTED' ? `<button type="button" class="btn btn-secondary btn-sm" data-dev="${x.id}" data-act="remove">Remove</button> ` : ''}` +
                    `<button type="button" class="btn btn-secondary btn-sm" data-dev="${x.id}" data-act="activity">What it did</button>`;
                return `<tr>${showLogin ? `<td><b>${esc(x.username)}</b><br><small style="color:#94a3b8;">${esc(x.role)}</small></td>` : ''}<td><b>${esc(x.name)}</b>${x.this_device ? ' <span class="mixr-pill info">this computer</span>' : ''}</td><td>${pill}${x.approved_by ? '<br><small style="color:#94a3b8;">by ' + esc(x.approved_by) + '</small>' : ''}</td>` +
                    `<td>${where}</td><td>${esc(x.last_seen || '-')}<br><small style="color:#94a3b8;">asked ${esc(x.requested_at)}</small></td><td>${acts}</td></tr>`;
            }).join('') || `<tr><td colspan="${cols}" style="text-align:center; color:var(--text-muted);">Nothing here.</td></tr>`) + '</tbody></table></div>';
    }

    function secRenderDevices() {
        const d = sxSec.dev; if (!d) return;
        if (sxSec.sub !== 'overview' && !d.logins.some(x => x.username === sxSec.sub)) sxSec.sub = 'overview';
        const waiting = d.devices.filter(x => x.status === 'PENDING').length, badge = (n) => n ? ` <span class="sec-badge">${n}</span>` : '';
        sx$('sx-dev-sub').innerHTML = `<button type="button" data-sub="overview" class="${sxSec.sub === 'overview' ? 'active' : ''}">&#128202; Overview${badge(waiting)}</button>` +
            d.logins.map(x => `<button type="button" data-sub="${esc(x.username)}" class="${sxSec.sub === x.username ? 'active' : ''}">${x.lock && !x.exempt ? '&#128274; ' : ''}${esc(x.username)}${badge(x.pending)}</button>`).join('');
        const main = sx$('sx-dev-main');
        if (sxSec.sub === 'overview') {
            const pend = d.devices.filter(x => x.status === 'PENDING');
            main.innerHTML = '<h4 style="margin:0 0 0.4rem;">Logins</h4><div class="table-responsive"><table style="min-width:0; font-size:0.88rem;"><thead><tr><th>Login</th><th>Role</th><th>Lock</th><th>Computers</th><th></th></tr></thead><tbody>' +
                d.logins.map(x => `<tr><td><b>${esc(x.username)}</b><br><small style="color:#94a3b8;">${esc(x.name)}</small></td><td>${esc(x.role)}</td><td>${secLockPill(x)}</td><td>${secCount(x)}</td><td><button type="button" class="btn btn-secondary btn-sm" data-sec-act="goto" data-to="${esc(x.username)}">Open &rarr;</button></td></tr>`).join('') + '</tbody></table></div>' +
                '<div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin:0.7rem 0 1.3rem;"><button type="button" class="btn btn-primary" data-sec-act="lockall-on">Lock every login that has an approved computer&hellip;</button><button type="button" class="btn btn-secondary" data-sec-act="lockall-off">Unlock every login&hellip;</button></div>' +
                `<h4 style="margin:0 0 0.4rem;">Waiting for approval (${pend.length})</h4>` + (pend.length ? secDevRows(pend, true) : '<p style="color:var(--text-muted); font-size:0.9rem;">No computer is waiting. A new computer appears here the first time a login is used on it.</p>') +
                '<div id="sx-dev-act" style="display:none;"></div>';
            return;
        }
        const x = d.logins.find(v => v.username === sxSec.sub), isS = x.role === 'superadmin', mine = d.devices.find(v => v.this_device);
        const btns = isS ? `${mine && mine.status === 'TRUSTED' ? '' : '<button type="button" class="btn btn-primary" data-sec-act="trust">&#128274; Trust this computer&hellip;</button> '}<button type="button" class="btn btn-secondary" data-sec-act="superlock">${d.lock ? 'Switch the lock OFF…' : 'Switch the lock ON…'}</button>`
            : (x.exempt ? '' : `<button type="button" class="btn ${x.lock ? 'btn-secondary' : 'btn-primary'}" data-lg="${esc(x.username)}" data-on="${x.lock ? 0 : 1}">${x.lock ? 'Unlock this login…' : 'Lock this login to approved computers…'}</button>`);
        main.innerHTML = `<div class="sec-loginhead"><div><h3>${esc(x.username)}</h3><small style="color:#94a3b8;">${esc(x.name)} &middot; ${esc(x.role)}</small></div><div>${secLockPill(x)}<br><small>${secCount(x)}</small></div><div style="display:flex; gap:0.5rem; flex-wrap:wrap;">${btns}</div></div>` +
            (isS ? `<p style="font-size:0.88rem; margin:0 0 0.8rem;">This computer: <b>${mine ? esc(mine.status) + ' (' + esc(mine.name) + ')' : 'not trusted yet'}</b> &middot; this session: <b>${d.session_verified ? 'verified' : 'not verified'}</b></p>` : '') +
            (x.exempt ? '<p style="font-size:0.88rem; color:#94a3b8;">A machine login (for example the backup tool) is never held back by a computer lock.</p>' : '') +
            secDevRows(d.devices.filter(v => v.username === x.username), false) + '<div id="sx-dev-act" style="display:none;"></div>';
    }

    function secDevClick(e) {
        const t = e.target.closest('button'); if (!t) return;
        const d = sxSec.dev;
        if (t.dataset.secAct) {
            const a = t.dataset.secAct;
            if (a === 'goto') { sxSec.sub = t.dataset.to; secRenderDevices(); }
            else if (a === 'trust') superDeviceTrust();
            else if (a === 'superlock') superLockSwitch();
            else if (a === 'lockall-on') superLoginLockAll(true);
            else if (a === 'lockall-off') superLoginLockAll(false);
            return;
        }
        if (t.dataset.lg) {
            const u = t.dataset.lg, on = t.dataset.on === '1';
            openSuperEdit(on ? 'Lock ' + u + ' to approved computers' : 'Unlock ' + u,
                on ? 'From now on the login <b>' + esc(u) + '</b> works only on a computer you have approved (anyone else with its password is stopped at the &ldquo;not approved&rdquo; screen). Refused if the login has no approved computer yet.' : 'The login <b>' + esc(u) + '</b> works from any computer again.',
                [], async (v, why) => { await window.BiomassAPI.loginLock(u, on, why); }, { saveLabel: on ? 'Lock' : 'Unlock', danger: !on, after: renderSuperSecurity });
            return;
        }
        if (t.dataset.dev) {
            const act = t.dataset.act, id = Number(t.dataset.dev), dv = d.devices.find(x => x.id === id);
            if (!dv) return;
            if (act === 'activity') { superDeviceActivity(dv); return; }
            if (act === 'approve') {
                openSuperEdit('Approve a computer for ' + dv.username, 'The login <b>' + esc(dv.username) + '</b> will be able to work on <b>' + esc(dv.name) + '</b> (last seen from ' + esc(dv.ip_label || dv.last_ip || 'an unknown address') + '). Check that it really is your computer. Give it a name you will recognise.',
                    [{ id: 'name', label: 'Name of this computer', type: 'text', value: dv.name, hint: '(e.g. Weighbridge tablet 2)' }],
                    async (v, why) => { await window.BiomassAPI.deviceDecide(id, 'approve', why, v.name); }, { saveLabel: 'Approve', danger: false, after: renderSuperSecurity });
            } else {
                const rem = act === 'remove';
                openSuperEdit((rem ? 'Remove ' : 'Revoke ') + dv.name, rem ? 'The computer is taken off the list (it can ask again the next time the login is used on it).' : 'The login <b>' + esc(dv.username) + '</b> can no longer work on this computer (its open session stops at once).',
                    [], async (v, why) => { await window.BiomassAPI.deviceDecide(id, act, why); }, { saveLabel: rem ? 'Remove' : 'Revoke', danger: true, after: renderSuperSecurity });
            }
        }
    }

    // what did this computer do? (the log lines written while it was the verified computer of a session)
    async function superDeviceActivity(dv) {
        const box = sx$('sx-dev-act');
        box.style.display = 'block'; box.innerHTML = '<p>Loading...</p>';
        try {
            const r = await window.BiomassAPI.deviceActivity(dv.id);
            box.innerHTML = `<div style="display:flex; justify-content:space-between; gap:0.5rem; align-items:center; margin:0.8rem 0 0.4rem;"><h4 style="margin:0;">What &ldquo;${esc(r.name)}&rdquo; did (${esc(r.username)}) &ndash; ${r.rows.length} of ${esc(r.total)} line(s)</h4><button type="button" class="btn btn-secondary btn-sm" id="btn-sx-dev-act-close">Close</button></div>` +
                '<div class="table-responsive"><table style="min-width:0; font-size:0.85rem;"><thead><tr><th>Time</th><th>Action</th><th>Details</th><th>Place</th></tr></thead><tbody>' +
                (r.rows.map(l => `<tr><td style="white-space:nowrap; font-family:monospace;">${esc(l.timestamp)}</td><td><b>${esc(l.action)}</b></td><td>${esc(l.details)}</td><td>${l.ip_label ? '<span class="ip-tag known">' + esc(l.ip_label) + '</span><br>' : ''}<small style="font-family:monospace; color:#94a3b8;">${esc(l.ip || '-')}</small></td></tr>`).join('') ||
                '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Nothing was done on this computer yet (only the sign-ins made while it was approved are attributed to it).</td></tr>') + '</tbody></table></div>';
            sx$('btn-sx-dev-act-close').onclick = () => { box.style.display = 'none'; };
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) { box.innerHTML = `<span style="color:#ef4444;">${esc(e.message)}</span>`; }
    }

    function superLoginLockAll(on) {
        openSuperEdit(on ? 'Lock every login that has an approved computer' : 'Unlock every login',
            on ? 'Every login (except the Super Admin and the machine login) that already has an approved computer is locked to its approved computers. Logins without one are left alone and named afterwards.' : 'Every login (except the Super Admin) works from any computer again.',
            [], async (v, why) => {
                const r = await window.BiomassAPI.loginLockAll(on, why);
                setTimeout(() => alert(on ? `Locked ${r.changed} login(s).` + (r.skipped ? `\n\nStill without an approved computer (left unlocked): ${r.skipped}` : '') : `Unlocked ${r.changed} login(s).`), 150);
            }, { saveLabel: on ? 'Lock them' : 'Unlock them', danger: !on, after: renderSuperSecurity });
    }

    function superMfaSwitch() {
        const turnOn = !sxSec.mfaRequired;
        openSuperEdit(turnOn ? 'Require the second step' : 'Stop requiring the second step',
            turnOn ? 'From now on the Admin and the Super Admin can do nothing without the 6-digit code. This is refused unless <b>every</b> Admin / Super Admin login has set the app up (the backup tool\'s machine login can be marked exempt in the table above) and you signed in with the code yourself.' : 'The Admin and Super Admin work with the password only again (anyone who set the app up is still asked for the code at sign-in).',
            [], async (v, why) => { await window.BiomassAPI.superMfaSet(turnOn, why); }, { saveLabel: turnOn ? 'Switch ON' : 'Switch OFF', danger: !turnOn, after: renderSuperSecurity });
    }
    function superDeviceTrust() {
        openSuperEdit('Trust this computer', 'This browser gets a secret code; the server keeps only its fingerprint. Do this on the computer you want to trust (your laptop). Name it so you recognise it.',
            [{ id: 'name', label: 'Name of this computer', type: 'text', value: 'My laptop' }],
            async (v, why) => { if (v.name.length < 2) throw new Error('Give the computer a name.'); await window.BiomassAPI.deviceTrust(v.name, why); }, { saveLabel: 'Trust this computer', danger: false, after: renderSuperSecurity });
    }
    function superLockSwitch() {
        const on = !sxSec.lock;
        openSuperEdit(on ? 'Switch the lock ON' : 'Switch the lock OFF',
            on ? 'The Super Admin login will then work only on trusted computers. This session must already be verified by a trusted computer (trust this computer first).' : 'The Super Admin login will work from any computer again (password' + (sxSec.mfaRequired ? ' and code' : '') + ' only).',
            [], async (v, why) => { await window.BiomassAPI.lockSet(on, why); }, { saveLabel: on ? 'Switch ON' : 'Switch OFF', danger: !on, after: renderSuperSecurity });
    }

    // A login whose lock is ON was used from a computer that is not approved: nothing else is shown until the Super Admin approves it
    function showDeviceBlock(dev) {
        const m = document.getElementById('device-block-modal'), txt = document.getElementById('device-block-text'), ask = document.getElementById('device-block-ask'), msg = document.getElementById('device-block-msg');
        const ask_btn = document.getElementById('btn-device-ask');
        const cu = window.BiomassAPI.getCurrentUser(), isSuper = !!(cu && cu.is_super);
        const st = dev && dev.status, nm = dev && dev.name ? ' (<b>' + esc(dev.name) + '</b>)' : '';
        msg.textContent = '';
        txt.innerHTML = st === 'PENDING' ? (isSuper ? 'Your request is <b>waiting for approval</b>. Sign in from a trusted computer, open <b>Security</b> and press <b>Approve</b>; then press <b>Check again</b> here.'
                : 'This computer' + nm + ' is <b>waiting for approval</b>. Tell the Super Admin: they approve it in <b>Security</b>. Then press <b>Check again</b>.')
            : (st === 'REVOKED' ? 'This computer was <b>removed</b> from the approved list. Use an approved computer.' :
               (st === 'ERROR' ? 'The computer could not be checked (connection problem?). Press <b>Check again</b>.' :
                (isSuper ? 'The Super Admin lock is <b>ON</b> and this computer has not been approved. Give it a name and ask for approval, then approve it from your trusted computer (Security tab) and press <b>Check again</b>.'
                    : 'This login works only on computers the Super Admin has approved, and this one has not been. Give it a name and ask for approval; the Super Admin approves it in <b>Security</b>. Then press <b>Check again</b>.')));
        ask.style.display = ask_btn.style.display = (st === 'UNKNOWN' || st === 'NONE') ? '' : 'none';
        m.style.display = 'flex';
        document.getElementById('btn-device-signout').onclick = () => { m.style.display = 'none'; hardSignOut(); };
        document.getElementById('btn-device-check').onclick = async () => {
            msg.style.color = ''; msg.textContent = 'Checking...';
            const r = await window.BiomassAPI.deviceCheck();
            if (r.verified || !r.lock) { m.style.display = 'none'; routeSession(); } else showDeviceBlock(r);
        };
        ask_btn.onclick = async () => {
            const name = document.getElementById('device-block-name').value.trim();
            if (name.length < 2) { msg.style.color = '#ef4444'; msg.textContent = 'Give this computer a name.'; return; }
            try { await window.BiomassAPI.deviceRequest(name); } catch (e) { msg.style.color = '#ef4444'; msg.textContent = e.message; return; }
            showDeviceBlock({ status: 'PENDING', lock: true, name: name });
        };
    }

    // ---------- IP addresses (Super Admin) ----------
    let sxIps = [];
    async function refreshSuperIpBadge() {
        try {
            const r = await window.BiomassAPI.superIps();
            const b = sx$('sx-ip-badge'); if (b) { b.textContent = String(r.unknown); b.style.display = r.unknown ? 'inline-block' : 'none'; }
            return r;
        } catch (e) { return null; }
    }
    async function renderSuperIps() {
        const body = sx$('sx-ips-body');
        body.innerHTML = '<tr><td colspan="7" class="sx-loading">Loading...</td></tr>';
        try {
            const r = await window.BiomassAPI.superIps();
            sxIps = r.ips || [];
            const b = sx$('sx-ip-badge'); if (b) { b.textContent = String(r.unknown); b.style.display = r.unknown ? 'inline-block' : 'none'; }
            body.innerHTML = sxIps.map((k, i) => `<tr class="${k.label ? '' : 'ip-unknown'}"><td style="font-family:monospace; font-weight:700;">${esc(k.ip)}</td>
                <td><span class="ip-tag ${k.label ? 'known' : 'unknown'}" style="margin-bottom:4px;">${k.label ? 'NAMED' : '⚠ UNKNOWN'}</span><br>
                    <input class="ip-input" id="sx-ipn-${i}" value="${esc(k.label || '')}" maxlength="60" placeholder="e.g. CHP Coal Bhawan PC"> <button class="btn btn-primary btn-sm" data-ipsave="${i}">Save</button></td>
                <td>${esc(k.first_seen)}</td><td>${esc(k.last_seen)}</td><td>${esc(k.seen_count)}</td><td>${esc(k.last_user || '-')}<br><small style="color:#94a3b8;">${esc(k.last_action || '')}</small></td>
                <td style="font-size:0.72rem; color:#94a3b8; max-width:240px;">${esc(String(k.device || '').slice(0, 110))}</td></tr>`).join('')
                || '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No address has been recorded yet.</td></tr>';
            body.onclick = async (e) => {
                const bt = e.target.closest('button[data-ipsave]'); if (!bt) return;
                const i = Number(bt.dataset.ipsave), label = sx$('sx-ipn-' + i).value.trim();
                bt.disabled = true;
                try { await window.BiomassAPI.superIpLabel(sxIps[i].ip, label); await renderSuperIps(); await renderSuperIpLog(); }
                catch (err) { alert(err.message); bt.disabled = false; }
            };
            const sel = sx$('sx-ipl-ip'), cur = sel.value;
            sel.innerHTML = '<option value="">All places</option>' + sxIps.map(k => `<option value="${esc(k.ip)}">${esc(k.label ? k.label + ' (' + k.ip + ')' : '⚠ UNKNOWN ' + k.ip)}</option>`).join('');
            sel.value = cur;
            renderSuperIpLog();
        } catch (e) {
            body.innerHTML = `<tr><td colspan="7" style="color:#ef4444;">${esc(e.message)}</td></tr>`;
        }
    }
    async function renderSuperIpLog() {
        const body = sx$('sx-ipl-body');
        body.innerHTML = '<tr><td colspan="4" class="sx-loading">Loading...</td></tr>';
        try {
            const lines = await window.BiomassAPI.superIpLogs(sx$('sx-ipl-ip').value, sx$('sx-ipl-q').value.trim(), 500);
            body.innerHTML = lines.map(l => {
                const unk = ipUnknown(l);
                return `<tr class="${unk ? 'ip-unknown' : ''}"><td style="font-family:monospace; font-size:0.82rem; white-space:nowrap;">${esc(l.timestamp)}</td>
                    <td>${unk ? '<span class="ip-tag unknown">⚠ UNKNOWN</span>' : `<span class="ip-tag known">${esc(l.ip_label || '-')}</span>`}<br><small style="font-family:monospace; color:#94a3b8;">${esc(l.ip || '-')}</small>${devTag(l)}</td>
                    <td>${esc(l.username)}</td><td><b>${esc(l.action)}</b><br><span style="font-size:0.82rem;">${esc(l.details)}</span></td></tr>`;
            }).join('') || '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No activity found.</td></tr>';
        } catch (e) {
            body.innerHTML = `<tr><td colspan="4" style="color:#ef4444;">${esc(e.message)}</td></tr>`;
        }
    }

    // ---------- Audit log export (Admin and Super Admin) ----------
    function isExceptionLog(log) {
        const a = String(log.action || ''), d = String(log.details || '').toLowerCase();
        return a.toLowerCase().includes('exception') || a.toLowerCase().includes('reissue') || a.toLowerCase().includes('lockout') ||
            a.startsWith('SUPERADMIN') || a === 'BOTTOM_PASSWORD_WRONG' || a === 'QR_CANCELLED' || d.includes('fail') || d.includes('expired') || d.includes('tampered');
    }
    async function exportAuditLog(onlyExceptions) {
        try {
            let logs = await window.BiomassAPI.getActivityLogs();
            if (onlyExceptions) logs = logs.filter(l => isExceptionLog(l));
            const wb = new ExcelJS.Workbook();
            const sheet = wb.addWorksheet(onlyExceptions ? 'Exceptions' : 'Audit log');
            sheet.columns = [{ header: 'Timestamp', width: 22 }, { header: 'User', width: 16 }, { header: 'Action', width: 26 }, { header: 'Details', width: 110 }, { header: 'IP address', width: 18 }, { header: 'Place (name of the IP)', width: 28 }, { header: 'Registered computer', width: 28 }, { header: 'Device', width: 60 }];
            sheet.getRow(1).font = { bold: true };
            logs.forEach(l => sheet.addRow([l.timestamp, l.username, l.action, l.details, l.ip || '', l.ip_label || '', l.device_name || '', l.device || '']));
            const buffer = await wb.xlsx.writeBuffer();
            const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const a = document.createElement('a');
            a.href = url; a.download = `${onlyExceptions ? 'Exceptions' : 'Audit_log'}_${window.BiomassAPI.todayIST().replace(/-/g, '')}.xlsx`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch (e) { alert('Export failed: ' + e.message); }
    }
    async function exportSuperLogs() {
        try {
            const r = await window.BiomassAPI.superLogs();
            const wb = new ExcelJS.Workbook();
            const s1 = wb.addWorksheet('Super Admin changes');
            s1.columns = [{ header: 'Timestamp', width: 22 }, { header: 'User', width: 14 }, { header: 'Action', width: 28 }, { header: 'Details', width: 110 }, { header: 'IP address', width: 18 }, { header: 'Registered computer', width: 28 }, { header: 'Device', width: 60 }];
            s1.getRow(1).font = { bold: true };
            (r.changes || []).forEach(l => s1.addRow([l.timestamp, l.username, l.action, l.details, l.ip || '', l.device_name || '', l.device || '']));
            const s2 = wb.addWorksheet('Results submitted');
            s2.columns = [{ header: 'Timestamp', width: 22 }, { header: 'Login', width: 16 }, { header: 'Reference', width: 24 }, { header: 'Submitted', width: 120 }];
            s2.getRow(1).font = { bold: true };
            (r.submissions || []).forEach(l => s2.addRow([l.timestamp, l.username, l.ref || '', l.summary]));
            const buffer = await wb.xlsx.writeBuffer();
            const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const a = document.createElement('a');
            a.href = url; a.download = `SuperAdmin_log_${window.BiomassAPI.todayIST().replace(/-/g, '')}.xlsx`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch (e) { alert('Export failed: ' + e.message); }
    }
    function initAuditButtons() {
        const a = sx$('btn-audit-export'), b = sx$('btn-audit-export-exc');
        const cu = window.BiomassAPI.getCurrentUser();
        if (cu && cu.is_super) {
            if (a) { a.onclick = exportSuperLogs; a.innerHTML = '&#11015;&#65039; Export (Excel)'; }
            if (b) b.style.display = 'none';
            return;
        }
        if (a) a.onclick = () => exportAuditLog(false);
        if (b) b.onclick = () => exportAuditLog(true);
    }
    // Admin: red badge on the Activity Log tab + banner while Super Admin changes are not acknowledged
    async function refreshSuperAlert() {
        const user = window.BiomassAPI.getCurrentUser();
        if (!user || user.role !== 'admin' || user.is_super) return;
        try {
            const r = await window.BiomassAPI.getSuperAlerts();
            const n = Number(r.unacknowledged) || 0, u = 0;      // unknown-IP alerts are not shown to the Admin (owner's decision)
            const badge = sx$('activity-tab-badge'), bar = sx$('super-alert-bar');
            if (badge) { badge.textContent = String(n + u); badge.style.display = (n + u) ? 'inline-block' : 'none'; }
            if (bar) {
                bar.style.display = (n + u) ? 'flex' : 'none';
                sx$('super-alert-text').innerHTML = [u ? `🌐 <b>${u} UNKNOWN IP address(es)</b> have been used - see the red lines below. The Super Admin must name them.` : '',
                    n ? `⚠️ ${n} change(s) were made by the Super Admin and have not been acknowledged.` : ''].filter(Boolean).join('<br>');
                const ack = sx$('btn-super-ack');
                ack.style.display = (r.is_real_admin && n) ? '' : 'none';
                ack.onclick = async () => { ack.disabled = true; try { await window.BiomassAPI.ackSuperAlerts(); } catch (e) { alert(e.message); } ack.disabled = false; refreshSuperAlert(); };
            }
        } catch (e) { /* the next poll retries */ }
    }

    // ================= BOTTOM SAMPLES (Entry / Admin) =================
    let bottomPollTimer = null;
    function initBottomSamples() {
        const refreshBtn = document.getElementById('btn-bottom-refresh');
        if (refreshBtn) refreshBtn.onclick = () => renderBottomList();
        refreshBottomBadge();
        if (!bottomPollTimer) {
            bottomPollTimer = setInterval(() => {
                if (document.hidden) return;
                refreshBottomBadge();
                const pane = document.getElementById('tab-admin-bottom');
                if (pane && pane.classList.contains('active')) renderBottomList();
            }, 20000);
        }
    }
    async function refreshBottomBadge() {
        const badge = document.getElementById('bottom-tab-badge'), tab = document.getElementById('tab-btn-bottom');
        if (!badge || !tab) return;
        try {
            const rows = await window.BiomassAPI.getBottomRequests();
            const n = rows.filter(r => r.status === 'REQUESTED').length;
            badge.textContent = String(n);
            badge.style.display = n ? 'inline-block' : 'none';
            tab.classList.toggle('bottom-alert', n > 0);
        } catch (e) { /* ignore: the next poll retries */ }
    }
    async function renderBottomList() {
        const box = document.getElementById('bottom-list');
        if (!box) return;
        try {
            const rows = await window.BiomassAPI.getBottomRequests();
            const n = rows.filter(r => r.status === 'REQUESTED').length;
            const badge = document.getElementById('bottom-tab-badge'), tab = document.getElementById('tab-btn-bottom');
            if (badge) { badge.textContent = String(n); badge.style.display = n ? 'inline-block' : 'none'; }
            if (tab) tab.classList.toggle('bottom-alert', n > 0);
            if (!rows.length) { box.innerHTML = '<div style="color:#94a3b8; font-style:italic; padding:0.5rem;">No bottom sample requests.</div>'; return; }
            box.innerHTML = '';
            rows.forEach(r => {
                const pending = r.status === 'REQUESTED';
                const card = document.createElement('div');
                card.className = 'bottom-req-card' + (pending ? ' pending' : '');
                card.innerHTML = `
                    <div>
                        <div style="font-size:${pending ? '1.25rem' : '1rem'}; font-weight:800;">${pending ? '🔔 ' : '✅ '}${esc(r.truck_reg_number)}</div>
                        <div style="font-size:0.85rem; color:#cbd5e1;">${esc(r.company_name)} &bull; Driver: ${esc(r.driver_name || '-')}</div>
                        <div style="font-size:0.8rem; color:#94a3b8;">Requested ${esc(dmy(r.requested_date))} ${esc(r.requested_time || '')}${r.reason ? ' &bull; Reason: ' + esc(r.reason) : ''}</div>
                    </div>
                    <div></div>`;
                const holder = card.lastElementChild;
                const btn = document.createElement('button');
                btn.type = 'button';
                if (pending) {
                    btn.className = 'btn btn-primary';
                    btn.textContent = '🖨️ Generate QR & print label';
                    btn.onclick = () => generateBottomLabel(r, btn);
                } else {
                    btn.className = 'btn btn-secondary btn-sm';
                    btn.textContent = '🖨️ Reprint label';
                    btn.onclick = () => reprintBottomLabel(r, btn);
                }
                holder.appendChild(btn);
                box.appendChild(card);
            });
        } catch (err) {
            box.innerHTML = `<div style="color:#ef4444; padding:0.5rem;">Could not load the requests: ${esc(err.message)}</div>`;
        }
    }
    async function showBottomLabel(res, truckReg) {
        const card = document.getElementById('bottom-label-card');
        document.getElementById('bottom-label-truck').textContent = truckReg || '';
        document.getElementById('bottom-label-date').textContent = dmy(res.entry_date);
        document.getElementById('bottom-label-id').textContent = '';      // no serial number under the QR
        const enc = await encryptPayload(res.sample1_barcode_id);
        QRCode.toCanvas(document.getElementById('qr-canvas-bottom'), enc, { errorCorrectionLevel: 'M', width: 246, margin: 4 }, function(err) { if (err) console.error(err); });
        document.getElementById('btn-print-bottom').onclick = () => window.printSampleLabel(res.sample1_barcode_id, res.entry_date);
        document.getElementById('btn-download-bottom').onclick = () => downloadQrAsPng('#qr-canvas-bottom', `Sample_${res.sample1_barcode_id}`, dmy(res.entry_date), res.sample1_barcode_id);
        card.style.display = 'block';
        card.scrollIntoView({ behavior: 'smooth' });
    }
    async function generateBottomLabel(r, btn) {
        if (!confirm(`Generate a NEW sample QR for truck ${r.truck_reg_number}?\n\nThe truck's existing sample stays valid for moisture and fineness, but it is taken out of the composite mixture. This cannot be undone.`)) return;
        btn.disabled = true;
        try {
            const res = await window.BiomassAPI.generateBottomSample(r.truck_id);
            if (!res || !res.success) throw new Error((res && res.message) || 'Could not generate the sample');
            await showBottomLabel(res, r.truck_reg_number);
            await renderBottomList();
            const auto = document.getElementById('auto-print-label');
            if (auto && auto.checked) window.printSampleLabel(res.sample1_barcode_id, res.entry_date);
        } catch (err) {
            alert('Could not generate the bottom sample: ' + err.message);
            btn.disabled = false;
        }
    }
    async function reprintBottomLabel(r, btn) {
        btn.disabled = true;
        try {
            const res = await window.BiomassAPI.reprintBottomSample(r.truck_id);
            await showBottomLabel(res, r.truck_reg_number);
        } catch (err) {
            alert(err.message);
        } finally { btn.disabled = false; }
    }

    // Admin > Barcode Inspector > Mixing codes: every mixing code (composite) of a date range, each opening to its truck-wise details
    function initMixSearch() {
        const input = document.getElementById('inspector-mix-input'), btn = document.getElementById('btn-inspector-mix');
        if (!input || !btn || btn.dataset.wired) return;
        btn.dataset.wired = '1';
        const fromEl = document.getElementById('mixr-from'), toEl = document.getElementById('mixr-to'), lotEl = document.getElementById('mixr-lot');
        const card = document.getElementById('mixsearch-result-card'), sum = document.getElementById('mixsearch-summary'), list = document.getElementById('mixr-list'), cnt = document.getElementById('mixr-count');
        const chips = document.getElementById('mixr-chips');
        const today = () => window.BiomassAPI.todayIST();
        const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
        const f = (v, d) => (v === null || v === undefined || v === '') ? '<span style="color:#f59e0b;">Pending</span>' : Number(v).toFixed(d);
        const wt = v => Number(v) > 0 ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-';
        const mtTxt = (kg) => (Number(kg) / 1000).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MT';
        const weekday = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' });
        if (!fromEl.value) { fromEl.value = shift(today(), -1); toEl.value = today(); }      // today and yesterday by default; the dates / chips show older days
        fromEl.max = toEl.max = today();
        let groups = [];

        const truckTable = (g) => {
            const rows = g.rows || [];
            const lot4 = g.lot === 'LOT4';
            return `<div class="table-responsive"><table class="mixsearch-table" style="min-width:0; font-size:0.8rem;"><thead><tr><th>Vehicle / Truck ID</th><th>Time</th><th>Sample QR</th><th>Sample type</th><th>Gross / Tare / Net (kg)</th><th>Moisture %</th><th>Fineness %</th><th>Result</th><th>In mixture?</th><th>Scanned</th></tr></thead><tbody>` +
                rows.map(r => {
                    const lk = r.linked_group_code ? ` (code ${esc(r.linked_group_code)})` : '';
                    const type = r.is_bottom_sample ? `<span class="mixr-pill info">Bottom sample</span> of the truck's original sample${lk}`
                        : (r.excluded_from_mix ? `Truck sample <span class="mixr-pill bad">replaced by bottom sample${lk}</span>` : 'Truck sample');
                    const res = r.cancel_status === 'CANCELLED' || r.acceptance_status === 'CANCELLED' ? `<span style="color:#ef4444; font-weight:700;">QR CANCELLED</span><br><small style="color:#94a3b8;">${esc(r.cancel_reason || '')}</small>`
                        : r.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:700;">REJECTED</span>' : (r.acceptance_status === 'ACCEPTED' ? '<span style="color:#10b981; font-weight:700;">ACCEPTED</span>' : '<span style="color:#f59e0b;">PENDING</span>');
                    const inMix = r.mix_status === 'ACCEPTED' ? '<span style="color:#10b981; font-weight:700;">Included</span>' : (r.mix_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:700;">Left out</span>' : '<span style="color:#f59e0b;">Pending</span>');
                    return `<tr><td><strong>${esc(r.truck_reg_number)}</strong><br><small style="color:#94a3b8;">${esc(r.truck_id)}${r.driver_name ? ' &middot; ' + esc(r.driver_name) : ''}${r.invoice_no ? ' &middot; ' + esc(r.invoice_no) : ''}</small></td><td>${esc(r.entry_time || '')}</td>` +
                        `<td><span style="font-family:monospace;">${esc(r.sample1_barcode_id)}</span></td><td>${type}</td><td>${wt(r.gross_weight)} / ${wt(r.tare_weight)} / ${wt(r.net_weight)}</td>` +
                        `<td>${f(r.moisture_pct, 2)}</td><td>${f(r.fineness_value, 2)}</td><td>${res}</td><td>${inMix}</td><td>${r.mixing_scanned ? '✅' : '-'}</td></tr>`;
                }).join('') + '</tbody></table></div>';
        };
        const bodyHtml = (g) => {
            const c = g.composite;
            const facts = [['Date', dmy(g.date)], ['Vendor', g.company_name], ['Lot / PO', lotLabel(g.lot) + ' / ' + (g.po_number || 'not set')], ['Trucks', `${g.trucks}${g.bottom_samples ? ' + ' + g.bottom_samples + ' bottom sample' : ''}`]];
            if (c) {
                facts.push(['Composite', c.composite_ref_id], ['Test / Referee / Vendor lot', [c.test_lot, c.referee_lot, c.vendor_lot].filter(Boolean).join(' / ') || '-']);
                if (c.tested) {
                    facts.push(['TM %', f(g.tm, 2)], ['ARB GCV', f(g.gcv, 0)], ['ARB Ash %', f(g.ash, 2)]);
                    if (g.lot === 'LOT4') facts.push(['ARB Sulphur / VM %', `${f(g.sulphur, 2)} / ${f(g.vm, 2)}`]);
                } else facts.push(['Lab 2 result', 'not tested yet']);
            } else facts.push(['Composite', 'not made yet']);
            return `<div class="mixr-facts">${facts.map(x => `<div><small>${x[0]}</small>${esc(x[1])}</div>`).join('')}</div>` + truckTable(g);
        };
        const groupHtml = (g, i) => {
            const c = g.composite;
            const comp = !c ? '<span class="mixr-pill mute">Composite not made</span>' : (c.tested ? `<span class="mixr-pill info">Composite tested &middot; GCV ${esc(Number(g.gcv).toFixed(0))}</span>` : '<span class="mixr-pill wait">Composite made &middot; not tested</span>');
            const pills = (g.accepted ? `<span class="mixr-pill ok">${g.accepted} accepted</span>` : '') + (g.rejected ? `<span class="mixr-pill bad">${g.rejected} rejected</span>` : '') + (g.pending ? `<span class="mixr-pill wait">${g.pending} pending</span>` : '') +
                (g.bottom_samples && !g.trucks ? '<span class="mixr-pill info">bottom sample</span>' : '') + comp;
            return `<div class="mixr-group" data-i="${i}"><button type="button" class="mixr-head" aria-expanded="false">` +
                `<span class="mixr-code">${esc(g.group_code)}</span>` +
                `<span class="mixr-vendor">${esc(g.company_name)}<small>PO ${esc(g.po_number || 'not set')}</small></span>` +
                `<span><span class="lot-tag ${lotCls(g.lot)}">${esc(lotLabel(g.lot))}</span></span>` +
                `<span class="mixr-net"><strong>${g.trucks || g.bottom_samples}</strong> ${g.trucks ? 'truck' + (g.trucks > 1 ? 's' : '') : 'bottom sample'}<small style="display:block; color:#94a3b8;">${g.accepted ? mtTxt(g.net_weight) + ' accepted' : 'no accepted weight'}</small></span>` +
                `<span class="mixr-counts">${pills}</span><span class="mixr-chev">&#9656;</span></button><div class="mixr-body"></div></div>`;
        };
        const toggle = (el, force) => {
            const open = force === undefined ? !el.classList.contains('open') : force;
            el.classList.toggle('open', open);
            el.querySelector('.mixr-head').setAttribute('aria-expanded', open ? 'true' : 'false');
            const body = el.querySelector('.mixr-body');
            if (open && !body.dataset.done) { body.innerHTML = bodyHtml(groups[Number(el.dataset.i)]); body.dataset.done = '1'; }
        };
        const render = (res, from, to, q) => {
            groups = res.groups || [];
            card.style.display = 'block';
            if (!groups.length) {
                sum.innerHTML = '<div class="tile" style="grid-column: 1 / -1; color:#f59e0b;">No mixing code found for this selection. Try a wider date range or clear the search box.</div>';
                list.innerHTML = ''; cnt.textContent = ''; return;
            }
            const trucks = groups.reduce((a, g) => a + g.trucks, 0), vendors = new Set(groups.map(g => g.company_name)).size;
            const made = groups.filter(g => g.composite).length, tested = groups.filter(g => g.composite && g.composite.tested).length;
            const period = from ? (from === to ? dmy(from) : dmy(from) + ' to ' + dmy(to)) : 'all dates';
            sum.innerHTML = [['Period', period], ['Mixing codes', groups.length], ['Trucks', trucks], ['Vendors', vendors], ['Composites made', `${made} of ${groups.length}`], ['Tested by Lab 2', `${tested} of ${made}`]].map(t => `<div class="tile"><small>${t[0]}</small><strong>${esc(String(t[1]))}</strong></div>`).join('') +
                (res.truncated ? '<div class="tile" style="grid-column: 1 / -1; color:#fbbf24;">Only the first 400 mixing codes are shown. Narrow the dates or add a vendor / lot.</div>' : '');
            cnt.textContent = `${groups.length} mixing code${groups.length > 1 ? 's' : ''} - click one to see its trucks`;
            let html = '', day = null;
            groups.forEach((g, i) => {
                if (g.date !== day) { day = g.date; html += `<div class="mixr-day">${esc(dmy(day))} &middot; ${esc(weekday(day))}</div>`; }
                html += groupHtml(g, i);
            });
            list.innerHTML = html;
            if (groups.length === 1) toggle(list.querySelector('.mixr-group'), true);
        };
        const go = async () => {
            let from = fromEl.value, to = toEl.value; const q = input.value.trim(), lot = lotEl.value;
            if (from && !to) to = from; if (to && !from) from = to;
            if (!from && !q) { alert('Choose a date range, or type a mixing code / vendor / truck number.'); return; }
            if (from && to && from > to) { alert('The start date is after the end date.'); return; }
            btn.disabled = true; btn.textContent = 'Loading...';
            try {
                const res = await window.BiomassAPI.mixingRange({ from, to, q, lot });
                render(res, from, to, q);
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (err) { alert('Search failed: ' + err.message); }
            finally { btn.disabled = false; btn.textContent = 'Show mixing codes'; }
        };
        chips.onclick = (e) => {
            const b = e.target.closest('button[data-range]'); if (!b) return;
            const t = today(), r = b.dataset.range;
            if (r === 'any') { fromEl.value = toEl.value = ''; chips.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); input.focus(); return; }
            if (r === 'two') { fromEl.value = shift(t, -1); toEl.value = t; }
            else if (r === 'today') { fromEl.value = toEl.value = t; }
            else if (r === 'yesterday') { fromEl.value = toEl.value = shift(t, -1); }
            else if (r === 'week') { fromEl.value = shift(t, -6); toEl.value = t; }
            else { fromEl.value = t.slice(0, 8) + '01'; toEl.value = t; }
            chips.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
            go();
        };
        [fromEl, toEl].forEach(el => { el.onchange = () => chips.querySelectorAll('button').forEach(x => x.classList.remove('active')); });
        list.onclick = (e) => { const h = e.target.closest('.mixr-head'); if (h) toggle(h.parentElement); };
        document.getElementById('mixr-expand').onclick = () => list.querySelectorAll('.mixr-group').forEach(el => toggle(el, true));
        document.getElementById('mixr-collapse').onclick = () => list.querySelectorAll('.mixr-group').forEach(el => toggle(el, false));
        btn.onclick = go;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    }

    function initAdminInspectorTab() {
        initFeatureTabs('insp-tabs');
        initMixSearch();
        document.getElementById('inspector-result-card').style.display = 'none';
        document.getElementById('inspector-manual-input').value = '';
        setupInspectorSnapScanner();
        setupInspectorFileUploadScanner();
    }

    // Admin Inspector keeps every input method: snap photo, manual type, and file upload.
    function setupInspectorSnapScanner() {
        setupSnapOnlyScanner({
            triggerId: 'inspector-scan-trigger',
            readerId: 'inspector-qr-reader',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('inspector-manual-input').value = plainId;
                lookupInspectorBarcode(plainId);
            }
        });
    }

    function setupInspectorFileUploadScanner() {
        const fileInput = document.getElementById('inspector-file-input');
        fileInput.addEventListener('change', function(e) {
            if (e.target.files.length === 0) return;
            const file = e.target.files[0];
            
            scanUploadedFile(
                file,
                "inspector-qr-reader",
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('inspector-manual-input').value = plainId;
                        lookupInspectorBarcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    fileInput.value = '';
                },
                function(errorMessage) {
                    alert(errorMessage);
                    fileInput.value = '';
                }
            );
        });
    }

    document.getElementById('btn-inspector-lookup').onclick = async () => {
        const barcode = document.getElementById('inspector-manual-input').value.trim();
        try {
            const plainId = await processScannedCode(barcode);
            lookupInspectorBarcode(plainId);
        } catch (e) {
            alert(e.message);
        }
    };

    // Admin corrections (always with a reason, written to the audit log). A moisture correction recalculates every composite that contains the truck.
    let inspectorLastBatch = null;
    window.adminCorrectMoisture = async function(barcode, current) {
        const v = prompt(`Current moisture: ${current} %\n\nEnter the CORRECTED moisture (%):`);
        if (v === null || v.trim() === '') return;
        const n = Number(v);
        if (!(n > 0 && n < 100)) { alert('The moisture must be above 0 and below 100.'); return; }
        const reason = prompt('Reason for the correction (required - it goes into the audit log):');
        if (!reason || !reason.trim()) { alert('A reason is required.'); return; }
        try {
            await window.BiomassAPI.submitSample1Result(barcode, String(n), '', { override_reason: reason.trim() });
            alert('Moisture corrected. Any composite that contains this truck has been recalculated.');
            lookupInspectorBarcode(barcode);
        } catch (e) { alert('Could not correct the moisture: ' + e.message); }
    };
    window.adminCorrectAd = async function() {
        const b = inspectorLastBatch;
        if (!b) return;
        const isL4 = b.lot === 'LOT4';
        const ask = (label, cur) => { const v = prompt(`${label}\n(current: ${cur === null || cur === undefined ? 'none' : cur})`, cur === null || cur === undefined ? '' : String(cur)); return v === null ? null : v.trim(); };
        const vals = {};
        for (const [k, label] of [['ad_moisture', 'AD Moisture (%)'], ['ad_gcv', 'AD GCV (kcal/kg)'], ['ad_ash', 'AD Ash (%)']].concat(isL4 ? [['ad_sulphur', 'AD Sulphur (%)'], ['ad_vm', 'AD VM (%)']] : [])) {
            const v = ask(label, b[k]);
            if (v === null) return;
            vals[k] = v;
        }
        const reason = prompt('Reason for the correction (required - it goes into the audit log):');
        if (!reason || !reason.trim()) { alert('A reason is required.'); return; }
        try {
            const r = await window.BiomassAPI.submitCompositeResult(b.test_lot || b.composite_barcode_id, vals, reason.trim());
            alert(`Saved and recalculated.\nTM ${Number(r.tm).toFixed(2)} %  |  X ${Number(r.x).toFixed(6)}\nARB GCV ${r.arb_gcv}  |  ARB Ash ${Number(r.arb_ash).toFixed(2)} %` +
                  (r.arb_sulphur !== null && r.arb_sulphur !== undefined ? `\nARB Sulphur ${Number(r.arb_sulphur).toFixed(2)} %  |  ARB VM ${Number(r.arb_vm).toFixed(2)} %` : ''));
            lookupInspectorBarcode(b.composite_barcode_id || b.test_lot);
        } catch (e) { alert('Could not save: ' + e.message); }
    };

    async function lookupInspectorBarcode(barcode) {
        if (!barcode) {
            alert('Please scan, upload, or type a barcode.');
            return;
        }

        const resultCard = document.getElementById('inspector-result-card');
        const resultContent = document.getElementById('inspector-result-content');
        resultCard.style.display = 'none';

        try {
            const res = await window.BiomassAPI.inspectBarcode(barcode);
            if (res.success) {
                resultCard.style.display = 'block';
                
                if (res.type === 'sample1') {
                    const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(res.truck.entry_date);
                    const timeStr = window.BiomassAPI.formatLocalTime(res.truck.entry_time);
                    
                    let lab1Html = '';
                    if (res.lab1) {
                        let scalePhotosHtml = '';
                        // Photos are NOT bulk-loaded any more: the admin fetches each one on demand.
                        const photoBtnStyle = 'background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #065f46; font-weight: bold;';
                        const sampleKey = esc(res.lab1.sample1_barcode_id);
                        const fmtKg = (w) => (w !== undefined && w !== null && w !== '') ? w + ' kg' : 'Captured';
                        const photoBtn = (kind, caption, label) =>
                            `<button type="button" class="btn btn-secondary btn-sm" onclick="window.viewEvidencePhoto('${kind}', '${sampleKey}', '${esc(caption).replace(/'/g, '')}')" style="${photoBtnStyle}">${label}</button>`;
                        const photoBtns = [];
                        if (res.lab1.has_moisture_photo) photoBtns.push(photoBtn('moisture', 'Moisture Analyzer Scale Photo (' + res.lab1.moisture_pct + '%)', '📷 View Moisture Scale Photo'));
                        if (res.lab1.has_fineness_initial_photo) photoBtns.push(photoBtn('fineness_initial', 'Initial Weight Scale Photo (i = ' + fmtKg(res.lab1.fineness_initial_weight) + ')', '📷 View Initial Scale Photo (i: ' + esc(fmtKg(res.lab1.fineness_initial_weight)) + ')'));
                        if (res.lab1.has_fineness_final_photo) photoBtns.push(photoBtn('fineness_final', 'Final Weight Scale Photo (f = ' + fmtKg(res.lab1.fineness_final_weight) + ')', '📷 View Final Scale Photo (f: ' + esc(fmtKg(res.lab1.fineness_final_weight)) + ')'));
                        if (photoBtns.length) {
                            scalePhotosHtml = `<div style="margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px dashed rgba(6, 95, 70, 0.3); display: flex; gap: 0.5rem; flex-wrap: wrap;">`;
                            scalePhotosHtml += `<span style="width: 100%; font-size: 0.8rem; font-weight: bold; color: #065f46;">📸 Scale Reading Photo Audit Proofs:</span>`;
                            scalePhotosHtml += photoBtns.join('');
                            scalePhotosHtml += `</div>`;
                        }

                        const initW = (res.lab1.fineness_initial_weight !== undefined && res.lab1.fineness_initial_weight !== null && res.lab1.fineness_initial_weight !== '') ? res.lab1.fineness_initial_weight : '-';
                        const finalW = (res.lab1.fineness_final_weight !== undefined && res.lab1.fineness_final_weight !== null && res.lab1.fineness_final_weight !== '') ? res.lab1.fineness_final_weight : '-';
                        const finenessDetails = (initW !== '-' || finalW !== '-') ? ` (i: ${initW}, f: ${finalW})` : '';

                        lab1Html = `
                            <div class="lab-meta-display" style="background: #ecfdf5; border-color: #a7f3d0; margin-top: 1rem; color: #065f46;">
                                <strong>Lab Station 1 Results &amp; Photo Audit:</strong><br>
                                • Moisture: ${res.lab1.moisture_pct !== null && res.lab1.moisture_pct !== undefined ? res.lab1.moisture_pct + '%' : 'Pending'}<br>
                                • Fineness: ${res.lab1.fineness_value !== null && res.lab1.fineness_value !== undefined ? res.lab1.fineness_value + '%' + finenessDetails : 'Pending'}<br>
                                • Tested By: ${esc(res.lab1.tested_by || '-')}<br>
                                • Tested At: ${res.lab1.tested_at || '-'}
                                ${res.lab1.moisture_pct !== null && res.lab1.moisture_pct !== undefined ? `<br><button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.4rem;" onclick="window.adminCorrectMoisture('${sampleKey}', ${Number(res.lab1.moisture_pct)})">✏️ Correct moisture (Admin, needs a reason)</button>` : ''}
                                ${scalePhotosHtml}
                            </div>
                        `;
                    } else {
                        lab1Html = `
                            <div class="lab-meta-display" style="background: #fef3c7; border-color: #fde68a; margin-top: 1rem; color: #92400e;">
                                ⚠️ No Lab 1 results submitted yet.
                            </div>
                        `;
                    }
                    
                    let compositeHtml = '';
                    if (res.composite) {
                        compositeHtml = `
                            <div class="lab-meta-display" style="background: #eff6ff; border-color: #bfdbfe; margin-top: 1rem; color: #1e40af;">
                                <strong>Composite Mixing Lot Details:</strong><br>
                                • Composite Ref: ${esc(res.composite.composite_ref_id)}<br>
                                • Company: ${esc(res.composite.company_name)}<br>
                                • Compilation Date: ${res.composite.date}<br>
                                • ARB GCV: ${res.composite.gcv_value || 'Pending Lab 2'}<br>
                                • ARB Ash: ${res.composite.ash_pct ? res.composite.ash_pct + '%' : 'Pending Lab 2'}<br>
                                • TM: ${res.composite.tm_value != null ? Number(res.composite.tm_value).toFixed(2) + '%' : '-'} &nbsp; Lot: ${esc(res.composite.lot || 'LOT2/3')}
                            </div>
                        `;
                    } else {
                        compositeHtml = `
                            <div class="lab-meta-display" style="background: #f3f4f6; border-color: #e5e7eb; margin-top: 1rem; color: #374151;">
                                • Composite Lot Status: Not yet compiled/mixed.
                            </div>
                        `;
                    }

                    resultContent.innerHTML = `
                        <div class="lab-meta-display" style="margin-bottom: 1rem; text-align: center; background: #f3f4f6; color: black; font-weight: bold; font-size: 1rem;">
                            INTAKE SAMPLE 1 BARCODE: ${esc(res.truck.sample1_barcode_id || res.barcode_id)}
                        </div>
                        <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-muted);">
                            <strong>Truck ID:</strong> ${esc(res.truck.truck_id)}<br>
                            <strong>Supplier Name:</strong> ${esc(res.truck.company_name)}<br>
                            <strong>Daily Mixing Group Code:</strong> <span class="badge badge-complete" style="font-size: 0.85rem;">${esc(res.truck.daily_group_code || 'N/A')}</span><br>
                            <strong>Driver Name:</strong> ${esc(res.truck.driver_name)}<br>
                            <strong>Vehicle Registration:</strong> ${esc(res.truck.truck_reg_number)}<br>
                            <strong>Date / Time of Intake:</strong> ${dateStr} ${timeStr}<br>
                            <strong>Gross Weight:</strong> ${res.truck.gross_weight || '-'} kg<br>
                            <strong>Tare Weight:</strong> ${res.truck.tare_weight || '-'} kg<br>
                            <strong>Net Weight:</strong> <strong style="color: var(--primary);">${res.truck.net_weight || '-'} kg</strong><br>
                            <strong>Registered By:</strong> ${esc(res.truck.created_by || 'system')}${res.truck.has_photo ? `<br><button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.4rem;" onclick="window.viewEvidencePhoto('truck', '${esc(res.truck.truck_id)}', 'Gate photo at registration')">📷 View Gate Photo</button>` : ''}
                        </div>
                        ${lab1Html}
                        ${compositeHtml}
                    `;
                } else if (res.type === 'composite') {
                    let trucksHtml = res.matching_trucks.map(t => `• ${esc(t.truck_id)} (${esc(t.truck_reg_number)})`).join('<br>');
                    
                    let lab2ResultsHtml = '';
                    inspectorLastBatch = res.batch;
                    if (res.batch.gcv_value !== null && res.batch.gcv_value !== "") {
                        const b = res.batch, isL4 = b.lot === 'LOT4', has = (v) => v !== null && v !== undefined;
                        const fx = (v, d) => has(v) ? Number(v).toFixed(d) : '-';
                        lab2ResultsHtml = `
                            <div class="lab-meta-display" style="background: #ecfdf5; border-color: #a7f3d0; margin-top: 1rem; color: #065f46;">
                                <strong>Lab Station 2 Results</strong> (${esc(b.lot || 'LOT2/3')}):<br>
                                ${has(b.ad_gcv) ? `• Air-dried (AD): Moisture ${fx(b.ad_moisture, 3)} % | GCV ${fx(b.ad_gcv, 2)} | Ash ${fx(b.ad_ash, 3)} %${isL4 ? ` | Sulphur ${fx(b.ad_sulphur, 3)} % | VM ${fx(b.ad_vm, 3)} %` : ''}<br>
                                • TM (mean moisture of the mixed trucks): <strong>${fx(b.tm_value, 4)} %</strong> &nbsp; X = <strong>${fx(b.x_factor, 6)}</strong><br>`
                                  : '• Entered manually as ARB values (before the AD calculation existed)<br>'}
                                • <strong>ARB GCV: ${b.gcv_value} kcal/kg</strong><br>
                                • <strong>ARB Ash: ${b.ash_pct}%</strong><br>
                                ${isL4 ? `• <strong>ARB Sulphur: ${fx(b.arb_sulphur, 2)}%</strong><br>• <strong>ARB VM: ${fx(b.arb_vm, 2)}%</strong><br>` : ''}
                                • Tested By: ${esc(b.tested_by)}<br>
                                • Tested At: ${b.tested_at}<br>
                                <button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.5rem;" onclick="window.adminCorrectAd()">✏️ Correct AD values (Admin, needs a reason)</button>
                            </div>
                        `;
                    } else {
                        lab2ResultsHtml = `
                            <div class="lab-meta-display" style="background: #fef3c7; border-color: #fde68a; margin-top: 1rem; color: #92400e;">
                                ⚠️ No Lab 2 GCV/Ash test results uploaded yet.
                            </div>
                        `;
                    }

                    resultContent.innerHTML = `
                        <div class="lab-meta-display" style="margin-bottom: 1rem; text-align: center; background: #e0f2fe; color: #0369a1; font-weight: bold; font-size: 1rem;">
                            COMPOSITE LOT: ${esc(res.batch.composite_ref_id)}${res.ambiguous_group_matches > 1 ? `<div style="font-size:0.75rem;font-weight:normal;margin-top:0.25rem;">Group code matched ${res.ambiguous_group_matches} lots on different dates — showing the latest. Scan the lot QR for an exact match.</div>` : ''}
                        </div>
                        <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-muted);">
                            <strong>Supplier Name:</strong> ${esc(res.batch.company_name)}<br>
                            <strong>Compilation Date:</strong> ${res.batch.date}<br>
                            <strong>Test Lot Barcode ID:</strong> ${res.batch.test_lot || res.batch.composite_barcode_id || (res.batch.lots ? res.batch.lots.test : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-T' : 'N/A')}<br>
                            <strong>Referee Lot Barcode ID:</strong> ${res.batch.referee_lot || (res.batch.lots ? res.batch.lots.referee : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-R' : 'N/A')}<br>
                            <strong>Vendor Lot Barcode ID:</strong> ${res.batch.vendor_lot || (res.batch.lots ? res.batch.lots.vendor : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-V' : 'N/A')}<br>
                            <strong>System Intake Samples Count:</strong> ${res.matching_trucks && res.matching_trucks.length > 0 ? res.matching_trucks.length : (Number(res.batch.system_samples_count) || 1)}<br>
                            <strong>Lab Confirmed Mixed Count:</strong> <strong style="color: var(--primary);">${res.matching_trucks && res.matching_trucks.length > 0 ? res.matching_trucks.length : (Number(res.batch.mixed_samples_count) || 1)}</strong><br><br>
                            
                            <strong>Mixed Intake Trucks:</strong><br>
                            ${trucksHtml || 'None'}
                        </div>
                        ${lab2ResultsHtml}
                    `;
                }
            } else {
                alert('Inspection failed: ' + res.message);
            }
        } catch (err) {
            alert('Lookup error: ' + err.message);
        }
    }

    // =========================================================================
    // TOP-MANAGEMENT EXECUTIVE DASHBOARD (NO ASH CONTENT, NO FINENESS)
    // =========================================================================
    let execChartInstances = {};

    async function initExecutiveDashboard() {
        const periodSelect = document.getElementById('exec-filter-period');
        const customDateContainer = document.getElementById('exec-custom-date-container');
        const startDateInput = document.getElementById('exec-filter-start-date');
        const endDateInput = document.getElementById('exec-filter-end-date');
        const companySelect = document.getElementById('exec-filter-company');
        const statusSelect = document.getElementById('exec-filter-status');
        const searchInput = document.getElementById('exec-filter-search');
        const refreshBtn = document.getElementById('exec-btn-refresh');
        const exportCsvBtn = document.getElementById('exec-btn-export-csv');
        const exportPdfBtn = document.getElementById('exec-btn-export-pdf');
        const themeToggleBtn = document.getElementById('exec-btn-theme-toggle');

        if (!periodSelect) return;

        // Toggle custom date container
        periodSelect.onchange = () => {
            if (periodSelect.value === 'custom') {
                if (customDateContainer) customDateContainer.style.display = 'block';
            } else {
                if (customDateContainer) customDateContainer.style.display = 'none';
            }
            renderExecutiveDashboardData();
        };

        if (startDateInput) startDateInput.onchange = renderExecutiveDashboardData;
        if (endDateInput) endDateInput.onchange = renderExecutiveDashboardData;
        if (companySelect) companySelect.onchange = renderExecutiveDashboardData;
        if (statusSelect) statusSelect.onchange = renderExecutiveDashboardData;
        if (searchInput) searchInput.oninput = renderExecutiveDashboardData;

        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '⏳ Syncing...';
                await renderExecutiveDashboardData(true);
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 Refresh Live Data';
            };
        }

        if (themeToggleBtn) {
            themeToggleBtn.onclick = () => {
                document.body.classList.toggle('light-theme');
                const isLight = document.body.classList.contains('light-theme');
                themeToggleBtn.textContent = isLight ? '🌙 Dark Mode' : '☀️ Light Mode';
                renderExecutiveDashboardData();
            };
        }

        if (exportCsvBtn) {
            exportCsvBtn.onclick = () => exportExecutiveCsv();
        }

        // Both buttons produce the same PDF: the officially formatted report for whatever is
        // currently filtered on the dashboard. (exportPdfBtn used to call bare window.print(),
        // which printed a blank page because it had no report content to show.)
        if (exportPdfBtn) {
            exportPdfBtn.onclick = () => generateFilteredDashboardReport();
        }

        const exportFilteredBtn = document.getElementById('exec-btn-export-filtered');
        if (exportFilteredBtn) {
            exportFilteredBtn.onclick = () => generateFilteredDashboardReport();
        }


        // Initial render
        await renderExecutiveDashboardData();
    }

    // Snapshot of the dashboard's currently filtered data, used by the filtered report export
    const execFilterSnapshot = { records: [], meta: null };

    // Builds an official report (same layout as Compiled Reports) for whatever
    // filter combination is currently applied on the dashboard.
    async function generateFilteredDashboardReport() {
        const rows = execFilterSnapshot.records || [];
        const meta = execFilterSnapshot.meta || {};

        if (rows.length === 0) {
            alert('No records match the current filters, so there is nothing to report.');
            return;
        }

        const num = (v) => (v !== null && v !== undefined && v !== '' && !isNaN(v)) ? Number(v) : null;
        const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;

        const accepted = rows.filter(r => r.acceptance_status === 'ACCEPTED');
        const rejected = rows.filter(r => r.acceptance_status === 'REJECTED');
        const totalNetKg = accepted.reduce((s, r) => s + (Number(r.net_weight_kg) || 0), 0);
        const avgMoisture = avg(rows.map(r => num(r.moisture_pct)).filter(v => v !== null));
        const avgFineness = avg(rows.map(r => num(r.fineness_value)).filter(v => v !== null));
        const avgGcv = avg(rows.map(r => num(r.gcv_value)).filter(v => v !== null));
        const avgAsh = avg(rows.map(r => num(r.ash_pct)).filter(v => v !== null));

        let rowHtml = '';
        rows.forEach(r => {
            const acceptanceLabel = r.acceptance_status === 'REJECTED'
                ? `<span style="color:red; font-weight:bold;">⛔ REJECTED (${r.rejection_reason || 'Moisture >14%'})</span>`
                : r.acceptance_status === 'CANCELLED' ? `<span style="color:#444; font-weight:bold;">🚫 QR CANCELLED (${esc(r.cancel_reason || '')})</span>`
                : r.acceptance_status === 'ACCEPTED' ? '<span style="color:green; font-weight:bold;">✅ ACCEPTED</span>' : 'Pending';
            const gcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : (num(r.gcv_value) !== null ? num(r.gcv_value) : 'Pending');
            const ashPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : (num(r.ash_pct) !== null ? num(r.ash_pct) + '%' : 'Pending');
            const vendorGcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : formatVendorGcvDisplay(r);
            const refereeGcvPrint = (r.acceptance_status === 'REJECTED' || r.acceptance_status === 'CANCELLED') ? ('N/A (' + r.acceptance_status + ')') : formatRefereeGcvDisplay(r);

            rowHtml += `
                <tr>
                    <td><strong>${r.truck_id || '-'}</strong></td>
                    <td>${r.company_name || '-'}</td>
                    <td>${r.truck_reg_number || '-'}</td>
                    <td>${r.invoice_no || r.challan_no || '-'}</td>
                    <td>${num(r.moisture_pct) !== null ? num(r.moisture_pct) + '%' : 'Pending'}</td>
                    <td>${num(r.fineness_value) !== null ? num(r.fineness_value) + '%' : 'Pending'}</td>
                    <td>${acceptanceLabel}</td>
                    <td>${((Number(r.net_weight_kg) || 0) / 1000).toFixed(3)}</td>
                    <td>${gcvPrint}</td>
                    <td>${ashPrint}</td>
                    <td>${vendorGcvPrint}</td>
                    <td>${refereeGcvPrint}</td>
                </tr>
            `;
        });

        const bodyHtml = `
            <div class="print-report-view">
                <div style="display: flex; align-items: center; justify-content: center; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 2px solid black; padding-bottom: 0.75rem;">
                    <img src="ntpc-logo.png" alt="" style="height: 50px;" onerror="this.style.display='none'">
                    <div style="text-align: left;">
                        <h1 style="font-size: 20pt; font-weight: bold; margin: 0; color: #000;">NTPC LIMITED</h1>
                        <h3 style="font-size: 11pt; font-weight: bold; letter-spacing: 0.05em; margin: 0; color: #444;">CHEMISTRY DEPARTMENT</h3>
                    </div>
                </div>

                <h2 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 1rem;">BIOMASS QUALITY REPORT — FILTERED SELECTION</h2>

                <div class="report-meta-info">
                    <div><strong>Supplier(s):</strong> ${esc(meta.company || 'All Suppliers')}</div>
                    <div><strong>Period:</strong> ${esc(meta.period || 'All Time')} (${esc(meta.range || '-')})</div>
                    <div><strong>Status Filter:</strong> ${esc(meta.status || 'All Statuses')}</div>
                    <div><strong>Search Filter:</strong> ${esc(meta.search || '—')}</div>
                    <div><strong>Generated At:</strong> ${new Date().toLocaleString()}</div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Truck ID</th>
                            <th>Supplier</th>
                            <th>Vehicle Reg</th>
                            <th>Invoice / Challan No.</th>
                            <th>Moisture %</th>
                            <th>Fineness %</th>
                            <th>Acceptance</th>
                            <th>Net Wt (MT)</th>
                            <th>GCV (kcal)</th>
                            <th>Ash %</th>
                            <th>Vendor GCV</th>
                            <th>Referee GCV</th>
                        </tr>
                    </thead>
                    <tbody>${rowHtml}</tbody>
                </table>

                <div class="print-summary-grid">
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Total Trucks</div>
                        <div class="print-summary-val">${rows.length}</div>
                    </div>
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Total Net Weight</div>
                        <div class="print-summary-val">${(totalNetKg / 1000).toFixed(2)} MT</div>
                    </div>
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Approved / Rejected</div>
                        <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">${accepted.length} / ${rejected.length}</div>
                    </div>
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Avg Moisture</div>
                        <div class="print-summary-val">${avgMoisture !== null ? avgMoisture.toFixed(2) + '%' : 'Pending'}</div>
                    </div>
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Avg Fineness</div>
                        <div class="print-summary-val">${avgFineness !== null ? avgFineness.toFixed(2) + '%' : 'Pending'}</div>
                    </div>
                    <div class="print-summary-card">
                        <div class="print-summary-lbl">Avg GCV / Ash</div>
                        <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">
                            ${avgGcv !== null ? Math.round(avgGcv) + ' kcal' : 'Pending'} /
                            ${avgAsh !== null ? avgAsh.toFixed(2) + '%' : 'Pending'}
                        </div>
                    </div>
                </div>

                <div class="print-signature-section">
                    <div class="print-signature-box">
                        <strong>Prepared By</strong><br>
                        <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                        <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                    </div>
                    <div class="print-signature-box">
                        <strong>Verified By</strong><br>
                        <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                        <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                    </div>
                </div>
            </div>
        `;

        const tag = shortCode(meta.company && meta.company !== 'All Suppliers' ? meta.company : 'All Suppliers');
        const filename = `Biomass_Report_${tag}_${window.BiomassAPI.todayIST().replace(/-/g, '')}`;
        const exportBtn = document.getElementById('exec-btn-export-pdf');
        const filteredBtn = document.getElementById('exec-btn-export-filtered');
        if (exportBtn) exportBtn.disabled = true;
        if (filteredBtn) filteredBtn.disabled = true;
        try {
            await printDocumentInFrame({ title: filename, bodyHtml, css: OFFICIAL_REPORT_PRINT_CSS });
        } finally {
            if (exportBtn) exportBtn.disabled = false;
            if (filteredBtn) filteredBtn.disabled = false;
        }
    }

    async function renderExecutiveDashboardData(forceFetch = false) {

        try {
            if (window.showGlobalLoader) window.showGlobalLoader('Loading Executive Management Dashboard...');

            // Fetch data from API
            const dashData = window.BiomassAPI.getAllDashboardData ? await window.BiomassAPI.getAllDashboardData() : { trucks: await window.BiomassAPI.getTrucks(), lab1: [], composites: [] };
            const trucks = dashData.trucks || [];
            const lab1Results = dashData.lab1 || [];
            const composites = dashData.composites || [];

            // Populate Company Dropdown if empty
            const companySelect = document.getElementById('exec-filter-company');
            if (companySelect && companySelect.options.length <= 1) {
                const companies = Array.from(new Set(trucks.map(t => t.company_name).filter(Boolean))).sort();
                companies.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c;
                    companySelect.appendChild(opt);
                });
            }

            // Create truck lookup map for Lab 1 & Composite Lab 2 results
            const lab1Map = {};
            if (Array.isArray(lab1Results)) {
                lab1Results.forEach(r => {
                    if (r.sample1_barcode_id) lab1Map[r.sample1_barcode_id] = r;
                });
            }

            const compMap = {};
            if (Array.isArray(composites)) {
                composites.forEach(c => {
                    let pIds = [];
                    if (Array.isArray(c.parent_truck_ids)) pIds = c.parent_truck_ids;
                    else if (typeof c.parent_truck_ids === 'string') {
                        try { pIds = JSON.parse(c.parent_truck_ids); } catch(e) {}
                    }
                    pIds.forEach(id => {
                        compMap[id] = c;
                    });
                });
            }

            // Combine truck records
            const records = trucks.map(t => {
                const l1 = lab1Map[t.sample1_barcode_id] || {};
                const c2 = compMap[t.truck_id] || {};
                const moisture = l1.moisture_pct !== undefined && l1.moisture_pct !== null && l1.moisture_pct !== "" ? Number(l1.moisture_pct) : (t.moisture_pct !== undefined && t.moisture_pct !== null ? Number(t.moisture_pct) : null);
                const fineness = l1.fineness_value !== undefined && l1.fineness_value !== null && l1.fineness_value !== "" ? Number(l1.fineness_value) : null;
                const nz = (v) => (v !== undefined && v !== null && v !== "") ? Number(v) : null;
                const gcv = c2.gcv_value !== undefined && c2.gcv_value !== null && c2.gcv_value !== "" ? Number(c2.gcv_value) : null;
                const ash = c2.ash_pct !== undefined && c2.ash_pct !== null && c2.ash_pct !== "" ? Number(c2.ash_pct) : null;
                const vendorGcv = c2.vendor_gcv !== undefined && c2.vendor_gcv !== null && c2.vendor_gcv !== "" ? Number(c2.vendor_gcv) : null;
                const refereeGcv = c2.referee_gcv !== undefined && c2.referee_gcv !== null && c2.referee_gcv !== "" ? Number(c2.referee_gcv) : null;
                const refereeStatus = c2.referee_status || null;
                const status = t.acceptance_status || (moisture !== null ? (moisture < 14.0 ? 'ACCEPTED' : 'REJECTED') : 'PENDING');
                
                let stage = 'Gate Registered';
                if (status === 'CANCELLED') stage = 'QR cancelled: ' + (t.cancel_reason || '');
                else if (status === 'REJECTED') stage = 'Rejected (Moisture Breach)';
                else if (c2.gcv_value) stage = 'Completed & Audited';
                else if (t.gross_weight && t.tare_weight) stage = 'Unloaded & Weighted';
                else if (moisture !== null) stage = 'Lab Moisture Tested';

                const netKg = Number(t.net_weight) || (Number(t.gross_weight) && Number(t.tare_weight) ? Math.max(0, Number(t.gross_weight) - Number(t.tare_weight)) : 0);
                const netMT = netKg / 1000.0;

                let rawDateStr = t.entry_date || t.date || t.timestamp || t.created_at;
                let parsedDate = rawDateStr ? new Date(rawDateStr) : new Date();
                if (isNaN(parsedDate.getTime())) parsedDate = new Date();

                return {
                    ...t,
                    moisture_pct: moisture,
                    fineness_value: fineness,
                    gcv_value: gcv,
                    ash_pct: ash,
                    tm: nz(c2.tm_value), x_factor: nz(c2.x_factor), ad_moisture: nz(c2.ad_moisture), ad_gcv: nz(c2.ad_gcv), ad_ash: nz(c2.ad_ash),
                    ad_sulphur: nz(c2.ad_sulphur), ad_vm: nz(c2.ad_vm), arb_sulphur: nz(c2.arb_sulphur), arb_vm: nz(c2.arb_vm),
                    vendor_gcv: vendorGcv,
                    referee_gcv: refereeGcv,
                    referee_status: refereeStatus,
                    acceptance_status: status,
                    pipeline_stage: stage,
                    net_weight_kg: netKg,
                    net_weight_mt: netMT,
                    date_obj: parsedDate
                };
            });

            // Calculate Live Operational Pipeline Counts (Unfiltered)
            const gateEl = document.getElementById('pipe-gate-count');
            const lab1El = document.getElementById('pipe-lab1-count');
            const weighEl = document.getElementById('pipe-weigh-count');
            const lab2El = document.getElementById('pipe-lab2-count');
            const compEl = document.getElementById('pipe-completed-count');

            if (gateEl) gateEl.textContent = records.filter(r => r.pipeline_stage === 'Gate Registered').length;
            if (lab1El) lab1El.textContent = records.filter(r => r.pipeline_stage === 'Lab Moisture Tested').length;
            if (weighEl) weighEl.textContent = records.filter(r => r.pipeline_stage === 'Unloaded & Weighted').length;
            if (lab2El) lab2El.textContent = records.filter(r => r.gcv_value === null && r.pipeline_stage === 'Unloaded & Weighted').length;
            if (compEl) compEl.textContent = records.filter(r => r.pipeline_stage === 'Completed & Audited').length;

            // Apply Filters (Date Range, Supplier, Status, Search)
            const period = document.getElementById('exec-filter-period')?.value || 'all';
            const compFilter = document.getElementById('exec-filter-company')?.value || 'ALL';
            const statusFilter = document.getElementById('exec-filter-status')?.value || 'ALL';
            const searchQuery = document.getElementById('exec-filter-search')?.value.toLowerCase().trim() || '';

            const now = new Date();
            let startBoundary = null;
            let endBoundary = null;

            if (period === 'today') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            } else if (period === 'yesterday') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
                endBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            } else if (period === 'last7') {
                startBoundary = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            } else if (period === 'this_month') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), 1);
            } else if (period === 'this_year') {
                startBoundary = new Date(now.getFullYear(), 0, 1);
            } else if (period === 'custom') {
                const sVal = document.getElementById('exec-filter-start-date')?.value;
                const eVal = document.getElementById('exec-filter-end-date')?.value;
                if (sVal) startBoundary = new Date(sVal + 'T00:00:00');
                if (eVal) endBoundary = new Date(eVal + 'T23:59:59');
            }

            const filteredRecords = records.filter(r => {
                if (startBoundary && r.date_obj < startBoundary) return false;
                if (endBoundary && r.date_obj > endBoundary) return false;
                if (compFilter !== 'ALL' && r.company_name !== compFilter) return false;
                if (statusFilter !== 'ALL' && r.acceptance_status !== statusFilter) return false;
                if (searchQuery) {
                    const matchText = `${r.truck_id} ${r.truck_reg_number} ${r.company_name} ${r.driver_name} ${r.invoice_no}`.toLowerCase();
                    if (!matchText.includes(searchQuery)) return false;
                }
                return true;
            });

            // Keep the current filtered slice available for the filtered report export
            execFilterSnapshot.records = filteredRecords;
            execFilterSnapshot.meta = {
                period: document.getElementById('exec-filter-period')?.selectedOptions[0]?.textContent || 'All Time',
                company: compFilter === 'ALL' ? 'All Suppliers' : compFilter,
                status: statusFilter === 'ALL' ? 'All Statuses' : statusFilter,
                search: searchQuery || '—',
                range: (startBoundary ? startBoundary.toLocaleDateString() : 'Beginning') + ' → ' + (endBoundary ? endBoundary.toLocaleDateString() : 'Today')
            };



            // Update Summary KPI Cards
            const totalCount = filteredRecords.length;
            const acceptedList = filteredRecords.filter(r => r.acceptance_status === 'ACCEPTED');
            const rejectedList = filteredRecords.filter(r => r.acceptance_status === 'REJECTED');
            
            const totalNetMT = acceptedList.reduce((sum, r) => sum + r.net_weight_mt, 0);
            const rejectedNetMT = rejectedList.reduce((sum, r) => sum + (r.net_weight_mt || 0), 0);
            const acceptRate = totalCount > 0 ? ((acceptedList.length / totalCount) * 100).toFixed(1) : '0.0';
            const rejectRate = totalCount > 0 ? ((rejectedList.length / totalCount) * 100).toFixed(1) : '0.0';

            const moistureVals = acceptedList.map(r => r.moisture_pct).filter(v => v !== null && !isNaN(v));
            const avgMoisture = moistureVals.length > 0 ? (moistureVals.reduce((a, b) => a + b, 0) / moistureVals.length).toFixed(2) : '0.00';

            const gcvVals = filteredRecords.map(r => r.gcv_value).filter(v => v !== null && !isNaN(v));
            const avgGCV = gcvVals.length > 0 ? Math.round(gcvVals.reduce((a, b) => a + b, 0) / gcvVals.length) : '0';

            const kpiNetEl = document.getElementById('kpi-net-weight-mt');
            const kpiTotEl = document.getElementById('kpi-total-trucks');
            const kpiBreakEl = document.getElementById('kpi-trucks-breakdown');
            const kpiAccEl = document.getElementById('kpi-acceptance-rate');
            const kpiRejEl = document.getElementById('kpi-rejection-rate');
            const kpiMoisEl = document.getElementById('kpi-avg-moisture');
            const kpiGcvEl = document.getElementById('kpi-avg-gcv');

            if (kpiNetEl) kpiNetEl.textContent = `${totalNetMT.toFixed(2)} MT`;
            if (kpiTotEl) kpiTotEl.textContent = totalCount;
            if (kpiBreakEl) kpiBreakEl.textContent = `${acceptedList.length} Accepted | ${rejectedList.length} Rejected (${rejectedNetMT.toFixed(2)} MT)`;
            if (kpiAccEl) kpiAccEl.textContent = `${acceptRate}%`;
            if (kpiRejEl) kpiRejEl.textContent = `Rejection Rate: ${rejectRate}%`;
            if (kpiMoisEl) kpiMoisEl.textContent = `${avgMoisture}%`;
            if (kpiGcvEl) kpiGcvEl.textContent = `${avgGCV} kcal/kg`;

            // Render Charts
            renderExecutiveCharts(filteredRecords);

            // Render Supplier Performance Table
            renderSupplierIntelligenceTable(filteredRecords);

            // Render Consignments Audit Table
            renderConsignmentsAuditTable(filteredRecords);

            if (window.hideGlobalLoader) window.hideGlobalLoader();
        } catch (err) {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
            console.error('Failed to render executive dashboard:', err);
        }
    }

    function renderExecutiveCharts(records) {
        if (typeof window.Chart === 'undefined') return;

        const isLight = document.body.classList.contains('light-theme');
        const textColor = isLight ? '#374151' : '#9ca3af';
        const gridColor = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';

        const chartPlugins = {
            legend: { labels: { color: textColor, font: { family: 'sans-serif', size: 11, weight: 'bold' } } },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                titleColor: '#ffffff',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(16, 185, 129, 0.3)',
                borderWidth: 1,
                padding: 10,
                boxPadding: 4,
                usePointStyle: true
            }
        };

        // Top 10 Suppliers by Tonnage Chart (Only retained chart)
        const compMap = {};
        records.forEach(r => {
            if (r.company_name) {
                if (!compMap[r.company_name]) compMap[r.company_name] = 0;
                if (r.acceptance_status === 'ACCEPTED') compMap[r.company_name] += (r.net_weight_mt || 0);
            }
        });
        const sortedSuppliers = Object.keys(compMap).sort((a, b) => compMap[b] - compMap[a]).slice(0, 10);
        const supplierTonnage = sortedSuppliers.map(s => Number(compMap[s].toFixed(2)));

        createOrUpdateChart('chart-supplier-tonnage', {
            type: 'bar',
            data: {
                labels: sortedSuppliers.length > 0 ? sortedSuppliers : ['No Data'],
                datasets: [{ label: 'Net Biomass (MT)', data: supplierTonnage, backgroundColor: 'rgba(59, 130, 246, 0.85)', borderRadius: 6 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor }, title: { display: true, text: 'Net Metric Tonnes (MT)', color: textColor } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }

    function createOrUpdateChart(canvasId, config) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        if (execChartInstances[canvasId]) {
            execChartInstances[canvasId].destroy();
        }
        execChartInstances[canvasId] = new window.Chart(ctx, config);
    }

    function renderSupplierIntelligenceTable(records) {
        const tbody = document.getElementById('exec-supplier-table-body');
        if (!tbody) return;

        const groups = {};
        records.forEach(r => {
            const name = r.company_name || 'Unknown Supplier';
            if (!groups[name]) {
                groups[name] = { name, total: 0, accepted: 0, rejected: 0, netMT: 0, moistureList: [], gcvList: [] };
            }
            groups[name].total++;
            if (r.acceptance_status === 'ACCEPTED') {
                groups[name].accepted++;
                groups[name].netMT += r.net_weight_mt;
            } else if (r.acceptance_status === 'REJECTED') {
                groups[name].rejected++;
            }
            if (r.moisture_pct !== null) groups[name].moistureList.push(r.moisture_pct);
            if (r.gcv_value !== null) groups[name].gcvList.push(r.gcv_value);
        });

        const list = Object.values(groups).sort((a, b) => b.total - a.total);

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No supplier records match filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(g => {
            const acceptPct = ((g.accepted / g.total) * 100).toFixed(1);
            const rejectPct = ((g.rejected / g.total) * 100).toFixed(1);
            const avgM = g.moistureList.length > 0 ? (g.moistureList.reduce((a, b) => a + b, 0) / g.moistureList.length).toFixed(2) + '%' : '-';
            const avgG = g.gcvList.length > 0 ? Math.round(g.gcvList.reduce((a, b) => a + b, 0) / g.gcvList.length) + ' kcal/kg' : '-';

            return `
                <tr>
                    <td><strong>${g.name}</strong></td>
                    <td>${g.total}</td>
                    <td><span class="badge badge-complete">${g.accepted}</span></td>
                    <td><span class="badge badge-rejected">${g.rejected}</span></td>
                    <td><strong style="color: #10b981;">${acceptPct}%</strong></td>
                    <td><strong style="color: #ef4444;">${rejectPct}%</strong></td>
                    <td>${avgM}</td>
                    <td>${avgG}</td>
                    <td><strong>${g.netMT.toFixed(2)} MT</strong></td>
                </tr>
            `;
        }).join('');
    }

    function renderConsignmentsAuditTable(records) {
        const tbody = document.getElementById('exec-consignments-table-body');
        const countInfo = document.getElementById('exec-table-count-info');
        if (!tbody) return;

        if (countInfo) countInfo.textContent = `Showing ${records.length} consignments`;

        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="14" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No consignments match current filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = records.slice(0, 50).map(r => {
            const dateStr = r.date_obj ? r.date_obj.toISOString().substring(0, 10) : (r.date || '-');
            const statusBadge = r.acceptance_status === 'ACCEPTED' ? 
                '<span class="badge badge-complete">ACCEPTED</span>' : 
                (r.acceptance_status === 'REJECTED' ? '<span class="badge badge-rejected">REJECTED</span>'
                    : r.acceptance_status === 'CANCELLED' ? `<span class="status-cancelled" title="${esc(r.cancel_reason || '')}">🚫 QR CANCELLED</span><br><small>${esc(r.cancel_reason || '')}</small>`
                    : '<span class="badge badge-pending">PENDING</span>');

            return `
                <tr>
                    <td>${dateStr}</td>
                    <td>${r.invoice_no || r.challan_no || '-'}</td>
                    <td><strong>${r.company_name || '-'}</strong></td>
                    <td>${r.truck_reg_number || r.truck_id || '-'}</td>
                    <td>${r.driver_name || '-'}</td>
                    <td>${r.gross_weight ? r.gross_weight + ' kg' : '-'}</td>
                    <td>${r.tare_weight ? r.tare_weight + ' kg' : '-'}</td>
                    <td><strong>${r.net_weight_mt > 0 ? r.net_weight_mt.toFixed(2) + ' MT' : '-'}</strong></td>
                    <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : '-'}</td>
                    <td>${r.tm !== null && r.tm !== undefined ? r.tm.toFixed(2) + '%' : '-'}</td>
                    <td>${r.gcv_value ? r.gcv_value + ' kcal/kg' : '-'}</td>
                    <td>${r.ash_pct !== null && r.ash_pct !== undefined ? r.ash_pct + '%' : '-'}</td>
                    <td>${statusBadge}</td>
                    <td><span class="badge badge-info">${r.pipeline_stage}</span></td>
                </tr>
            `;
        }).join('');
    }

    // Professional formatted .xlsx export — pulls straight from the dashboard's own
    // filtered record set (not scraped from the on-screen table), so every field the
    // dashboard knows about (including Ash %, Vendor GCV, Referee GCV) is included.
    async function exportExecutiveCsv() {
        if (typeof ExcelJS === 'undefined') {
            alert('Excel export library failed to load. Please check your internet connection and try again.');
            return;
        }

        await renderExecutiveDashboardData();
        const rows = execFilterSnapshot.records || [];
        const meta = execFilterSnapshot.meta || {};

        if (rows.length === 0) {
            alert('No records match the current filters, so there is nothing to export.');
            return;
        }

        const columns = [
            { header: 'Date',            width: 12 },
            { header: 'Challan / Invoice', width: 16 },
            { header: 'Supplier',        width: 22 },
            { header: 'Lot',             width: 9  },
            { header: 'PO No.',          width: 13 },
            { header: 'Truck Reg No.',   width: 14 },
            { header: 'Driver',          width: 16 },
            { header: 'Gross Wt (kg)',   width: 12 },
            { header: 'Tare Wt (kg)',    width: 12 },
            { header: 'Net Wt (MT)',     width: 12 },
            { header: 'Moisture % (truck)', width: 12 },
            { header: 'TM % (mean moisture)', width: 13 },
            { header: 'Fineness %',      width: 11 },
            { header: 'AD Moisture %',   width: 11 },
            { header: 'AD GCV',          width: 10 },
            { header: 'AD Ash %',        width: 10 },
            { header: 'AD Sulphur % (Lot-4)', width: 12 },
            { header: 'AD VM % (Lot-4)', width: 11 },
            { header: 'X factor',        width: 10 },
            { header: 'ARB GCV (kcal/kg)', width: 13 },
            { header: 'ARB Ash %',       width: 10 },
            { header: 'ARB Sulphur % (Lot-4)', width: 12 },
            { header: 'ARB VM % (Lot-4)', width: 11 },
            { header: 'Vendor GCV',      width: 16 },
            { header: 'Referee GCV',     width: 18 },
            { header: 'Acceptance',      width: 12 },
            { header: 'Pipeline Stage',  width: 20 }
        ];

        const wb = new ExcelJS.Workbook();
        wb.creator = 'BiomassBlind';
        wb.created = new Date();

        const sheet = wb.addWorksheet('Executive Report', {
            views: [{ state: 'frozen', ySplit: 4 }]
        });

        // Title band
        sheet.mergeCells(1, 1, 1, columns.length);
        const titleCell = sheet.getCell(1, 1);
        titleCell.value = 'Biomass Procurement — Executive Quality Report';
        titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        sheet.getRow(1).height = 28;
        for (let c = 1; c <= columns.length; c++) {
            sheet.getCell(1, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
        }

        // Filter/meta subtitle band
        sheet.mergeCells(2, 1, 2, columns.length);
        const subtitleCell = sheet.getCell(2, 1);
        subtitleCell.value = `Supplier: ${meta.company || 'All Suppliers'}    |    Period: ${meta.period || 'All Time'} (${meta.range || '-'})    |    Status: ${meta.status || 'All Statuses'}    |    Generated: ${new Date().toLocaleString()}`;
        subtitleCell.font = { italic: true, size: 10, color: { argb: 'FF374151' } };
        subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        sheet.getRow(2).height = 20;
        for (let c = 1; c <= columns.length; c++) {
            sheet.getCell(2, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
        }

        sheet.getRow(3).height = 6; // spacer row

        // Header row
        const headerRowIdx = 4;
        columns.forEach((col, i) => {
            const cell = sheet.getCell(headerRowIdx, i + 1);
            cell.value = col.header;
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            sheet.getColumn(i + 1).width = col.width;
        });
        sheet.getRow(headerRowIdx).height = 24;

        // Data rows
        let r = headerRowIdx + 1;
        rows.forEach(rec => {
            const isRejected = rec.acceptance_status === 'REJECTED' || rec.acceptance_status === 'CANCELLED';
            const dateStr = rec.date_obj ? window.BiomassAPI.formatLocalYYYYMMDD(rec.date_obj) : (rec.entry_date || '-');
            const rowVals = [
                dateStr,
                rec.invoice_no || rec.challan_no || '-',
                rec.company_name || '-',
                rec.lot || '-',
                rec.po_number || '-',
                rec.truck_reg_number || '-',
                rec.driver_name || '-',
                Number(rec.gross_weight) || 0,
                Number(rec.tare_weight) || 0,
                Number(rec.net_weight_mt || 0).toFixed(3),
                rec.moisture_pct !== null ? rec.moisture_pct : 'Pending',
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.tm !== null && rec.tm !== undefined ? Number(rec.tm.toFixed(2)) : 'Pending'),
                rec.fineness_value !== null ? rec.fineness_value : 'Pending',
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.ad_moisture !== null && rec.ad_moisture !== undefined ? rec.ad_moisture : '-'),
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.ad_gcv !== null && rec.ad_gcv !== undefined ? rec.ad_gcv : '-'),
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.ad_ash !== null && rec.ad_ash !== undefined ? rec.ad_ash : '-'),
                rec.lot === 'LOT4' ? (rec.ad_sulphur !== null && rec.ad_sulphur !== undefined ? rec.ad_sulphur : 'Pending') : '-',
                rec.lot === 'LOT4' ? (rec.ad_vm !== null && rec.ad_vm !== undefined ? rec.ad_vm : 'Pending') : '-',
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.x_factor !== null && rec.x_factor !== undefined ? Number(rec.x_factor.toFixed(6)) : '-'),
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.gcv_value !== null ? rec.gcv_value : 'Pending'),
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : (rec.ash_pct !== null ? rec.ash_pct : 'Pending'),
                rec.lot === 'LOT4' ? (rec.arb_sulphur !== null && rec.arb_sulphur !== undefined ? rec.arb_sulphur : 'Pending') : '-',
                rec.lot === 'LOT4' ? (rec.arb_vm !== null && rec.arb_vm !== undefined ? rec.arb_vm : 'Pending') : '-',
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : formatVendorGcvDisplay(rec),
                isRejected ? ('N/A (' + rec.acceptance_status + ')') : formatRefereeGcvDisplay(rec),
                rec.acceptance_status || 'PENDING',
                rec.pipeline_stage || '-'
            ];
            rowVals.forEach((val, i) => {
                const cell = sheet.getCell(r, i + 1);
                cell.value = val;
                cell.border = { top: { style: 'hair' }, left: { style: 'hair' }, bottom: { style: 'hair' }, right: { style: 'hair' } };
                cell.alignment = { vertical: 'middle', horizontal: i <= 5 ? 'left' : 'center' };
                if (isRejected) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
                else if (r % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
            });
            r++;
        });

        sheet.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: columns.length } };

        // Summary block
        r += 1;
        const accepted = rows.filter(x => x.acceptance_status === 'ACCEPTED');
        const rejected = rows.filter(x => x.acceptance_status === 'REJECTED');
        const totalNetMT = accepted.reduce((s, x) => s + (x.net_weight_mt || 0), 0);
        const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const avgMoisture = avg(rows.map(x => x.moisture_pct).filter(v => v !== null && v !== undefined));
        const avgFineness = avg(rows.map(x => x.fineness_value).filter(v => v !== null && v !== undefined));
        const avgGcv = avg(rows.map(x => x.gcv_value).filter(v => v !== null && v !== undefined));
        const avgAsh = avg(rows.map(x => x.ash_pct).filter(v => v !== null && v !== undefined));

        sheet.mergeCells(r, 1, r, columns.length);
        const summaryTitle = sheet.getCell(r, 1);
        summaryTitle.value = 'Summary';
        summaryTitle.font = { bold: true, size: 12 };
        summaryTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
        r++;

        [
            ['Total Trucks', rows.length],
            ['Accepted / Rejected', `${accepted.length} / ${rejected.length}`],
            ['Accepted Net Weight (MT)', Number(totalNetMT.toFixed(2))],
            ['Rejected Net Weight (MT)', Number(rejected.reduce((a, x) => a + (x.net_weight_mt || 0), 0).toFixed(2))],
            ['Avg Moisture % (trucks)', avgMoisture !== null ? Number(avgMoisture.toFixed(2)) : 'Pending'],
            ['Avg Fineness %', avgFineness !== null ? Number(avgFineness.toFixed(2)) : 'Pending'],
            ['Avg GCV (kcal/kg)', avgGcv !== null ? Math.round(avgGcv) : 'Pending'],
            ['Avg Ash %', avgAsh !== null ? Number(avgAsh.toFixed(2)) : 'Pending']
        ].forEach(([label, val]) => {
            sheet.getCell(r, 1).value = label;
            sheet.getCell(r, 1).font = { bold: true };
            sheet.getCell(r, 2).value = val;
            r++;
        });

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Executive_Biomass_Report_${new Date().toISOString().substring(0, 10)}.xlsx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // Initialize Executive Dashboard when Admin switches to admin-dashboard tab
    const dashTabBtn = document.getElementById('tab-btn-dashboard');
    if (dashTabBtn) {
        dashTabBtn.addEventListener('click', () => {
            initExecutiveDashboard();
        });
    }

    // ================= CORE RUNNER ON LOAD =================
    routeSession();
    // a signed-in session that was left open: is this computer still approved for the login? (the lock may have been switched on meanwhile)
    if (window.BiomassAPI.getCurrentUser()) window.BiomassAPI.deviceCheck().then(r => { if (r && r.lock && !r.verified) routeSession(); }).catch(() => { /* ignore */ });
    try {   // message left by hardSignOut() (session could not be renewed) - shown on the fresh login screen
        const flash = sessionStorage.getItem('BIOMASS_FLASH');
        if (flash) {
            sessionStorage.removeItem('BIOMASS_FLASH');
            if (!window.BiomassAPI.getCurrentUser()) { loginAlert.textContent = flash; loginAlert.style.display = 'flex'; }
        }
    } catch (e) { /* storage unavailable */ }
    if (sessionStorage.getItem('auth_role') === 'admin') {
        initExecutiveDashboard();
    }
});
