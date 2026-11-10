# Barcoded seal system

A stand-alone version of the seal check, kept separate from the biomass app. Open `index.html` (double-click, or any web server). It stores everything in the browser only.

## What it does
1. **Gate entry**: scan the two seals of a sample (LAB seal for moisture and fineness, COMPOSITE seal for the composite). Both are linked to the sample QR. A seal already used, or two identical seals, are refused.
2. **Lab**: scan the seal first. A green circle with a tick unlocks the sample QR scan. A red circle with a cross (TAMPERED) keeps it locked and logs the event. The sample QR must be the one linked to that seal; then the seal is recorded as opened.
3. **Admin**: list of seals and events; cancel the seals of a QR.
4. **Photo test**: choose many photos of seals; the page reads each one and reports how many were read (CSV download). This is how the reader is tested and tuned on your photographs.
5. **Self-test**: runs the rules (16 checks).

## How a barcode is read
Browser reader (`BarcodeDetector`) first where it exists, then the html5-qrcode library on the photo, a resized copy, a high-contrast copy and a rotated copy. Any common barcode type works (Code 128, Code 39, EAN, QR, Data Matrix where the library supports it). Nothing needs "training" in the machine-learning sense; the photos decide which of these steps and settings are kept.

## Files
- `seal-gate.js`, `seal-gate.css`: the scan window, the green / red signs, the lock on the QR scan, the decoder. Shared with the biomass app.
- `local-backend.js`: the rules applied to a local store. The same rules are in `db/migrations/2026-11-09_seals.sql` for the real system.
- `demo.js`, `index.html`: the demo pages.

## In the biomass app
Already wired, and switched OFF. Nothing changes until the Super Admin presses **Switch ON** in Super Admin > Logins > Barcoded seals (after running `db/migrations/2026-11-09_seals.sql`).
When on: gate entry and bottom-sample generation ask for two seals; Lab 1 (moisture, fineness) must scan the LAB seal before the sample QR; the Fineness mixing scan must scan the COMPOSITE seal first.
