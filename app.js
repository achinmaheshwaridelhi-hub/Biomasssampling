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

    // Encrypts a payload JSON object to an opaque string prefixed with BSW1:
    async function encryptPayload(plainId, issuedAtOverride = null) {
        if (!window.crypto || !window.crypto.subtle) {
            return fallbackEncrypt(plainId);
        }
        try {
            const key = await getCryptoKey();
            const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit standard IV
            const payloadObj = {
                id: plainId,
                issuedAt: issuedAtOverride || Date.now()
            };
            const plainText = JSON.stringify(payloadObj);
            const encodedText = new TextEncoder().encode(plainText);
            
            const ciphertextBuffer = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                encodedText
            );
            
            const ciphertextBytes = new Uint8Array(ciphertextBuffer);
            const combined = new Uint8Array(iv.length + ciphertextBytes.length);
            combined.set(iv, 0);
            combined.set(ciphertextBytes, iv.length);
            
            return 'BSW1:' + bytesToBase64Url(combined);
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
    function downloadQrAsPng(canvasSelector, filename, headerText, plainId, identifiable) {
        const canvasElement = document.querySelector(canvasSelector);
        if (!canvasElement) {
            alert('QR sticker element not found.');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 720;
            
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
            
            // 2. Draw QR code image MUCH BIGGER (480x480) with clean white quiet zone
            const qrSize = 480;
            const qrX = (canvas.width - qrSize) / 2;
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
                        const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
                        const page = await pdf.getPage(1);
                        
                        const canvas = document.createElement('canvas');
                        const viewport = page.getViewport({ scale: 2.5 }); // Sharp scale for barcode decoding
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        
                        const context = canvas.getContext('2d');
                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        canvas.toBlob(async (blob) => {
                            const tempFile = new File([blob], "scanned-page.png", { type: "image/png" });
                            const tempReader = new Html5Qrcode(qrReaderId);
                            try {
                                const decodedText = await tempReader.scanFile(tempFile, false);
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
                    const rawReader = new Html5Qrcode(qrReaderId);
                    // Pass 1: Try Html5Qrcode scanFile with internal scaling (renderImage = true) directly on the file
                    const directText = await rawReader.scanFile(file, true);
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
                const tempScanner = new Html5Qrcode(cfg.readerId);
                const decodedText = await tempScanner.scanFile(file, false);
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
                    const tempScanner = new Html5Qrcode(cfg.readerId);
                    const decodedText = await tempScanner.scanFile(blob, false);
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
                const tempScanner = new Html5Qrcode(cfg.readerId);
                decodedText = await tempScanner.scanFile(file, true);
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


    // ================= AFTER WEIGHMENT / UNLOADING AREA =================
    function initUnloadingScreen() {
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
            const plainId = /^BSW1F?:/.test(trimmedCode) ? await processScannedCode(trimmedCode) : trimmedCode;
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
                        Moisture passed (<strong>${res.moisture_pct}%</strong> is below the ${res.moisture_limit}% limit). Proceed with biomass unloading.<br>
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
                        Moisture level is <strong>${res.moisture_pct}%</strong> (Maximum allowed: ${res.moisture_limit}%). Net weight is recorded as 0. Do not unload this truck.<br>
                        <button type="button" class="btn btn-secondary btn-sm mt-2" onclick="window.openTruckWeighmentSlip('${res.truck_id}')" style="background:#dc2626; color:white; border:none;">🖨️ Print Rejection Slip</button>
                    `;
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
                ['Supplier', esc(res.company_name)],
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

        // Setup Header
        appHeader.style.display = 'flex';
        displayUserName.textContent = user.name;
        displayUserRole.textContent = user.role;

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

        showGlobalLoader('Authenticating credentials & loading dashboard...');

        try {
            // The password goes to Supabase Auth over HTTPS (never hashed client-side, never put in a URL).
            const res = await window.BiomassAPI.login(username, password);
            if (res.success) {
                routeSession();
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

    function initAdminDashboard(role) {
        const tabs = document.querySelectorAll('#screen-admin .tab-btn');
        const tabContents = document.querySelectorAll('#screen-admin .tab-content');

        // Apply menu item visibility based on role (Entry Operator sees ONLY registration, Weighment sees ONLY weighment)
        tabs.forEach(tab => {
            const dataTab = tab.getAttribute('data-tab');
            if (role === 'entry') {
                if (dataTab !== 'admin-register') {
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
            } else {
                tab.style.display = 'flex'; // admin sees everything
            }
        });

        // Force other tab contents to hide completely
        tabContents.forEach(content => {
            const id = content.getAttribute('id');
            if (role === 'entry') {
                if (id !== 'tab-admin-register') {
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

        if (role === 'admin' || role === 'entry') {
            loadRecentRegistrations();
        }

        if (role === 'admin') {
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
            // SECURITY: Block tab clicking for Entry Operator and Weighment Operator roles
            if (role === 'entry' || role === 'weighment') {
                e.preventDefault();
                return;
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
            } else if (targetContentId === 'tab-admin-weighment') {
                renderWeighmentLog();
            } else if (targetContentId === 'tab-admin-reports') {
                loadReportSelectors();
            } else if (targetContentId === 'tab-admin-inspector') {
                initAdminInspectorTab();
            } else if (targetContentId === 'tab-admin-referee') {
                loadRefereeChallengeTable();
            } else if (targetContentId === 'tab-admin-activity') {
                renderActivityLogTab();
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
            
            if (compSelect) compSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';
            if (reportSelect) reportSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';
            if (commSelect) commSelect.innerHTML = '<option value="ALL">All Suppliers / Consolidated</option>';

            sortedCompanies.forEach(company => {
                // Datalist options
                const opt = document.createElement('option');
                opt.value = company;
                datalist.appendChild(opt);

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
                    errorCorrectionLevel: 'H',
                    width: 180,
                    margin: 2
                }, function(err) {
                    if (err) console.error('QR canvas rendering error:', err);
                });
            }

            if (btnPrint) {
                btnPrint.onclick = async function() {
                    const printContainer = document.getElementById('print-section');
                    if (!printContainer) return;
                    printContainer.innerHTML = `
                        <div class="print-label-view" style="text-align: center;">
                            <div>
                                <canvas id="print-qr-target"></canvas>
                            </div>
                        </div>
                    `;
                    QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                        errorCorrectionLevel: 'H', width: 230, margin: 2
                    }, function(err) {
                        if (err) console.error(err);
                        setTimeout(() => { window.print(); }, 200);
                    });
                };
            }

            if (btnDownload) {
                btnDownload.onclick = function() {
                    downloadQrAsPng('#qr-canvas-admin-lookup', `Sample_1_${truck.sample1_barcode_id}`, '', truck.sample1_barcode_id, false);
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

            const data = {
                company_name: document.getElementById('reg-company').value.trim(),
                driver_name: document.getElementById('reg-driver').value.trim(),
                truck_reg_number: vehicle,
                invoice_no: document.getElementById('reg-invoice').value.trim(),
                gross_weight: 0,
                tare_weight: 0,
                photo_url: capturedPhotoBase64
            };

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
                        errorCorrectionLevel: 'H',
                        width: 180,
                        margin: 2
                    }, function(err) {
                        if (err) console.error('QR code generation failed:', err);
                    });
                }

                const resBox = document.getElementById('admin-barcodes-result');
                if (resBox) resBox.style.display = 'block';
                
                // Attach print & download triggers (Only S1 QR)
                setupBarcodePrintTriggers(truck.sample1_barcode_id, truck.daily_group_code);

                // Clean registration form
                truckRegForm.reset();
                
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
            } catch (err) {
                console.error('Registration failed:', err);
                alert('Registration failed: ' + (err && err.message ? err.message : err));
            }
        });
    }

    // Helper: set print & download layout trigger buttons (Strict 50mm x 50mm Thermal Label)
    function setupBarcodePrintTriggers(s1Id, dailyGroupCode) {
        const printContainer = document.getElementById('print-section');
        const btnPrint = document.getElementById('btn-print-s1');
        const btnDownload = document.getElementById('btn-download-s1');

        if (btnPrint) {
            btnPrint.onclick = async function() {
                const encrypted = await encryptPayload(s1Id);
                if (printContainer) {
                    printContainer.innerHTML = `
                        <div class="print-label-view print-label-50mm" style="text-align: center;">
                            <canvas id="print-qr-target"></canvas>
                            <div class="print-label-id" style="font-family: monospace; font-size: 8pt; font-weight: bold; margin-top: 1mm;">${s1Id}</div>
                        </div>
                    `;
                }
                const printTarget = document.getElementById('print-qr-target');
                if (printTarget) {
                    QRCode.toCanvas(printTarget, encrypted, {
                        errorCorrectionLevel: 'M',
                        width: 140,
                        margin: 1
                    }, function(err) {
                        if (err) console.error(err);
                        document.body.classList.add('printing-label');
                        setTimeout(() => { 
                            window.print(); 
                            document.body.classList.remove('printing-label');
                        }, 250);
                    });
                }
            };
        }
 
        // Download as PNG button
        if (btnDownload) {
            btnDownload.onclick = function() {
                downloadQrAsPng(
                    '#qr-canvas-s1', 
                    `Sample_1_${s1Id}`, 
                    '',
                    s1Id
                );
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
                const comp = String(t.company_name || '').toLowerCase();
                const reg = String(t.truck_reg_number || '').toLowerCase();
                const matchesSearch = id.includes(filter) || comp.includes(filter) || reg.includes(filter);

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
                if (truck.acceptance_status === 'REJECTED') {
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

    async function renderUnloadingLog() {
        const tbody = document.getElementById('table-unloading-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">Loading unloading entries...</td></tr>';
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
                const comp = String(t.company_name || '').toLowerCase();
                return id.includes(filter) || driver.includes(filter) || reg.includes(filter) || ch.includes(filter) || comp.includes(filter);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="10" style="text-align: center;">No matching truck entries found for today.</td></tr>`;
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
                    <td>${esc(truck.company_name)}</td>
                    <td><span style="font-family: monospace; font-weight: bold;">${esc(truck.truck_reg_number)}</span></td>
                    <td><span style="font-family: monospace;">${esc(chNo)}</span></td>
                    <td>${gross > 0 ? gross.toLocaleString() : '-'}</td>
                    <td>${tare > 0 ? tare.toLocaleString() : '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${tare > 0 ? net.toLocaleString() : '-'}</td>
                    <td>${moistureStr}</td>
                    <td>${statusBadge}</td>
                    <td><button type="button" class="btn btn-secondary btn-sm" onclick="window.openTruckWeighmentSlip('${esc(truck.truck_id)}')" title="View & Print Slip">🖨️ Slip</button></td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger);">Failed to load unloading log: ${esc(e.message)}</td></tr>`;
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
                const qrUrl = await new Promise(resolve => QRCode.toDataURL(truckToken, { width: 110, margin: 1, errorCorrectionLevel: 'M' }, (e, u) => resolve(e ? '' : u)));
                if (qrUrl) truckQrImg = `<img src="${qrUrl}" alt="Truck QR" style="width: 84px; height: 84px; float: right; margin-left: 0.75rem;">`;
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
                        <div class="slip-cell" style="grid-column: span 2;">
                            <label>Supplier / Vendor</label>
                            <div class="slip-val">${esc(truck.company_name)}</div>
                        </div>
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
                                <td>Net Biomass Delivered</td>
                                <td style="font-size: 1.15rem; color: #0284c7;">${tare > 0 ? net.toLocaleString() + ' kg (' + (net/1000).toFixed(2) + ' MT)' : '—'}</td>
                                <td>${status === 'REJECTED' ? 'REJECTED (Net 0 kg)' : (tare > 0 ? 'Discharged' : 'Pending')}</td>
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

            const filename = `Weighment_Slip_${truck.truck_id}_${shortCode(truck.company_name)}_${compactDate(truck.entry_date)}`;
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
        document.getElementById('weigh-edit-title').textContent = `Update Weighment logs for [${id}]`;
        
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
            
            const gcvVal = report.summary.avg_gcv !== null ? `${report.summary.avg_gcv} kcal` : 'Pending';
            const ashVal = report.summary.avg_ash !== null ? `${report.summary.avg_ash}%` : 'Pending';
            document.getElementById('summary-avg-composite').textContent = `${gcvVal} / ${ashVal}`;

            // Populate rows
            const tbody = document.getElementById('report-rows-body');
            tbody.innerHTML = '';

            report.rows.forEach(row => {
                const tr = document.createElement('tr');

                let acceptanceBadge = '';
                if (row.acceptance_status === 'REJECTED') {
                    acceptanceBadge = `<span class="badge badge-danger" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">⛔ REJECTED</span><br><small style="color:#ef4444; font-size:0.75rem;">${row.rejection_reason || 'Moisture >14%'}</small>`;
                    tr.style.background = 'rgba(239, 68, 68, 0.12)';
                } else if (row.acceptance_status === 'ACCEPTED') {
                    acceptanceBadge = `<span class="badge badge-success" style="background:#10b981; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ ACCEPTED</span>`;
                } else {
                    acceptanceBadge = `<span class="badge badge-warning" style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px;">⏳ Pending Lab 1</span>`;
                }

                const gcvText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : (row.gcv_value !== null ? row.gcv_value + ' kcal' : '<span class="badge badge-pending">Pending</span>');
                const ashText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : (row.ash_pct !== null ? row.ash_pct + '%' : '<span class="badge badge-pending">Pending</span>');
                const vendorGcvText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : formatVendorGcvDisplay(row);
                const refereeGcvText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : formatRefereeGcvDisplay(row);

                tr.innerHTML = `
                    <td><strong>${row.truck_id}</strong></td>
                    <td><span style="font-family: monospace;">${row.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${row.invoice_no || row.challan_no || '-'}</span></td>
                    <td style="font-weight: 500;">${row.moisture_pct !== null ? row.moisture_pct + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="font-weight: 500;">${row.fineness_value !== null ? row.fineness_value + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td>${acceptanceBadge}</td>
                    <td><span class="badge badge-referee" style="font-weight: bold;">${row.mixing_group_code || 'N/A'}</span></td>
                    <td style="font-weight: 500;">${gcvText}</td>
                    <td style="font-weight: 500;">${ashText}</td>
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
                    : r.acceptance_status === 'ACCEPTED' ? '<span style="color:green; font-weight:bold;">✅ ACCEPTED</span>' : 'Pending';
                const chNo = r.invoice_no || r.challan_no || '-';
                const gcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (r.gcv_value !== null ? r.gcv_value : 'Pending');
                const ashPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (r.ash_pct !== null ? r.ash_pct + '%' : 'Pending');
                const vendorGcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : formatVendorGcvDisplay(r);
                const refereeGcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : formatRefereeGcvDisplay(r);

                rowHtml += `
                    <tr>
                        <td><strong>${r.truck_id}</strong></td>
                        <td>${r.truck_reg_number}</td>
                        <td>${chNo}</td>
                        <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : 'Pending'}</td>
                        <td>${r.fineness_value !== null ? r.fineness_value + '%' : 'Pending'}</td>
                        <td>${acceptanceLabel}</td>
                        <td>${r.mixing_group_code || 'N/A'}</td>
                        <td>${gcvPrint}</td>
                        <td>${ashPrint}</td>
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
                                <th>GCV (kcal)</th>
                                <th>Ash %</th>
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
                            <div class="print-summary-lbl">Avg Moisture</div>
                            <div class="print-summary-val">${report.summary.avg_moisture !== null ? report.summary.avg_moisture + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg Fineness</div>
                            <div class="print-summary-val">${report.summary.avg_fineness !== null ? report.summary.avg_fineness + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg GCV / Ash</div>
                            <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">
                                ${report.summary.avg_gcv !== null ? report.summary.avg_gcv + ' kcal' : 'Pending'} / 
                                ${report.summary.avg_ash !== null ? report.summary.avg_ash + '%' : 'Pending'}
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

    async function renderActivityLogTab() {
        const activityBody = document.getElementById('activity-log-body');
        const exceptionsBody = document.getElementById('exceptions-log-body');
        
        activityBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading activity log...</td></tr>';
        exceptionsBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading exception logs...</td></tr>';
        
        try {
            const logs = await window.BiomassAPI.getActivityLogs();
            activityBody.innerHTML = '';
            exceptionsBody.innerHTML = '';
            
            const generalLogs = [];
            const exceptionLogs = [];
            
            logs.forEach(log => {
                const isException = 
                    log.action.toLowerCase().includes('exception') || 
                    log.action.toLowerCase().includes('reissue') || 
                    log.action.toLowerCase().includes('lockout') || 
                    log.details.toLowerCase().includes('fail') || 
                    log.details.toLowerCase().includes('expired') || 
                    log.details.toLowerCase().includes('tampered');
                
                if (isException) {
                    exceptionLogs.push(log);
                }
                generalLogs.push(log); // Keep everything in general log for complete auditing
            });
            
            // Render general logs
            if (generalLogs.length === 0) {
                activityBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No activity logs recorded.</td></tr>';
            } else {
                generalLogs.forEach(log => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="font-family: monospace; font-size: 0.85rem;">${esc(log.timestamp)}</td>
                        <td><span class="user-role" style="background: rgba(59, 130, 246, 0.15); color: var(--secondary); padding: 0.1rem 0.4rem; border-radius: 4px;">${esc(log.username)}</span></td>
                        <td><strong>${esc(log.action)}</strong></td>
                        <td style="font-size: 0.85rem;">${esc(log.details)}</td>
                    `;
                    activityBody.appendChild(tr);
                });
            }
            
            // Render exceptions
            if (exceptionLogs.length === 0) {
                exceptionsBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No critical exceptions or security violations flagged.</td></tr>';
            } else {
                exceptionLogs.forEach(log => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="font-family: monospace; font-size: 0.85rem; color: #ef4444;">${esc(log.timestamp)}</td>
                        <td><span class="user-role" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; padding: 0.1rem 0.4rem; border-radius: 4px;">${esc(log.username)}</span></td>
                        <td><strong style="color: #ef4444;">${esc(log.action)}</strong></td>
                        <td style="font-size: 0.85rem; font-weight: 500;">${esc(log.details)}</td>
                    `;
                    exceptionsBody.appendChild(tr);
                });
            }
        } catch (e) {
            activityBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load logs: ${esc(e.message)}</td></tr>`;
            exceptionsBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load exceptions: ${esc(e.message)}</td></tr>`;
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
    const AUTO_READ_MAX_ATTEMPTS = 5;

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
                    ? '⚠️ The reader is not sure about this number, so it cannot be used. Please retake the photo.'
                    : 'Does this exactly match the number on the ' + cfg.deviceName + '?';
                el('btn-' + key + '-accept').style.display = p.uncertain ? 'none' : '';
            }
        }

        function reset() {
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
            if (st.attempts >= AUTO_READ_MAX_ATTEMPTS && !(st.pending && !st.pending.uncertain)) {
                goManual('All ' + AUTO_READ_MAX_ATTEMPTS + ' automatic attempts were used without an accepted reading.');
                return;
            }
            apply();
        }

        async function accept() {
            const p = st.pending;
            if (!p || p.uncertain || st.busy) return;
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
            cfg.onAccept(Number(p.value));
            st.mode = 'accepted';
            st.pending = null;
            autoMsg('');
            const status = part('photo-status');
            if (status) { status.textContent = '📸 Auto-read ' + p.value + ' ' + unit + ' (confirmed)'; status.className = 'badge badge-success'; }
            statusMsg('Value read from the display photo and confirmed by the operator. Photo attached for supervisor audit.', '#10b981');
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
            onAccept: (n) => { moistureState.reading = n; moistureState.scaleType = 'Auto-read (operator confirmed)'; }
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
        // 0. Auto-read (camera -> reader -> operator confirms) for moisture and both fineness weights
        Object.values(autoRead).forEach(a => a.setup());

        // 1. Moisture Buttons & File Inputs (manual fallback only becomes visible after 5 unaccepted auto attempts)
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

    function initLab1Screen() {
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
    }

    async function lookupLab1Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a barcode ID.');
            return;
        }

        const entryCard = document.getElementById('lab1-entry-card');
        const alertBox = document.getElementById('lab1-alert');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';

        try {
            const data = await window.BiomassAPI.getSample1Details(barcode);
            if (data.success) {
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
                    alertBox.style.display = 'none';
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
        const moisture = showMoisture ? moistureInput.value : '';

        const initialWeight = document.getElementById('lab1-fineness-initial').value;
        const finalWeight = document.getElementById('lab1-fineness-final').value;
        const finenessBtnEnabled = !document.getElementById('btn-fineness-initial-photo').disabled;
        const finenessEditable = showFineness && finenessBtnEnabled;
        const moistureEditable = showMoisture && !moistureInput.disabled;

        // Mandatory: photo-verified moisture reading
        if (moistureEditable) {
            if (autoRead['moisture'].mode() === 'auto') {
                alert('Please scan the moisture meter display with the camera and confirm the reading.\n\n(After 5 attempts without an accepted reading you can attach a photo and type the value manually.)');
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
                alert('Please scan the scale display with the camera and confirm BOTH the initial and the final weight.\n\n(After 5 attempts without an accepted reading you can attach a photo and type the value manually.)');
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

        try {
            const res = await window.BiomassAPI.submitSample1Result(barcode, moisture, fineness, extra);
            if (res.success) {
                const acceptMsg = res.acceptance_status === 'REJECTED' 
                    ? '\n⚠️ CONSIGNMENT REJECTED: Moisture is 14.0% or higher.' 
                    : (res.acceptance_status === 'ACCEPTED' ? '\n✅ CONSIGNMENT ACCEPTED: Moisture is below 14.0%.' : '');
                alert('Sample analysis locked and submitted successfully!' + acceptMsg);
                document.getElementById('lab1-entry-card').style.display = 'none';
                resetMoistureModule();
                resetFinenessModule();
                renderLab1History();

            } else {
                alert('Submission failed: ' + res.message);
            }
        } catch (err) {
            alert('Submission error: ' + err.message);
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

            history.slice().reverse().forEach((row, idx) => {
                const tr = document.createElement('tr');
                const moistureCell = showMoisture ? `<td>${row.moisture_pct}%</td>` : '';
                const finenessCell = showFineness ? `<td>${row.fineness_value}%</td>` : '';
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Sample #${history.length - idx}</strong></td>
                    ${moistureCell}
                    ${finenessCell}
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center; color: var(--danger);">Failed to load history: ${esc(e.message)}</td></tr>`;
        }
    }


    // ================= LAB 2 STATION 2 CONTROLLER (BLIND Composite GCV & Ash) =================
    const lab2State = {
        scannedSamples: new Set(),
        // Always "today in India" — recomputed on every use, so it is right after midnight and independent of the
        // device's time zone (the old UTC-based value was yesterday between 00:00 and 05:30 IST).
        get activeDate() { return window.BiomassAPI.todayIST(); }
    };

    function initLab2Screen() {
        const entryCard = document.getElementById('lab2-entry-card');
        if (entryCard) entryCard.style.display = 'none';
        const compositeOutput = document.getElementById('lab2-composite-output');
        if (compositeOutput) compositeOutput.style.display = 'none';
        renderLab2History();
        setupLab2CameraScanner();
        setupLab2ScanWorkflow();
        renderLab2MixingGroups();
    }

    function setupLab2ScanWorkflow() {
        const btnScan = document.getElementById('btn-lab2-scan-sample');
        const inputManual = document.getElementById('lab2-sample-manual-input');
        const btnManual = document.getElementById('btn-lab2-sample-manual-submit');

        // Hidden capture file input for sample camera snaps
        let scanFileInput = document.getElementById('lab2-sample-file-input');
        if (!scanFileInput && btnScan) {
            scanFileInput = document.createElement('input');
            scanFileInput.type = 'file';
            scanFileInput.id = 'lab2-sample-file-input';
            scanFileInput.accept = 'image/*';
            scanFileInput.setAttribute('capture', 'environment');
            scanFileInput.style.display = 'none';
            btnScan.parentNode.insertBefore(scanFileInput, btnScan.nextSibling);
        }

        if (btnScan && scanFileInput) {
            btnScan.onclick = () => scanFileInput.click();
            scanFileInput.onchange = async (e) => {
                const file = e.target.files[0];
                scanFileInput.value = '';
                if (!file) return;

                btnScan.disabled = true;
                btnScan.textContent = '⏳ Reading QR...';
                try {
                    const tempScanner = new Html5Qrcode('lab2-qr-reader');
                    const decodedText = await tempScanner.scanFile(file, true);
                    const plainId = await processScannedCode(decodedText);
                    await handleLab2SampleScan(plainId);
                } catch (err) {
                    alert('Could not decode sample QR from image: ' + err.message);
                } finally {
                    btnScan.disabled = false;
                    btnScan.innerHTML = '📷 Snap / Scan Sample Container';
                }
            };
        }

        if (btnManual && inputManual) {
            btnManual.onclick = () => {
                const val = inputManual.value.trim();
                if (val) {
                    handleLab2SampleScan(val);
                    inputManual.value = '';
                }
            };
            inputManual.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = inputManual.value.trim();
                    if (val) {
                        handleLab2SampleScan(val);
                        inputManual.value = '';
                    }
                }
            };
        }
    }

    async function handleLab2SampleScan(code) {
        if (!code) return;
        const feedback = document.getElementById('lab2-scan-feedback');
        const scanHistory = document.getElementById('lab2-sample-scan-history');

        try {
            const plainId = await processScannedCode(code);
            const res = await window.BiomassAPI.scanSampleForLab2(plainId);
            if (!res || !res.success) throw new Error((res && res.message) || 'Verification failed');

            lab2State.scannedSamples.add(res.sample_barcode_id);

            if (feedback) {
                feedback.style.display = 'block';
                if (res.acceptance_status === 'REJECTED') {
                    feedback.style.background = 'rgba(239, 68, 68, 0.2)';
                    feedback.style.border = '2px solid #ef4444';
                    feedback.style.color = '#fca5a5';
                    feedback.innerHTML = `
                        <div style="font-weight: 800; font-size: 1.1rem; color: #ef4444; margin-bottom: 0.25rem;">
                            ⛔ REJECTED SAMPLE DETECTED: [${res.sample_barcode_id}]
                        </div>
                        <div><strong>Moisture Level:</strong> ${res.moisture_pct}% (&ge; 14.0% rejection limit)</div>
                        <div style="margin-top: 0.5rem; font-weight: bold; color: #fff; background: #dc2626; padding: 0.4rem 0.6rem; border-radius: 4px;">
                            ⚠️ CRITICAL ACTION: SEGREGATE THIS CONTAINER IMMEDIATELY! DO NOT ADD TO COMPOSITE MIXTURE!
                        </div>
                    `;
                } else if (res.acceptance_status === 'PENDING') {
                    // Lab-1 has not recorded a moisture result for this container yet. The server also refuses
                    // to include it in a composite until it does - this just makes that visible immediately.
                    feedback.style.background = 'rgba(245, 158, 11, 0.2)';
                    feedback.style.border = '2px solid #f59e0b';
                    feedback.style.color = '#fde68a';
                    feedback.innerHTML = `
                        <div style="font-weight: 800; font-size: 1.1rem; color: #f59e0b; margin-bottom: 0.25rem;">
                            ⏳ MOISTURE RESULT PENDING: [${res.sample_barcode_id}]
                        </div>
                        <div><strong>Mixing Group:</strong> <span class="scan-group-code-pill">${esc(res.daily_group_code)}</span></div>
                        <div style="margin-top: 0.4rem; color: #e2e8f0;">
                            Lab Station 1 has not recorded a moisture result for this container yet. It cannot be added to a composite until it does.
                        </div>
                    `;
                } else {
                    feedback.style.background = 'rgba(16, 185, 129, 0.2)';
                    feedback.style.border = '2px solid #10b981';
                    feedback.style.color = '#86efac';
                    feedback.innerHTML = `
                        <div style="font-weight: 800; font-size: 1.1rem; color: #10b981; margin-bottom: 0.25rem;">
                            ✅ ACCEPTED SAMPLE: [${res.sample_barcode_id}]
                        </div>
                        <div><strong>Mixing Group:</strong> <span class="scan-group-code-pill">${esc(res.daily_group_code)}</span> <strong>Moisture:</strong> ${res.moisture_pct}%</div>
                        <div style="margin-top: 0.4rem; color: #e2e8f0;">
                            Sample verified and approved. Add to composite sample container for <span class="scan-group-code-pill">${esc(res.daily_group_code)}</span>.
                        </div>
                    `;
                }
            }

            if (scanHistory) {
                const entry = document.createElement('div');
                const isRej = res.acceptance_status === 'REJECTED';
                entry.style.cssText = `padding: 0.35rem 0.5rem; border-radius: 4px; background: ${isRej ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'}; border-left: 3px solid ${isRej ? '#ef4444' : '#10b981'};`;
                const moistTxt = res.moisture_pct !== null && res.moisture_pct !== undefined ? `${res.moisture_pct}%` : 'pending';
                entry.innerHTML = `<strong>${esc(res.sample_barcode_id)}</strong> &rarr; Group <strong>${esc(res.daily_group_code)}</strong> (${esc(res.acceptance_status)}: ${moistTxt}) &bull; <small>${new Date().toLocaleTimeString()}</small>`;
                scanHistory.prepend(entry);
            }

            await renderLab2MixingGroups();

        } catch (err) {
            if (feedback) {
                feedback.style.display = 'block';
                feedback.style.background = 'rgba(239, 68, 68, 0.2)';
                feedback.style.border = '2px solid #ef4444';
                feedback.style.color = '#fca5a5';
                feedback.innerHTML = `⚠️ Scan verification error: ${esc(err.message)}`;
            }
        }
    }

    async function renderLab2MixingGroups() {
        const container = document.getElementById('lab2-mixing-groups-container');
        if (!container) return;

        try {
            const res = await window.BiomassAPI.getLab2MixingGroupsStatus(lab2State.activeDate);
            if (!res.success || !res.groups || res.groups.length === 0) {
                container.innerHTML = '<div style="color: #94a3b8; font-style: italic; padding: 1rem;">No truck entries recorded for today yet. Active mixing groups will appear as trucks enter.</div>';
                return;
            }

            container.innerHTML = '';
            res.groups.forEach(group => {
                const acceptedInGroup = group.trucks.filter(t => t.acceptance_status === 'ACCEPTED');
                const scannedAcceptedCount = acceptedInGroup.filter(t => lab2State.scannedSamples.has(t.sample1_barcode_id)).length;
                const allAcceptedScanned = (group.accepted_count > 0) && (scannedAcceptedCount >= group.accepted_count);

                const card = document.createElement('div');
                card.className = 'mixing-group-card';
                if (group.is_batch_created) {
                    card.style.borderColor = '#10b981';
                }

                let actionHtml = '';
                if (group.is_batch_created) {
                    actionHtml = `
                        <div style="color: #10b981; font-weight: bold; font-size: 0.85rem; margin-top: 0.5rem;">
                            ✅ Composite Generated (${group.batch_ref_id})
                        </div>
                        <button class="btn btn-secondary btn-sm mt-2" onclick="window.reprintLab2Batch('${group.group_code}')" style="width: 100%;">
                            🖨️ View / Print Composite QR Codes
                        </button>
                    `;
                } else if (group.pending_count > 0) {
                    actionHtml = `
                        <div style="color: #f59e0b; font-size: 0.82rem; margin-top: 0.5rem;">
                            ⏳ Waiting for Lab 1 moisture results (${group.pending_count} pending).
                        </div>
                        <button class="btn btn-secondary btn-sm mt-2" disabled style="width: 100%; opacity: 0.5; cursor: not-allowed;">
                            🔒 Locked (Lab 1 Incomplete)
                        </button>
                    `;
                } else if (group.accepted_count === 0) {
                    actionHtml = `
                        <div style="color: #ef4444; font-size: 0.82rem; margin-top: 0.5rem;">
                            ⛔ All ${group.rejected_count} consignments in this group were REJECTED.
                        </div>
                    `;
                } else if (!allAcceptedScanned) {
                    const remaining = group.accepted_count - scannedAcceptedCount;
                    actionHtml = `
                        <div style="color: #cbd5e1; font-size: 0.82rem; margin-top: 0.5rem;">
                            Scan physical accepted containers: <strong>${scannedAcceptedCount} / ${group.accepted_count}</strong> scanned.
                        </div>
                        <button class="btn btn-secondary btn-sm mt-2" disabled style="width: 100%; opacity: 0.6; cursor: not-allowed;" title="Scan remaining accepted containers first">
                            🔒 Scan ${remaining} more container${remaining > 1 ? 's' : ''} to Unlock
                        </button>
                    `;
                } else {
                    actionHtml = `
                        <div style="color: #10b981; font-size: 0.85rem; font-weight: bold; margin-top: 0.5rem;">
                            🎉 All ${group.accepted_count} accepted containers verified!
                        </div>
                        <button class="btn btn-primary btn-sm mt-2" onclick="window.generateLab2CompositeForGroup('${group.group_code}')" style="width: 100%; background: linear-gradient(135deg, #10b981 0%, #059669 100%); font-weight: bold;">
                            ⚗️ Generate Composite Mix (${group.group_code})
                        </button>
                    `;
                }

                card.innerHTML = `
                    <div class="mixing-group-header">
                        <div>
                            <div class="group-code-badge">${group.group_code}</div>
                            <span style="font-size: 0.8rem; color: #94a3b8; margin-left: 0.4rem;">${group.total_registered} Consignment(s)</span>
                        </div>
                        <span class="badge ${group.is_batch_created ? 'badge-success' : 'badge-pending'}">
                            ${group.is_batch_created ? 'COMPILED' : 'ACTIVE'}
                        </span>
                    </div>
                    
                    <div class="mixing-group-stats">
                        <div class="group-stat-pill stat-accepted">
                            <strong>${group.accepted_count}</strong> Accepted
                        </div>
                        <div class="group-stat-pill stat-rejected">
                            <strong>${group.rejected_count}</strong> Rejected
                        </div>
                        <div class="group-stat-pill stat-pending">
                            <strong>${group.pending_count}</strong> Pending
                        </div>
                    </div>
                    
                    <div style="font-size: 0.8rem; color: #cbd5e1; margin-top: 0.5rem; display: flex; justify-content: space-between;">
                        <span>Physical Intake Progress:</span>
                        <strong>${scannedAcceptedCount} / ${group.accepted_count}</strong>
                    </div>
                    <div class="progress-bar-container" style="background: rgba(255,255,255,0.1); height: 6px; border-radius: 3px; margin-top: 0.25rem; overflow: hidden;">
                        <div style="background: #10b981; height: 100%; width: ${group.accepted_count > 0 ? (scannedAcceptedCount / group.accepted_count * 100) : 0}%;"></div>
                    </div>
                    
                    ${actionHtml}
                `;
                container.appendChild(card);
            });
        } catch (err) {
            container.innerHTML = `<div style="color: #ef4444; padding: 1rem;">Failed to load mixing groups: ${esc(err.message)}</div>`;
        }
    }

    window.generateLab2CompositeForGroup = async function(groupCode) {
        if (!confirm(`Confirm generation of Composite Mixture QR codes for Group [${groupCode}]?\n\nThis will compile accepted consignments and generate Test (-T), Referee (-R), and Vendor (-V) sealed sample labels.`)) return;

        if (window.showGlobalLoader) window.showGlobalLoader(`Compiling Composite Mixture for [${groupCode}]...`);
        try {
            // The server re-checks everything (no pending results, at least one accepted sample, no earlier composite)
            // and refuses unless EVERY accepted container of this group is in the list of physically scanned samples.
            const res = await window.BiomassAPI.createCompositeBatchForGroup(
                lab2State.activeDate, groupCode, Array.from(lab2State.scannedSamples));
            if (!res || !res.success) throw new Error((res && res.message) || 'Composite could not be created');

            alert(`Composite Batch ${res.batch.composite_ref_id} created successfully for Group [${groupCode}]!`);
            await renderLab2MixingGroups();
            await renderLab2CompositeOutput(res.batch, groupCode);
        } catch (err) {
            alert('Generation failed: ' + err.message);
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    };

    window.reprintLab2Batch = async function(groupCode) {
        try {
            const batch = await window.BiomassAPI.getCompositeBatchByGroupCode(groupCode, lab2State.activeDate);
            if (batch) {
                await renderLab2CompositeOutput(batch, groupCode);
            } else {
                alert('Composite batch record not found for Group ' + groupCode);
            }
        } catch (err) {
            alert('Failed to retrieve batch: ' + err.message);
        }
    };

    // Renders the Test/Referee/Vendor QR outputs for a composite batch on the Lab 2 screen,
    // formatted for strict 50mm x 50mm thermal paper label rolls
    async function renderLab2CompositeOutput(batch, groupCode) {
        if (!batch.lots) {
            batch.lots = {
                test: batch.test_lot || batch.composite_barcode_id || `${batch.composite_ref_id}-T`,
                referee: batch.referee_lot || `${batch.composite_ref_id}-R`,
                vendor: batch.vendor_lot || `${batch.composite_ref_id}-V`
            };
        }

        const outputDiv = document.getElementById('lab2-composite-output');
        if (outputDiv) outputDiv.style.display = 'block';

        const gCodeLab2 = String(batch.daily_group_code || groupCode || 'N/A').trim().toUpperCase();
        const groupLabelText = `MIXING GROUP: ${gCodeLab2}`;
        const batchDate = batch.date || '';

        ['test', 'ref', 'vend'].forEach(k => {
            const groupEl = document.getElementById(`lab2-${k}-group-code`);
            const codeEl = document.getElementById(`lab2-${k}-code`);
            if (groupEl) groupEl.textContent = groupLabelText;
            if (codeEl) codeEl.style.display = 'none';
        });

        const testEnc = await encryptPayload(batch.lots.test);
        const refEnc = await encryptPayload(batch.lots.referee);
        const vendEnc = await encryptPayload(batch.lots.vendor);

        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-test'), testEnc, { errorCorrectionLevel: 'M', width: 140, margin: 1 });
        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-ref'), refEnc, { errorCorrectionLevel: 'M', width: 140, margin: 1 });
        QRCode.toCanvas(document.getElementById('qr-canvas-lab2-vend'), vendEnc, { errorCorrectionLevel: 'M', width: 140, margin: 1 });

        const printContainer = document.getElementById('print-section');
        const setupPrint = async (lotId, sampleName) => {
            const encrypted = await encryptPayload(lotId);
            printContainer.innerHTML = `
                <div class="print-label-view print-label-50mm" style="text-align: center;">
                    <div style="font-size: 8pt; font-weight: bold; font-family: monospace; color: #000; line-height: 1;">GROUP: ${gCodeLab2}</div>
                    <div style="font-size: 7pt; font-weight: bold; margin: 1px 0 2px 0; color: #000; font-family: monospace;">${sampleName}</div>
                    <canvas id="print-qr-target"></canvas>
                    <div class="print-label-id" style="font-family: monospace; font-size: 7pt; font-weight: bold; margin-top: 1px;">${lotId}</div>
                </div>
            `;
            QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                errorCorrectionLevel: 'M',
                width: 120,
                margin: 1
            }, function(err) {
                if (err) console.error(err);
                document.body.classList.add('printing-label');
                setTimeout(() => { 
                    window.print(); 
                    document.body.classList.remove('printing-label');
                }, 250);
            });
        };

        document.getElementById('btn-print-lab2-test').onclick = () => setupPrint(batch.lots.test, "TEST LOT (-T)");
        document.getElementById('btn-print-lab2-ref').onclick = () => setupPrint(batch.lots.referee, "REFEREE LOT (-R)");
        document.getElementById('btn-print-lab2-vend').onclick = () => setupPrint(batch.lots.vendor, "VENDOR LOT (-V)");

        // Download PNG actions
        document.getElementById('btn-download-lab2-test').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-test',
            `TEST_${batchDate}_${gCodeLab2}`,
            `GROUP: ${gCodeLab2} | TEST LOT`,
            "TEST LOT",
            true
        );
        document.getElementById('btn-download-lab2-ref').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-ref',
            `REFEREE_${batchDate}_${gCodeLab2}`,
            `GROUP: ${gCodeLab2} | REFEREE LOT`,
            "REFEREE LOT",
            true
        );
        document.getElementById('btn-download-lab2-vend').onclick = () => downloadQrAsPng(
            '#qr-canvas-lab2-vend',
            `VENDOR_${batchDate}_${gCodeLab2}`,
            `GROUP: ${gCodeLab2} | VENDOR LOT`,
            "VENDOR LOT",
            true
        );

        outputDiv.scrollIntoView({ behavior: 'smooth' });
    }

    async function lookupLab2Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a composite barcode ID.');
            return;
        }

        const entryCard = document.getElementById('lab2-entry-card');
        const alertBox = document.getElementById('lab2-alert');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';

        try {
            const data = await window.BiomassAPI.getCompositeDetails(barcode);
            if (data.success) {
                entryCard.style.display = 'block';
                document.getElementById('lab2-blind-code').textContent = `✅ ACTIVE SECURE COMPOSITE (${data.lot_type})`;
                document.getElementById('lab2-barcode-id').value = data.composite_barcode_id;

                if (data.meta || data.company_name || data.parent_truck_ids) {
                    console.error('Collusion leak warning: Identity metadata detected in composite lab session!');
                }

                const gcvInput = document.getElementById('lab2-gcv');
                const ashInput = document.getElementById('lab2-ash');
                const form = document.getElementById('lab2-entry-form');
                const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

                if (data.is_tested) {
                    gcvInput.value = data.gcv_value;
                    ashInput.value = data.ash_pct;
                    gcvInput.disabled = true;
                    ashInput.disabled = true;
                    if (submitBtn) submitBtn.disabled = true;
                    
                    alertBox.textContent = `Error: This report has been locked and submitted at ${data.tested_at}. No further edits are allowed.`;
                    alertBox.className = 'alert alert-danger';
                    alertBox.style.display = 'flex';
                } else {
                    gcvInput.value = '';
                    ashInput.value = '';
                    gcvInput.disabled = false;
                    ashInput.disabled = false;
                    if (submitBtn) submitBtn.disabled = false;
                }

                document.getElementById('lab2-gcv').focus();
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
        const gcv = document.getElementById('lab2-gcv').value;
        const ash = document.getElementById('lab2-ash').value;

        try {
            const res = await window.BiomassAPI.submitCompositeResult(barcode, gcv, ash);
            if (res.success) {
                alert('Composite batch analysis locked and submitted successfully!');
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
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading history...</td></tr>';

        try {
            const history = await window.BiomassAPI.getLab2History();
            tbody.innerHTML = '';
            
            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No composite tests submitted by your account today.</td></tr>';
                return;
            }

            history.slice().reverse().forEach((row, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Composite #${history.length - idx}</strong></td>
                    <td>${row.gcv_value} kcal/kg</td>
                    <td>${row.ash_pct}%</td>
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load history: ${esc(e.message)}</td></tr>`;
        }
    }

    // ================= BARCODE INSPECTOR TAB (ADMIN) =================
    function initAdminInspectorTab() {
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
                                • GCV Value: ${res.composite.gcv_value || 'Pending Lab 2'}<br>
                                • Ash Content: ${res.composite.ash_pct ? res.composite.ash_pct + '%' : 'Pending Lab 2'}
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
                    if (res.batch.gcv_value !== null && res.batch.gcv_value !== "") {
                        lab2ResultsHtml = `
                            <div class="lab-meta-display" style="background: #ecfdf5; border-color: #a7f3d0; margin-top: 1rem; color: #065f46;">
                                <strong>Lab Station 2 Results:</strong><br>
                                • GCV Value: ${res.batch.gcv_value} kcal/kg<br>
                                • Ash Content: ${res.batch.ash_pct}%<br>
                                • Tested By: ${esc(res.batch.tested_by)}<br>
                                • Tested At: ${res.batch.tested_at}
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
                : r.acceptance_status === 'ACCEPTED' ? '<span style="color:green; font-weight:bold;">✅ ACCEPTED</span>' : 'Pending';
            const gcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (num(r.gcv_value) !== null ? num(r.gcv_value) : 'Pending');
            const ashPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (num(r.ash_pct) !== null ? num(r.ash_pct) + '%' : 'Pending');
            const vendorGcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : formatVendorGcvDisplay(r);
            const refereeGcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : formatRefereeGcvDisplay(r);

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
                const gcv = c2.gcv_value !== undefined && c2.gcv_value !== null && c2.gcv_value !== "" ? Number(c2.gcv_value) : null;
                const ash = c2.ash_pct !== undefined && c2.ash_pct !== null && c2.ash_pct !== "" ? Number(c2.ash_pct) : null;
                const vendorGcv = c2.vendor_gcv !== undefined && c2.vendor_gcv !== null && c2.vendor_gcv !== "" ? Number(c2.vendor_gcv) : null;
                const refereeGcv = c2.referee_gcv !== undefined && c2.referee_gcv !== null && c2.referee_gcv !== "" ? Number(c2.referee_gcv) : null;
                const refereeStatus = c2.referee_status || null;
                const status = t.acceptance_status || (moisture !== null ? (moisture < 14.0 ? 'ACCEPTED' : 'REJECTED') : 'PENDING');
                
                let stage = 'Gate Registered';
                if (status === 'REJECTED') stage = 'Rejected (Moisture Breach)';
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
            if (kpiBreakEl) kpiBreakEl.textContent = `${acceptedList.length} Accepted | ${rejectedList.length} Rejected`;
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
            tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No consignments match current filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = records.slice(0, 50).map(r => {
            const dateStr = r.date_obj ? r.date_obj.toISOString().substring(0, 10) : (r.date || '-');
            const statusBadge = r.acceptance_status === 'ACCEPTED' ? 
                '<span class="badge badge-complete">ACCEPTED</span>' : 
                (r.acceptance_status === 'REJECTED' ? '<span class="badge badge-rejected">REJECTED</span>' : '<span class="badge badge-pending">PENDING</span>');

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
                    <td>${r.gcv_value ? r.gcv_value + ' kcal/kg' : '-'}</td>
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
            { header: 'Truck Reg No.',   width: 14 },
            { header: 'Driver',          width: 16 },
            { header: 'Gross Wt (kg)',   width: 12 },
            { header: 'Tare Wt (kg)',    width: 12 },
            { header: 'Net Wt (MT)',     width: 12 },
            { header: 'Moisture %',      width: 11 },
            { header: 'Fineness %',      width: 11 },
            { header: 'GCV (kcal/kg)',   width: 13 },
            { header: 'Ash %',           width: 9  },
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
            const isRejected = rec.acceptance_status === 'REJECTED';
            const dateStr = rec.date_obj ? window.BiomassAPI.formatLocalYYYYMMDD(rec.date_obj) : (rec.entry_date || '-');
            const rowVals = [
                dateStr,
                rec.invoice_no || rec.challan_no || '-',
                rec.company_name || '-',
                rec.truck_reg_number || '-',
                rec.driver_name || '-',
                Number(rec.gross_weight) || 0,
                Number(rec.tare_weight) || 0,
                Number(rec.net_weight_mt || 0).toFixed(3),
                rec.moisture_pct !== null ? rec.moisture_pct : 'Pending',
                rec.fineness_value !== null ? rec.fineness_value : 'Pending',
                isRejected ? 'N/A (REJECTED)' : (rec.gcv_value !== null ? rec.gcv_value : 'Pending'),
                isRejected ? 'N/A (REJECTED)' : (rec.ash_pct !== null ? rec.ash_pct : 'Pending'),
                isRejected ? 'N/A (REJECTED)' : formatVendorGcvDisplay(rec),
                isRejected ? 'N/A (REJECTED)' : formatRefereeGcvDisplay(rec),
                rec.acceptance_status || 'PENDING',
                rec.pipeline_stage || '-'
            ];
            rowVals.forEach((val, i) => {
                const cell = sheet.getCell(r, i + 1);
                cell.value = val;
                cell.border = { top: { style: 'hair' }, left: { style: 'hair' }, bottom: { style: 'hair' }, right: { style: 'hair' } };
                cell.alignment = { vertical: 'middle', horizontal: i <= 4 ? 'left' : 'center' };
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
            ['Total Net Weight (MT)', Number(totalNetMT.toFixed(2))],
            ['Avg Moisture %', avgMoisture !== null ? Number(avgMoisture.toFixed(2)) : 'Pending'],
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
