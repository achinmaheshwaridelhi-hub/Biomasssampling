/**
 * Biomass Sampling — Data Access Layer (api.js)  —  v2 "secure" edition
 *
 * SECURITY MODEL (read this before changing anything):
 *   - The browser holds NO trust. Roles are NOT read from sessionStorage for security;
 *     every call carries the user's signed Supabase Auth token, and the DATABASE decides
 *     what that user may see (see db/01_schema_v2.sql).
 *   - There is no table access from the browser at all. Every operation is a call to a
 *     role-checked database function (public.bm_*). Those functions return ONLY the fields
 *     the caller's role may see. In particular, no non-admin login is ever sent a supplier /
 *     truck identity together with a sample barcode, composite code or mixing-group code.
 *   - The anon key below is public by design; with this schema it grants nothing.
 *
 * getCurrentUser() below only drives which SCREEN is shown. Forging it gets you a screen
 * whose every data call is then refused by the database.
 */
(function () {

    // =====================================================================
    //  CONFIGURATION
    // =====================================================================
    const SUPABASE_URL      = 'https://jarfhyraxjvtimradvbp.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphcmZoeXJheGp2dGltcmFkdmJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNDg3MDUsImV4cCI6MjEwMTgyNDcwNX0.F894ZMZrgUKY3Ef4yzN0gRVMdELC1NkIKRi29JT00zU';
    // Logins are stored in Supabase Auth as <username>@<LOGIN_EMAIL_DOMAIN>. ".invalid" can never be
    // registered by anyone, so a password-recovery e-mail can never reach a stranger. Must match db/02_link_users.sql.
    const LOGIN_EMAIL_DOMAIN = 'biomass.invalid';
    const MOISTURE_REJECT_LIMIT = 14;      // >= 14.000 % is REJECTED (the database enforces the same rule)
    const NETWORK_TIMEOUT_MS = 25000;
    const SESSION_KEY = 'BIOMASS_AUTH';
    // Evidence photos (gate / meter / scale) go to a PRIVATE Supabase Storage bucket instead of being stored as ~100 KB of
    // base64 text inside the database; the database keeps only the short path 'ev/<name>'. Set to false to go back to the old
    // way (photo inside the record). If an upload fails for any reason the photo is saved the old way, so work never stops.
    const STORE_PHOTOS_IN_STORAGE = true;
    const EVIDENCE_BUCKET = 'evidence';
    const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;      // Supabase free plan: 1 GB of Storage

    const REST = `${SUPABASE_URL}/rest/v1`;

    // --- Network timeout wrapper ------------------------------------------
    const _nativeFetch = window.fetch.bind(window);
    function fetch(input, init) {
        init = init || {};
        if (init.signal) return _nativeFetch(input, init);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
        return _nativeFetch(input, Object.assign({}, init, { signal: ctrl.signal }))
            .catch(err => {
                if (err && err.name === 'AbortError') {
                    throw new Error('Network timeout — server did not respond. Check your internet connection and try again.');
                }
                throw err;
            })
            .finally(() => clearTimeout(timer));
    }

    // =====================================================================
    //  IST (UTC+05:30, no daylight saving) date helpers — independent of the device time zone
    // =====================================================================
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const pad2 = n => String(n).padStart(2, '0');
    function ymdFromUTCFields(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
    function todayIST() { return ymdFromUTCFields(new Date(Date.now() + IST_OFFSET_MS)); }
    function addDaysYMD(ymd, n) {
        const [y, m, d] = ymd.split('-').map(Number);
        return ymdFromUTCFields(new Date(Date.UTC(y, m - 1, d + n)));
    }
    function toYMD(v) {
        if (!v) return '';
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).slice(0, 10);
        return ymdFromUTCFields(new Date(d.getTime() + IST_OFFSET_MS));
    }

    // =====================================================================
    //  SESSION + AUTH (Supabase Auth)
    // =====================================================================
    // The signed-in session is kept in localStorage so a worker stays signed in when the app / browser is closed and
    // reopened (no password re-typing). The access token is renewed in the background with the refresh token until the
    // worker presses Logout. (sessionStorage is only a fallback for browsers that block localStorage.)
    function loadSession() {
        try { const v = localStorage.getItem(SESSION_KEY); if (v) return JSON.parse(v); } catch (e) { /* fall through */ }
        try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
    }
    function saveSession(s) {
        const v = JSON.stringify(s);
        try { localStorage.setItem(SESSION_KEY, v); return; } catch (e) { /* storage blocked: fall back */ }
        try { sessionStorage.setItem(SESSION_KEY, v); } catch (e) { /* private mode */ }
    }
    function clearSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
        try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem('BIOMASS_SESSION'); } catch (e) { /* ignore */ }
    }
    function announceExpiry() {
        clearSession();
        try { window.dispatchEvent(new Event('biomass-session-expired')); } catch (e) { /* ignore */ }
    }

    async function authRequest(path, body, token) {
        const headers = { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error_description || data.msg || data.message || res.statusText || 'Authentication failed');
            err.status = res.status;
            err.code = data.error_code || data.error;
            throw err;
        }
        return data;
    }

    let _refreshing = null;
    async function refreshSession() {
        const s = loadSession();
        if (!s || !s.refresh_token) throw new Error('No session');
        const d = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
        s.access_token = d.access_token;
        s.refresh_token = d.refresh_token || s.refresh_token;
        s.expires_at = Date.now() + (Number(d.expires_in) || 3600) * 1000;
        saveSession(s);
        return s;
    }
    async function getToken() {
        let s = loadSession();
        if (!s || !s.access_token) { announceExpiry(); throw new Error('Not signed in. Please log in again.'); }
        if (Date.now() > (s.expires_at || 0) - 60000) {
            _refreshing = _refreshing || refreshSession().finally(() => { _refreshing = null; });
            try { s = await _refreshing; }
            catch (e) { announceExpiry(); throw new Error('Session expired. Please sign in again.'); }
        }
        return s.access_token;
    }

    /** Call a role-checked database function. All functions take one JSON argument "p". */
    async function rpc(name, p) {
        const token = await getToken();
        const res = await fetch(`${REST}/rpc/${name}`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p: p || {} })
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error_description)) || res.statusText || 'Request failed';
            if (res.status === 401 && /jwt|token/i.test(msg)) { announceExpiry(); throw new Error('Session expired. Please sign in again.'); }
            const err = new Error(msg);
            err.code = data && data.code;
            err.status = res.status;
            throw err;
        }
        return data;
    }

    /** Upload one photo (a data: URL) to Storage and return its 'ev/<name>' path; on any failure return the data URL unchanged. */
    async function uploadEvidence(dataUrl) {
        if (!STORE_PHOTOS_IN_STORAGE || typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) return dataUrl;
        try {
            const blob = await (await _nativeFetch(dataUrl)).blob();
            const token = await getToken();
            const d = new Date();
            const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
            const ext = /png/.test(blob.type) ? 'png' : (/webp/.test(blob.type) ? 'webp' : 'jpg');
            const name = `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${rnd}.${ext}`;
            const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${EVIDENCE_BUCKET}/${name}`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
                body: blob
            });
            if (!res.ok) throw new Error('Storage upload refused (HTTP ' + res.status + ')');
            return 'ev/' + name;
        } catch (e) {
            console.warn('Photo could not be uploaded to Storage; it is saved with the record instead:', e);
            return dataUrl;
        }
    }

    // Client-side brake on password guessing (the real limit is Supabase Auth's server-side rate limit).
    let _failCount = 0, _lockedUntil = 0;

    function trucksPayload(f) {
        if (!f || f === 'all') return {};
        if (f === 'today') return { today: true };
        if (f === 'recent') return { days: 1, include_pending: true };   // today + yesterday, plus any truck still awaiting its final weight
        if (typeof f === 'object') {
            if (f.fromDate && f.toDate) return { from: f.fromDate, to: f.toDate };
            if (f.today) return { today: true };
            if (f.all) return {};
            if (f.days) return { days: Number(f.days), include_pending: !!f.include_pending };
        }
        return {};
    }
    const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

    // =====================================================================
    //  Public API
    // =====================================================================
    window.BiomassAPI = {

        // --- date / time helpers (IST, device-independent) ---------------
        todayIST,
        addDaysYMD,
        formatLocalYYYYMMDD(dateVal) { return toYMD(dateVal); },
        formatLocalTime(timeVal) {
            if (!timeVal) return '';
            if (typeof timeVal === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(timeVal)) return timeVal;
            const d = new Date(timeVal);
            if (isNaN(d.getTime())) return String(timeVal);
            const x = new Date(d.getTime() + IST_OFFSET_MS);
            return `${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}:${pad2(x.getUTCSeconds())}`;
        },

        // --- config -------------------------------------------------------
        isRemoteMode() { return true; },
        getSupabaseUrl() { return SUPABASE_URL; },
        getAppsScriptUrl() { return SUPABASE_URL; },       // legacy name
        setAppsScriptUrl() { /* no-op */ },

        // --- AUTH ----------------------------------------------------------
        getCurrentUser() {
            const s = loadSession();
            return s && s.user ? s.user : null;
        },

        async login(username, password) {
            const uname = String(username || '').trim().toLowerCase();
            if (Date.now() < _lockedUntil) {
                const secs = Math.ceil((_lockedUntil - Date.now()) / 1000);
                return { success: false, message: `Too many failed attempts. Try again in ${secs} seconds.` };
            }
            if (!/^[a-z0-9._-]{2,40}$/.test(uname) || !password) {
                return { success: false, message: 'Invalid username or password' };
            }
            try {
                const d = await authRequest('token?grant_type=password', { email: `${uname}@${LOGIN_EMAIL_DOMAIN}`, password: String(password) });
                saveSession({
                    access_token: d.access_token, refresh_token: d.refresh_token,
                    expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, user: null
                });
                let who;
                try { who = await rpc('bm_whoami', {}); }
                catch (e) { clearSession(); return { success: false, message: e.message || 'This account is not provisioned.' }; }
                // The Super Admin has every Admin right: the app treats it as 'admin' and shows the extra Super Admin tab (is_super).
                const sessionUser = { username: who.username, role: who.role === 'superadmin' ? 'admin' : who.role, name: who.name, is_super: who.role === 'superadmin' };
                const s = loadSession(); s.user = sessionUser; saveSession(s);
                _failCount = 0;
                return { success: true, user: sessionUser };
            } catch (e) {
                if (e.status === 400 || e.status === 401 || e.status === 422) {
                    _failCount++;
                    if (_failCount >= 5) _lockedUntil = Date.now() + Math.min(300, 15 * (_failCount - 4)) * 1000;
                    return { success: false, message: 'Invalid username or password' };
                }
                if (e.status === 429) return { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' };
                console.warn('Login failed:', e);
                return { success: false, message: 'Connection error: ' + e.message };
            }
        },

        logout() {
            const s = loadSession();
            clearSession();
            if (s && s.access_token) {     // best effort: revoke the refresh token on the server
                _nativeFetch(`${SUPABASE_URL}/auth/v1/logout`, {
                    method: 'POST', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${s.access_token}` }
                }).catch(() => { });
            }
        },

        // --- SUPPLIERS -------------------------------------------------------
        async getCompanies() {
            const rows = await rpc('bm_list_companies', {});
            return (rows || []).map(r => r.name);
        },
        async getCompaniesDetailed() { return (await rpc('bm_list_companies', {})) || []; },
        // Admin: vendor management (all vendors incl. retired, with truck counts) and the one function that applies any number of changes
        async adminVendors() { return (await rpc('bm_admin_vendors', {})) || []; },
        async vendorApply(rows, dryRun) { return rpc('bm_admin_vendor_apply', { rows, dry_run: dryRun ? 'true' : 'false' }); },

        // --- GATE ENTRY --------------------------------------------------------
        async registerTruck(truckData) {
            const d = Object.assign({}, truckData || {});
            if (d.photo_url) d.photo_url = await uploadEvidence(d.photo_url);
            return rpc('bm_register_truck', d);
        },
        async checkDuplicateVehicle(reg) { return rpc('bm_check_duplicate_vehicle', { truck_reg_number: reg }); },

        async getTrucks(dateFilter) { return (await rpc('bm_get_trucks', trucksPayload(dateFilter))) || []; },
        async getTruckById(truckId) { return rpc('bm_get_truck_by_id', { truck_id: truckId }); },

        async updateWeighment(truckId, grossWeight, tareWeight, overrideReason) {
            return rpc('bm_update_weighment', { truck_id: truckId, gross: grossWeight, tare: tareWeight, reason: overrideReason || '' });
        },

        // --- LAB 1 (blind) ------------------------------------------------------
        async getSample1Details(barcodeId) { return rpc('bm_get_sample1_details', { barcode: barcodeId }); },

        async submitSample1Result(barcodeId, moisture, fineness, extra) {
            extra = extra || {};
            const p = { barcode: barcodeId };
            if (moisture !== '' && moisture != null) { p.moisture = String(moisture); if (extra.moisture_photo) p.moisture_photo = extra.moisture_photo; }
            if (extra.fineness_initial_weight !== undefined && extra.fineness_initial_weight !== '') {
                p.fineness_initial_weight = String(extra.fineness_initial_weight);
                p.fineness_final_weight = String(extra.fineness_final_weight);
                p.fineness_initial_photo = extra.fineness_initial_photo || '';
                p.fineness_final_photo = extra.fineness_final_photo || '';
            }
            if (extra.override_reason) p.override_reason = extra.override_reason;    // admin only (server checks)
            for (const k of ['moisture_photo', 'fineness_initial_photo', 'fineness_final_photo']) {
                if (p[k]) p[k] = await uploadEvidence(p[k]);
            }
            return rpc('bm_submit_lab1_result', p);       // fineness % is computed by the server from the two weights
        },

        evaluateAcceptance(moisturePct) {
            if (moisturePct === null || moisturePct === undefined || moisturePct === '') return 'PENDING';
            return Number(moisturePct) >= MOISTURE_REJECT_LIMIT ? 'REJECTED' : 'ACCEPTED';
        },
        getMoistureRejectLimit() { return MOISTURE_REJECT_LIMIT; },

        async getLab1History() { return (await rpc('bm_get_lab1_history', {})) || []; },

        // --- UNLOADING ------------------------------------------------------------
        async getUnloadingStatus(code) { return rpc('bm_get_unloading_status', { code: String(code || '').trim() }); },

        // --- LAB 2 (blind composite) ---------------------------------------------
        async scanSampleForLab2(barcodeId) { return rpc('bm_lab2_scan_sample', { barcode: String(barcodeId || '').trim() }); }, // Admin only now
        /** Mixing groups for a date range (default today) + optional search by mixing code / composite reference. */
        async getLab2MixingGroupsStatus(from, to, q) { return rpc('bm_lab2_mixing_groups', { from: from || null, to: to || from || null, q: q || '' }); },
        /** Atomic and server-verified: every accepted container of the group must already be scanned in the Fineness login. */
        async createCompositeBatchForGroup(date, groupCode) {
            return rpc('bm_lab2_create_composite', { date: date || null, group_code: groupCode });
        },
        // --- Fineness login: mixing scan + cross-check summary; Admin: reset one group's scans ---
        async mixingScan(barcodeId) { return rpc('bm_mixing_scan', { barcode: String(barcodeId || '').trim() }); },
        async getMixingScanSummary(date) { return rpc('bm_mixing_scan_summary', { date: date || null }); },
        async resetMixingScans(date, groupCode) { return rpc('bm_admin_reset_group_scans', { date, group_code: groupCode }); },
        /** Unloading / Admin day report: every truck of `date` (default today) with vendor, weights and results. Today's opens from 9 PM. */
        async getDayReport(date) { return rpc('bm_unloading_day_report', { date: date || null }); },
        // --- Bottom sampling (Unloading requests with a password; Entry generates the new QR) and the Admin mixing-code search ---
        async requestBottomSample(truckId, password, reason) { return rpc('bm_unloading_request_bottom', { truck_id: truckId, password: password, reason: reason || '' }); },
        async getBottomRequests() { return (await rpc('bm_entry_bottom_list', {})) || []; },
        async generateBottomSample(truckId) { return rpc('bm_entry_bottom_generate', { truck_id: truckId }); },
        async reprintBottomSample(truckId) { return rpc('bm_entry_bottom_reprint', { truck_id: truckId }); },
        async setBottomPassword(password) { return rpc('bm_admin_set_bottom_password', { password: password }); },
        async getBottomStatus() { return rpc('bm_admin_bottom_status', {}); },
        async searchMixingCode(code) { return rpc('bm_admin_mixing_search', { code: String(code || '').trim() }); },
        // --- Unloading: cancel the QR of a truck (password + reason) / Lab 2: open a composite by mixing code + date ---
        async cancelQr(truckId, reasonCode, note, password) { return rpc('bm_unloading_cancel_qr', { truck_id: truckId, reason_code: reasonCode, note: note || '', password: password }); },
        async getCompositeByCode(code, date) { return rpc('bm_lab2_composite_by_code', { code: String(code || '').trim(), date: date || null }); },
        async getSuperAlerts() { return rpc('bm_admin_super_alerts', {}); },
        async ackSuperAlerts() { return rpc('bm_admin_super_ack', {}); },
        // --- SUPER ADMIN (the server refuses everybody else) ---
        async superDetail(v) { return rpc('bm_super_truck_detail', v); },
        async superEditTruck(v) { return rpc('bm_super_edit_truck', v); },
        async superForceComposite(v) { return rpc('bm_super_force_composite', v); },
        async superReplaceQr(v) { return rpc('bm_super_replace_qr', v); },
        async superVoidComposite(v) { return rpc('bm_super_void_composite', v); },
        async superVoidTruck(v) { return rpc('bm_super_void_truck', v); },
        async superRestoreTruck(v) { return rpc('bm_super_restore_truck', v); },
        async superCancelQr(v) { return rpc('bm_super_cancel_qr', v); },
        async superBottom(v) { return rpc('bm_super_bottom', v); },
        async superOverride(v) { return rpc('bm_super_set_override', v); },
        async superLogins() { return rpc('bm_super_logins', {}); },
        async superLogs() { return rpc('bm_super_logs', {}); },
        async superConvertLot(v) { return rpc('bm_super_convert_lot', v); },
        async superMergeGroup(v) { return rpc('bm_super_merge_group', v); },
        /** every vendor entry incl. retired ones (Admin / Super Admin) */
        async getCompaniesAll() { return (await rpc('bm_list_companies', { include_retired: 'true' })) || []; },
        async superSetLogin(v) { return rpc('bm_super_set_login', v); },
        async superHealth() { return rpc('bm_super_health', {}); },
        async superHealthFix(v) { return rpc('bm_super_health_fix', v); },
        async mixingSearch(code) { return rpc('bm_admin_mixing_search', { code: String(code || '').trim() }); },
        /** Re-check the signed-in person's password (Super Admin edit session) without changing the current session. */
        async verifyPassword(password) {
            const u = this.getCurrentUser();
            if (!u) return false;
            try {
                const r = await _nativeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                    method: 'POST', headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: `${u.username}@${LOGIN_EMAIL_DOMAIN}`, password: String(password) })
                });
                return r.ok;
            } catch (e) { return false; }
        },
        // --- SUPER ADMIN (older) ---
        async superFind(q, from, to) { return rpc('bm_super_find', { q: String(q || '').trim(), from: from || null, to: to || null }); },
        async superFeedLab1(v) { return rpc('bm_super_feed_lab1', v); },
        async superFeedComposite(v) { return rpc('bm_super_feed_composite', v); },
        async superLogAction(action, details) { try { return await rpc('bm_super_log_action', { action, details: String(details || '').slice(0, 700) }); } catch (e) { console.warn('log failed', e); } },
        async getCompositeBatchByGroupCode(groupCode, date) { return rpc('bm_lab2_get_batch', { group_code: groupCode, date: date || null }); },
        async getCompositeDetails(code) { return rpc('bm_get_composite_details', { code }); },
        /** Lab 2 enters the AIR-DRIED values; the database calculates TM, X and the ARB values. v = {ad_moisture, ad_gcv, ad_ash, ad_sulphur?, ad_vm?} */
        async submitCompositeResult(code, v, overrideReason) {
            const p = { code, override_reason: overrideReason || '' };
            ['ad_moisture', 'ad_gcv', 'ad_ash', 'ad_sulphur', 'ad_vm'].forEach(k => { if (v && v[k] !== undefined && v[k] !== null && v[k] !== '') p[k] = String(v[k]); });
            return rpc('bm_submit_composite_result', p);
        },
        async getLab2History() { return (await rpc('bm_get_lab2_history', {})) || []; },

        // --- ADMIN --------------------------------------------------------------------
        async getCompositeBatches() { return (await rpc('bm_admin_composites', {})) || []; },

        async updateRefereeChallenge(compositeRefId, payload) {
            const p = { composite_ref_id: compositeRefId };
            if (payload.vendorGcv !== undefined)    p.vendorGcv = payload.vendorGcv === '' ? '' : String(payload.vendorGcv);
            if (payload.refereeGcv !== undefined)   p.refereeGcv = payload.refereeGcv === '' ? '' : String(payload.refereeGcv);
            if (payload.refereeStatus !== undefined) p.refereeStatus = payload.refereeStatus;
            if (payload.overrideReason) p.override_reason = payload.overrideReason;
            return rpc('bm_admin_update_referee', p);
        },

        async getAllDashboardData() {
            const d = await rpc('bm_admin_dashboard', {});
            return { trucks: d.trucks || [], lab1: d.lab1 || [], composites: d.composites || [] };
        },

        async getAdminReport(companyName, date) {
            const d = await rpc('bm_admin_dashboard', { company: companyName, from: date, to: date });
            const lab1Map = {};
            (d.lab1 || []).forEach(r => { lab1Map[r.sample1_barcode_id] = r; });
            const compByBarcode = {};
            (d.composites || []).forEach(c => { compByBarcode[c.composite_barcode_id] = c; });
            const self = this;

            const reportRows = (d.trucks || []).map(truck => {
                const l1 = lab1Map[truck.sample1_barcode_id] || {};
                // exact link stamped when Lab-2 created the composite (no fuzzy group-code matching)
                const composite = truck.composite_barcode_id ? compByBarcode[truck.composite_barcode_id] : null;
                const moistureVal = num(l1.moisture_pct);
                // the server decides (LOT4 trucks are never rejected for moisture)
                const acceptance = truck.acceptance_status || self.evaluateAcceptance(moistureVal);
                const hasGcv = composite && composite.gcv_value !== null && composite.gcv_value !== undefined;
                const hasAsh = composite && composite.ash_pct !== null && composite.ash_pct !== undefined;
                const rejectionReason = acceptance === 'CANCELLED' ? ('QR cancelled: ' + (truck.cancel_reason || ''))
                    : acceptance === 'REJECTED'
                    ? (moistureVal !== null ? `Moisture ${moistureVal}% ≥ ${MOISTURE_REJECT_LIMIT.toFixed(1)}% limit` : 'REJECTED')
                    : acceptance === 'ACCEPTED' ? (truck.lot === 'LOT4' ? 'Accepted (Lot-4: no moisture rejection)' : `Passed (Moisture < ${MOISTURE_REJECT_LIMIT.toFixed(1)}%)`) : 'Pending Moisture Test';
                const chVal = truck.invoice_no || truck.challan_no || '';
                return {
                    truck_id: truck.truck_id, truck_reg_number: truck.truck_reg_number,
                    invoice_no: chVal, challan_no: chVal,
                    acceptance_status: acceptance, rejection_reason: rejectionReason, cancel_reason: truck.cancel_reason || null,
                    mixing_group_code: truck.daily_group_code || '',
                    driver_name: truck.driver_name, entry_time: truck.entry_time,
                    has_photo: !!truck.has_photo,
                    lot: truck.lot || 'LOT2/3', excluded_from_mix: !!truck.excluded_from_mix,
                    gross_weight: num(truck.gross_weight), tare_weight: num(truck.tare_weight),
                    net_weight: num(truck.net_weight) || 0,                      // the weight as actually weighed, rejected or not
                    sample1_barcode: truck.sample1_barcode_id,
                    composite_barcode: composite ? (composite.composite_barcode_id || composite.composite_ref_id) : null,
                    gcv_value: hasGcv ? Number(composite.gcv_value) : null,
                    ash_pct: hasAsh ? Number(composite.ash_pct) : null,
                    tm: composite && composite.tm_value != null ? Number(composite.tm_value) : null,
                    arb_sulphur: composite && composite.arb_sulphur != null ? Number(composite.arb_sulphur) : null,
                    arb_vm: composite && composite.arb_vm != null ? Number(composite.arb_vm) : null,
                    vendor_gcv: composite && composite.vendor_gcv != null ? Number(composite.vendor_gcv) : null,
                    referee_gcv: composite && composite.referee_gcv != null ? Number(composite.referee_gcv) : null,
                    referee_status: composite ? (composite.referee_status || null) : null,
                    lab2_tested_at: composite ? composite.tested_at : null,
                    moisture_pct: moistureVal, fineness_value: num(l1.fineness_value), lab1_tested_at: l1.tested_at ?? null
                };
            });

            let totalNetWeight = 0, sumMoisture = 0, sumFineness = 0, moistureCount = 0, finenessCount = 0, acceptedCount = 0, rejectedCount = 0, cancelledCount = 0;
            reportRows.forEach(r => {
                if (r.acceptance_status === 'CANCELLED') cancelledCount++;
                if (r.acceptance_status === 'ACCEPTED') acceptedCount++;
                if (r.acceptance_status === 'REJECTED') rejectedCount++;
                totalNetWeight += r.net_weight;
                if (r.moisture_pct !== null) { sumMoisture += r.moisture_pct; moistureCount++; }
                if (r.fineness_value !== null) { sumFineness += r.fineness_value; finenessCount++; }
            });
            const seen = new Set(); let sumGcv = 0, sumAsh = 0, compositeCount = 0, sumS = 0, sumVm = 0, lot4Count = 0;
            const tmList = [];
            reportRows.forEach(r => {
                if (!r.composite_barcode || seen.has(r.composite_barcode)) return;
                seen.add(r.composite_barcode);
                const comp = compByBarcode[r.composite_barcode];
                if (comp && comp.gcv_value !== null && comp.gcv_value !== undefined) {
                    sumGcv += Number(comp.gcv_value); sumAsh += Number(comp.ash_pct); compositeCount++;
                    if (comp.arb_sulphur != null) { sumS += Number(comp.arb_sulphur); sumVm += Number(comp.arb_vm); lot4Count++; }
                }
                // the vendor's TM: the composites of the trucks that are in the normal mixture (a bottom-sampled truck has its own composite)
                if (!r.excluded_from_mix && comp && comp.tm_value != null) tmList.push(Number(comp.tm_value));
            });
            const hasLot4 = reportRows.some(r => r.lot === 'LOT4');
            return {
                company_name: companyName, date, rows: reportRows,
                summary: {
                    truck_count: reportRows.length, accepted_count: acceptedCount, rejected_count: rejectedCount, cancelled_count: cancelledCount,
                    total_net_weight: totalNetWeight,
                    avg_moisture: moistureCount > 0 ? Number((sumMoisture / moistureCount).toFixed(2)) : null,
                    tm: tmList.length ? Number((tmList.reduce((a, b) => a + b, 0) / tmList.length).toFixed(2)) : null,
                    has_lot4: hasLot4,
                    avg_sulphur: lot4Count > 0 ? Number((sumS / lot4Count).toFixed(2)) : null,
                    avg_vm: lot4Count > 0 ? Number((sumVm / lot4Count).toFixed(2)) : null,
                    avg_fineness: finenessCount > 0 ? Number((sumFineness / finenessCount).toFixed(2)) : null,
                    avg_gcv: compositeCount > 0 ? Number((sumGcv / compositeCount).toFixed(0)) : null,
                    avg_ash: compositeCount > 0 ? Number((sumAsh / compositeCount).toFixed(2)) : null
                }
            };
        },

        // --- COMMERCIAL LOGISTICS REPORT (no lab metrics beyond accept/reject) --------
        async getLogisticsWeightReport({ period, date, companyName }) {
            const refYmd = toYMD(date) || todayIST();
            let startDateStr, endDateStr;
            if (period === 'week') { startDateStr = addDaysYMD(refYmd, -6); endDateStr = refYmd; }
            else if (period === 'month') {
                const [y, m] = refYmd.split('-').map(Number);
                startDateStr = `${y}-${pad2(m)}-01`;
                endDateStr = ymdFromUTCFields(new Date(Date.UTC(y, m, 0)));
            } else { startDateStr = refYmd; endDateStr = refYmd; }

            let trucks = (await rpc('bm_get_trucks', { from: startDateStr, to: endDateStr })) || [];
            if (companyName && companyName !== 'ALL') trucks = trucks.filter(t => t.company_name === companyName);

            let unloadedCount = 0, totalGrossWeight = 0, totalNetWeight = 0, approvedCount = 0, rejectedCount = 0, pendingCount = 0;
            const companyBreakdown = {};
            const rows = trucks.map(t => {
                const status = t.acceptance_status || this.evaluateAcceptance(num(t.moisture_pct));
                const g = Number(t.gross_weight) || 0, tr = Number(t.tare_weight) || 0;
                const isUnloaded = tr > 0;
                const net = (g > 0 && tr > 0 && g > tr) ? (g - tr) : (Number(t.net_weight) || 0);
                totalGrossWeight += g;
                if (isUnloaded) { unloadedCount++; totalNetWeight += net; }
                if (status === 'ACCEPTED') approvedCount++; else if (status === 'REJECTED' || status === 'CANCELLED') rejectedCount++; else pendingCount++;
                const cName = t.company_name || 'Unknown';
                const cb = companyBreakdown[cName] || (companyBreakdown[cName] = {
                    company_name: cName, total_trucks: 0, unloaded_trucks: 0, gross_weight: 0, net_weight: 0,
                    approved_count: 0, rejected_count: 0, pending_count: 0 });
                cb.total_trucks++; cb.gross_weight += g;
                if (isUnloaded) { cb.unloaded_trucks++; cb.net_weight += net; }
                if (status === 'ACCEPTED') cb.approved_count++; else if (status === 'REJECTED' || status === 'CANCELLED') cb.rejected_count++; else cb.pending_count++;
                return {
                    truck_id: t.truck_id, entry_date: t.entry_date, entry_time: t.entry_time, company_name: t.company_name,
                    truck_reg_number: t.truck_reg_number, invoice_no: t.invoice_no || t.challan_no || '', driver_name: t.driver_name,
                    gross_weight: g, tare_weight: tr, net_weight: net, is_unloaded: isUnloaded, acceptance_status: status, cancel_reason: t.cancel_reason || null
                };
            });
            return {
                period, date, start_date: startDateStr, end_date: endDateStr, company_filter: companyName || 'ALL',
                summary: {
                    total_trucks: trucks.length, unloaded_trucks: unloadedCount,
                    total_gross_weight_kg: totalGrossWeight, total_gross_weight_mt: Number((totalGrossWeight / 1000).toFixed(2)),
                    total_net_weight_kg: totalNetWeight, total_net_weight_mt: Number((totalNetWeight / 1000).toFixed(2)),
                    approved_trucks: approvedCount, rejected_trucks: rejectedCount, pending_trucks: pendingCount
                },
                company_breakdown: Object.values(companyBreakdown), rows
            };
        },

        async inspectBarcode(code) { return rpc('bm_admin_inspect', { code: String(code || '').trim() }); },

        /** Evidence photos are NOT bulk-loaded. kind: truck | moisture | fineness_initial | fineness_final. Admin only. */
        async getEvidencePhoto(kind, id) {
            const r = await rpc('bm_admin_photo', { kind, id });
            const v = r ? r.photo : null;
            if (v && String(v).startsWith('purged:')) throw new Error('This photo was deleted on ' + String(v).slice(7) + ' to free storage space (the record itself is unchanged).');
            if (!v || !String(v).startsWith('ev/')) return v;            // empty, or an older photo stored inside the record
            const token = await getToken();
            const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${EVIDENCE_BUCKET}/${String(v).slice(3)}`,
                                    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('The photo file could not be loaded from Storage (HTTP ' + res.status + ').');
            return URL.createObjectURL(await res.blob());
        },

        // --- STORAGE SPACE (Admin): keep the photo bucket under its limit ---------------------------------
        async getStorageStatus() { const s = await rpc('bm_admin_storage_status', {}); return Object.assign({ limit: STORAGE_LIMIT_BYTES }, s); },

        /** Which of the OLDEST photos would have to go to bring usage down to targetPercent of the limit?
         *  Never touches photos newer than keepDays or those of a lot with an open referee challenge (the database decides that). */
        async planPhotoCleanup(opts) {
            const o = Object.assign({ targetPercent: 75, keepDays: 60 }, opts || {});
            const st = await this.getStorageStatus();
            const need = st.bytes - st.limit * o.targetPercent / 100;
            if (need <= 0) return { status: st, items: [], freeBytes: 0, need: 0, enough: true, keepDays: o.keepDays, targetPercent: o.targetPercent };
            const cand = (await rpc('bm_admin_photo_purge_candidates', { keep_days: o.keepDays, limit: 50000 })) || [];
            const items = []; let free = 0;
            for (const c of cand) { if (free >= need) break; items.push(c); free += Number(c.bytes) || 0; }
            return { status: st, items, freeBytes: free, need, enough: free >= need, keepDays: o.keepDays, targetPercent: o.targetPercent };
        },

        /** Delete the planned photos: file first, then the record is marked 'purged:<date>' (the database refuses to mark a file that still exists). */
        async runPhotoCleanup(items, onProgress) {
            let done = 0, failed = 0, freed = 0;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                try {
                    const token = await getToken();
                    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${EVIDENCE_BUCKET}/${String(it.path).slice(3)}`,
                                            { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` } });
                    if (!res.ok && res.status !== 404) throw new Error('Storage refused the delete (HTTP ' + res.status + ')');
                    await rpc('bm_admin_mark_photo_purged', { kind: it.kind, id: it.id, path: it.path });
                    done++; freed += Number(it.bytes) || 0;
                } catch (e) { failed++; console.warn('Could not remove photo', it.path, e); }
                if (onProgress) onProgress(i + 1, items.length);
            }
            if (done) {
                try {
                    await rpc('bm_log_activity', { action: 'PHOTOS_PURGED', details: `${done} old photo(s) deleted to free about ${(freed / 1048576).toFixed(1)} MB of storage (oldest ${String(items[0].created).slice(0, 10)}). Not removed: ${failed}.` });
                } catch (e) { /* the log line is a courtesy; the cleanup itself already happened */ }
            }
            return { done, failed, freed };
        },

        // --- AUDIT LOG ----------------------------------------------------------------
        async logActivity(actionName, detailsText) {
            const user = this.getCurrentUser();
            if (!user) throw new Error('Not logged in');
            return rpc('bm_log_activity', { action: actionName, details: detailsText });
        },
        async getActivityLogs() { return (await rpc('bm_admin_logs', {})) || []; },

        // --- HEALTH -------------------------------------------------------------------------
        async getSupabaseHealth() {
            const t0 = performance.now();
            try {
                const h = await rpc('bm_admin_health', {});
                return Object.assign({}, h, { latency_ms: Math.round(performance.now() - t0) });
            } catch (e) { return { success: false, error: e.message }; }
        },

        resetLocalDB() {
            alert('Database reset is not available. Use the Supabase dashboard (SQL editor) if data must be cleared.');
        }
    };

})();
