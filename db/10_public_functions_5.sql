-- public.bm_* functions, batch 5 of 5 (bm_super_ip_logs ... bm_whoami) plus one legacy trigger function, exactly as dumped.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bm_super_ip_logs(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ip text := nullif(btrim(coalesce(p->>'ip', '')), ''); v_q text := nullif(btrim(coalesce(p->>'q', '')), ''); v_n int := least(coalesce(nullif(p->>'limit', '')::int, 500), 3000);
begin
    perform bm.require_super();
    return coalesce((select jsonb_agg(jsonb_build_object('timestamp', x.timestamp, 'username', x.username, 'action', x.action, 'details', x.details, 'ip', x.ip, 'device', x.device, 'device_name', coalesce((select dd.name from bm.trusted_devices dd where dd.id = x.device_id), x.device_name),
                                                          'ip_label', bm.ip_label(x.ip)) order by x.id desc)
                       from (select * from bm.activity_logs a
                              where (v_ip is null or a.ip = v_ip or bm.ip_key(a.ip) = v_ip or (position('/' in v_ip) > 0 and bm.ip_in_range(a.ip, v_ip))) and (v_q is null or a.details ilike '%' || v_q || '%' or a.action ilike '%' || v_q || '%' or a.username ilike '%' || v_q || '%' or a.device_name ilike '%' || v_q || '%' or exists (select 1 from bm.trusted_devices dd where dd.id = a.device_id and dd.name ilike '%' || v_q || '%'))
                              order by a.id desc limit v_n) x), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_ip_range_label(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_in text := btrim(coalesce(p->>'range', '')); v_l text := nullif(btrim(regexp_replace(coalesce(p->>'label', ''), '\s+', ' ', 'g')), ''); c cidr; v_n int;
begin
    perform bm.require_super();
    if v_l is null or length(v_l) < 2 or length(v_l) > 60 or not bm.is_safe_text(v_l) then raise exception 'The name must be 2 to 60 characters, without special characters'; end if;
    begin c := v_in::cidr; exception when others then raise exception 'That is not a valid range. Examples: 152.58.0.0/16 or 2401:4900:1a2b:3c4d::/64'; end;
    if family(c) = 4 and masklen(c) < 16 then raise exception 'An IPv4 range must be /16 or narrower (it covers at most 65,536 addresses)'; end if;
    if family(c) = 6 and masklen(c) < 48 then raise exception 'An IPv6 range must be /48 or narrower'; end if;
    insert into bm.known_ips(ip, label, labelled_by, labelled_at, last_user, last_action) values (c::text, v_l, bm.uname(), now(), bm.uname(), 'RANGE_NAMED')
    on conflict (ip) do update set label = excluded.label, labelled_by = excluded.labelled_by, labelled_at = excluded.labelled_at;
    update bm.known_ips k set label = v_l, labelled_by = bm.uname(), labelled_at = now() where k.ip <> c::text and k.label is null and bm.ip_in_range(k.ip, c::text);
    get diagnostics v_n = row_count;
    perform bm.super_log('IP_RANGE_LABELLED', format('Range %s named "%s" (%s listed address(es) inside it took the name)', c, v_l, v_n));
    return jsonb_build_object('success', true, 'range', c::text, 'addresses_named', v_n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_ips(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('unknown', (select count(*) from bm.known_ips where label is null),
        'ips', coalesce((select jsonb_agg(jsonb_build_object('ip', k.ip, 'label', k.label, 'first_seen', to_char(k.first_seen at time zone 'UTC' + interval '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI'),
                         'last_seen', to_char(k.last_seen at time zone 'UTC' + interval '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI'), 'seen_count', k.seen_count,
                         'last_user', k.last_user, 'last_action', k.last_action, 'device', k.device, 'labelled_by', k.labelled_by) order by (k.label is null) desc, k.last_seen desc)
                         from bm.known_ips k), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_lock_set(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_on boolean := coalesce((p->>'on')::boolean, false); v_reason text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_on then
        if not exists (select 1 from bm.verified_sessions v where v.session_id = bm.jwt_claim('session_id') and v.user_id = auth.uid()) then
            raise exception 'This session is not verified by a trusted device. Trust this device first, then switch the lock on.'; end if;
        if not exists (select 1 from bm.trusted_devices d where d.user_id = auth.uid() and d.status = 'TRUSTED') then raise exception 'There is no trusted device yet'; end if;
    end if;
    insert into bm.settings(key, value) values ('super_lock', case when v_on then 'on' else 'off' end) on conflict (key) do update set value = excluded.value, updated_at = now();
    perform bm.super_log('DEVICE_LOCK', 'Super Admin device lock switched ' || case when v_on then 'ON' else 'OFF' end || '. Reason: ' || v_reason);
    return jsonb_build_object('success', true, 'lock', v_on);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_log_action(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_a text := upper(btrim(coalesce(p->>'action', '')));
begin
    perform bm.require_super();
    if v_a not in ('QR_PRINT', 'QR_DOWNLOAD') then raise exception 'Unknown action'; end if;
    perform bm.super_log(v_a, translate(coalesce(p->>'details', ''), '<>"`', '‹›″´'));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_login_lock(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_user text := lower(btrim(coalesce(p->>'username', ''))); v_on boolean := coalesce((p->>'on')::boolean, false); v_all boolean := coalesce((p->>'all')::boolean, false);
        v_reason text; pr bm.profiles; n int := 0; v_skipped text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_all then
        if v_on then
            update bm.profiles x set device_lock = true
             where x.active and x.role <> 'superadmin' and not x.mfa_exempt and not x.device_lock
               and exists (select 1 from bm.trusted_devices d where d.user_id = x.id and d.status = 'TRUSTED');
            get diagnostics n = row_count;
            select string_agg(x.username, ', ' order by x.username) into v_skipped from bm.profiles x where x.active and x.role <> 'superadmin' and not x.mfa_exempt and not x.device_lock;
        else
            update bm.profiles set device_lock = false where role <> 'superadmin' and device_lock;
            get diagnostics n = row_count;
        end if;
        perform bm.super_log('DEVICE_LOCK_LOGIN', format('Device lock switched %s for %s login(s)%s. Reason: %s', case when v_on then 'ON' else 'OFF' end, n,
                             case when v_skipped is not null then ' (still without an approved computer: ' || v_skipped || ')' else '' end, v_reason));
        return jsonb_build_object('success', true, 'changed', n, 'skipped', v_skipped);
    end if;
    select * into pr from bm.profiles where username = v_user and active;
    if not found then raise exception 'There is no active login "%"', v_user; end if;
    if pr.role = 'superadmin' then raise exception 'The Super Admin lock is switched above, not here'; end if;
    if v_on and pr.mfa_exempt then raise exception 'A machine login cannot be locked to a computer'; end if;
    if v_on and not exists (select 1 from bm.trusted_devices d where d.user_id = pr.id and d.status = 'TRUSTED') then
        raise exception 'The login % has no approved computer yet - it would be locked out. Approve a computer for it first.', v_user;
    end if;
    update bm.profiles set device_lock = v_on where id = pr.id;
    perform bm.super_log('DEVICE_LOCK_LOGIN', format('Device lock of the login %s switched %s. Reason: %s', v_user, case when v_on then 'ON' else 'OFF' end, v_reason));
    return jsonb_build_object('success', true, 'username', v_user, 'lock', v_on);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_logins(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('logins', coalesce((select jsonb_agg(jsonb_build_object('username', username, 'role', role, 'name', name, 'active', active,
                                                   'locked', (select count(*) >= 5 from bm.bottom_pw_fails f where f.username = pr.username and f.at > now() - interval '10 minutes')) order by role, username)
                                                   from bm.profiles pr), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_logs(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object(
        'changes', coalesce((select jsonb_agg(jsonb_build_object('timestamp', a.timestamp, 'username', a.username, 'action', a.action, 'details', a.details, 'ip', a.ip, 'device', a.device, 'device_name', coalesce((select dd.name from bm.trusted_devices dd where dd.id = a.device_id), a.device_name)) order by a.id desc)
                               from (select * from bm.activity_logs where action like 'SUPERADMIN\_%' or action in ('ADMIN_VALUE_EDIT', 'ADMIN_EDIT_PASSWORD_WRONG') order by id desc limit 3000) a), '[]'::jsonb),
        'submissions', coalesce((select jsonb_agg(jsonb_build_object('timestamp', q.timestamp, 'username', q.username, 'role', q.role, 'action', q.action, 'ref', q.ref, 'summary', q.summary) order by q.id desc)
                               from (select a.id, a.timestamp, a.username, a.action, pr.role, r.ref,
                                            case a.action
                                              when 'LAB1_RESULT' then
                                                  case when pr.role = 'lab1m' then 'Moisture ' || coalesce(r.m_log, trim_scale(l.moisture_pct)::text, '-') || ' %'
                                                       when pr.role = 'lab1f' then 'Fineness ' || coalesce(r.f_log, trim_scale(l.fineness_value)::text, '-') || ' % (initial ' || coalesce(trim_scale(l.fineness_initial_weight)::text, '-') || ' kg, final ' || coalesce(trim_scale(l.fineness_final_weight)::text, '-') || ' kg)'
                                                       else 'Moisture ' || coalesce(r.m_log, trim_scale(l.moisture_pct)::text, '-') || ' %, fineness ' || coalesce(r.f_log, trim_scale(l.fineness_value)::text, '-') || ' %' end
                                                  || ' submitted for sample ' || coalesce(r.ref, '?')
                                              when 'LAB1_OVERRIDE' then 'Sample ' || coalesce(r.ref, '?') || ' corrected by the Admin (now moisture ' || coalesce(trim_scale(l.moisture_pct)::text, '-') || ' %, fineness ' || coalesce(trim_scale(l.fineness_value)::text, '-') || ' %)'
                                              else 'AD moisture ' || coalesce(trim_scale(c.ad_moisture)::text, '-') || ' %, AD GCV ' || coalesce(trim_scale(c.ad_gcv)::text, '-') || ', AD ash ' || coalesce(trim_scale(c.ad_ash)::text, '-') || ' %'
                                                   || case when c.ad_sulphur is not null then ', AD sulphur ' || trim_scale(c.ad_sulphur) || ' %, AD VM ' || coalesce(trim_scale(c.ad_vm)::text, '-') || ' %' else '' end
                                                   || ' submitted for composite ' || coalesce(r.ref, '?') || ' (TM ' || coalesce(round(c.tm_value, 2)::text, '-') || ' %, ARB GCV ' || coalesce(trim_scale(c.gcv_value)::text, '-') || ', ARB ash ' || coalesce(trim_scale(c.ash_pct)::text, '-') || ' %)'
                                                   || case when a.action = 'COMPOSITE_OVERRIDE' then ' [corrected by the Admin]' else '' end
                                            end as summary
                                       from bm.activity_logs a
                                       left join bm.profiles pr on pr.username = a.username
                                       cross join lateral (select (regexp_match(a.details, 'S1-[A-Z0-9]+|CMP-[0-9]+-[0-9]+'))[1] as ref,
                                                                  (regexp_match(a.details, 'moisture ([0-9.]+),'))[1] as m_log,
                                                                  (regexp_match(a.details, 'fineness ([0-9.]+) \('))[1] as f_log) r
                                       left join bm.lab1_results l on l.sample1_barcode_id = r.ref
                                       left join bm.composite_batches c on c.composite_ref_id = r.ref
                                      where a.action in ('LAB1_RESULT', 'LAB1_OVERRIDE', 'COMPOSITE_RESULT', 'COMPOSITE_OVERRIDE')
                                      order by a.id desc limit 2000) q), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_merge_group(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_dry boolean := coalesce(p->>'dry_run', '') = 'true'; v_date date := nullif(p->>'date', '')::date;
    v_from text := upper(btrim(coalesce(p->>'from_code', ''))); v_to text := upper(btrim(coalesce(p->>'to_code', '')));
    v_tid text := nullif(btrim(coalesce(p->>'truck_id', '')), ''); v_keep boolean := coalesce(p->>'keep_rejected', '') = 'true';
    v_ids text[]; v_tname text; v_tlot text; v_tpo text; v_n int; v_sc int; v_turn int; v_comp text; v_reason text; v_before jsonb; v_src_lot text;
begin
    perform bm.require_super();
    if v_date is null or v_from = '' or v_to = '' then raise exception 'Give the date and both mixing codes'; end if;
    if v_from = v_to then raise exception 'The two mixing codes are the same'; end if;
    select x.company_name, x.lot, x.po_number into v_tname, v_tlot, v_tpo
      from (select t.company_name, t.lot, t.po_number, count(*) c from bm.trucks t
             where t.entry_date = v_date and t.daily_group_code = v_to and t.bottom_of is null and t.cancel_status is distinct from 'VOIDED'
             group by 1, 2, 3 order by c desc limit 1) x;
    if v_tname is null then raise exception 'No truck has the mixing code % on %', v_to, to_char(v_date, 'DD-MM-YYYY'); end if;
    select array_agg(t.truck_id), min(t.lot) into v_ids, v_src_lot from bm.trucks t
     where t.entry_date = v_date and t.daily_group_code = v_from and t.bottom_of is null and (v_tid is null or t.truck_id = v_tid);
    if v_ids is null then raise exception 'No truck%  has the mixing code % on %', case when v_tid is not null then ' ' || v_tid else '' end, v_from, to_char(v_date, 'DD-MM-YYYY'); end if;
    if exists (select 1 from bm.trucks t where t.truck_id = any(v_ids) and bm.norm_vendor(t.company_name) <> bm.norm_vendor(v_tname)) then
        raise exception 'The two mixing codes belong to different vendors. Only codes of the same vendor and day can be combined.'; end if;
    select b.composite_ref_id into v_comp from bm.composite_batches b where b.date = v_date and b.daily_group_code in (v_from, v_to) limit 1;
    if v_comp is not null then raise exception 'The composite % already exists for one of these mixing codes. Void it first (Toolbox tool 5), combine, then create the composite again.', v_comp; end if;
    select count(*), count(*) filter (where exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = t.sample1_barcode_id)) into v_n, v_sc from bm.trucks t where t.truck_id = any(v_ids);
    select count(*) into v_turn from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
     where t.truck_id = any(v_ids) and t.cancel_status is null and t.acceptance_override is null and bm.is_lot4(v_tlot) and not bm.is_lot4(t.lot) and bm.accept(l.moisture_pct, t.lot) = 'REJECTED';
    v_before := bm.mixing_progress(v_date, v_to);
    if not v_dry then
        v_reason := bm.super_reason(p);
        if v_keep then
            update bm.trucks t set acceptance_override = 'REJECTED',
                   override_reason = 'Rejected under the Lot-3 rule (moisture ' || coalesce((select l.moisture_pct::text from bm.lab1_results l where l.sample1_barcode_id = t.sample1_barcode_id), '?') || ' %) before it was combined into a Lot-4 mixing code'
             where t.truck_id = any(v_ids) and t.cancel_status is null and t.acceptance_override is null and bm.is_lot4(v_tlot) and not bm.is_lot4(t.lot)
               and bm.accept((select l.moisture_pct from bm.lab1_results l where l.sample1_barcode_id = t.sample1_barcode_id), t.lot) = 'REJECTED';
        end if;
        update bm.trucks t set daily_group_code = v_to, company_name = v_tname, lot = v_tlot, po_number = v_tpo where t.truck_id = any(v_ids);
        update bm.trucks t set company_name = v_tname, lot = v_tlot, po_number = v_tpo where t.bottom_of = any(v_ids);
        update bm.mixing_groups g set lot = v_tlot where g.company_name in (select 'BOTTOM:' || x from unnest(v_ids) x);
        update bm.mixing_scans m set group_code = v_to where m.sample1_barcode_id in (select t.sample1_barcode_id from bm.trucks t where t.truck_id = any(v_ids));
        update bm.trucks x set acceptance_status = bm.truck_status(x, (select l.moisture_pct from bm.lab1_results l where l.sample1_barcode_id = x.sample1_barcode_id))
         where x.truck_id = any(v_ids);
        perform bm.super_log('GROUP_MERGED', format('%s truck(s) (%s already scanned) of mixing code %s moved into mixing code %s on %s: %s %s, PO %s%s%s. Reason: %s',
            v_n, v_sc, v_from, v_to, to_char(v_date, 'DD-MM-YYYY'), v_tname, v_tlot, coalesce(v_tpo, 'none'),
            case when v_tid is not null then ' (single truck ' || v_tid || ')' else '' end,
            case when v_turn > 0 then case when v_keep then '; ' || v_turn || ' rejected truck(s) kept rejected' else '; ' || v_turn || ' Lot-3-rejected truck(s) now accepted (Lot-4 rule)' end else '' end, v_reason));
    end if;
    return jsonb_build_object('success', true, 'dry_run', v_dry, 'date', v_date, 'from_code', v_from, 'to_code', v_to, 'moved', v_n, 'moved_scanned', v_sc, 'target_name', v_tname,
                              'target_lot', v_tlot, 'target_po', v_tpo, 'from_lot', v_src_lot, 'turning_accepted', v_turn, 'target_before', v_before, 'target_after', bm.mixing_progress(v_date, v_to));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_mfa_exempt(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_user text := lower(btrim(coalesce(p->>'username', ''))); v_on boolean := coalesce((p->>'exempt')::boolean, false); v_reason text; pr bm.profiles;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into pr from bm.profiles where username = v_user and active;
    if not found then raise exception 'There is no active login "%"', v_user; end if;
    if pr.role <> 'admin' then raise exception 'Only an Admin-role login can be exempted (never the Super Admin or the other logins)'; end if;
    update bm.profiles set mfa_exempt = v_on where id = pr.id;
    perform bm.super_log('MFA_EXEMPT', format('Login %s %s the second step (machine login). Reason: %s', v_user, case when v_on then 'is EXEMPT from' else 'must use' end, v_reason));
    return jsonb_build_object('success', true, 'username', v_user, 'exempt', v_on);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_mfa_overview(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('required', coalesce((select value from bm.settings where key = 'mfa_required'), 'off') = 'on', 'aal', coalesce(bm.jwt_claim('aal'), 'aal1'),
        'people', coalesce((select jsonb_agg(jsonb_build_object('username', x.username, 'name', x.name, 'role', x.role, 'enrolled', bm.is_enrolled(x.id), 'exempt', x.mfa_exempt) order by x.role desc, x.username)
                              from bm.profiles x where x.active and x.role in ('admin', 'superadmin')), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_mfa_set(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_on boolean := coalesce((p->>'on')::boolean, false); v_reason text; v_missing text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_on then
        select string_agg(x.username, ', ') into v_missing from bm.profiles x where x.active and x.role in ('admin', 'superadmin') and not x.mfa_exempt and not bm.is_enrolled(x.id);
        if v_missing is not null then raise exception 'Not everyone has set up the authenticator app yet (%). Switching it on now would lock them out.', v_missing; end if;
        if coalesce(bm.jwt_claim('aal'), 'aal1') <> 'aal2' then raise exception 'Sign in again with the 6-digit code first, then switch the second step on.'; end if;
    end if;
    insert into bm.settings(key, value) values ('mfa_required', case when v_on then 'on' else 'off' end) on conflict (key) do update set value = excluded.value, updated_at = now();
    perform bm.super_log('MFA_REQUIRED', 'Second step (authenticator app) for the Admin and Super Admin logins switched ' || case when v_on then 'ON' else 'OFF' end || '. Reason: ' || v_reason);
    return jsonb_build_object('success', true, 'required', v_on);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_recovery_set(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; v_a bytea; v_b bytea; v_code text := ''; v_salt text; i int; v_raw int; v_idx int[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11];
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    v_a := uuid_send(gen_random_uuid()); v_b := uuid_send(gen_random_uuid());
    for i in 0 .. 19 loop
        v_raw := case when i < 10 then get_byte(v_a, v_idx[i + 1]) else get_byte(v_b, v_idx[i - 9]) end;       -- (bytes 6 and 8 of a UUID are not random)
        v_code := v_code || substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + (v_raw % 32), 1);
    end loop;
    v_salt := bm.rand_hex(16);
    insert into bm.settings(key, value) values ('super_recovery_salt', v_salt) on conflict (key) do update set value = excluded.value, updated_at = now();
    insert into bm.settings(key, value) values ('super_recovery_hash', bm.bottom_pw_hash(v_salt, v_code)) on conflict (key) do update set value = excluded.value, updated_at = now();
    perform bm.super_log('RECOVERY_CODE_CREATED', 'A new recovery code was created (the old one no longer works). Reason: ' || v_reason);
    return jsonb_build_object('success', true, 'code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4) || '-' || substr(v_code, 13, 4) || '-' || substr(v_code, 17, 4));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_recovery_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('set', exists (select 1 from bm.settings where key = 'super_recovery_hash'),
        'created_at', (select to_char(updated_at at time zone 'UTC' + interval '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI') from bm.settings where key = 'super_recovery_hash'));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_replace_qr(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; t bm.trucks; v_new text; v_old text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where sample1_barcode_id = btrim(coalesce(p->>'barcode', '')) for update;
    if not found then raise exception 'Sample not found'; end if;
    v_old := t.sample1_barcode_id;
    loop
        v_new := 'S1-' || upper(bm.rand_hex(8));
        exit when not exists (select 1 from bm.trucks where sample1_barcode_id = v_new) and not exists (select 1 from bm.qr_history where old_barcode = v_new);
    end loop;
    update bm.trucks set sample1_barcode_id = v_new where truck_id = t.truck_id;          -- results and scans follow (ON UPDATE CASCADE)
    insert into bm.qr_history(truck_id, old_barcode, new_barcode, changed_by, reason) values (t.truck_id, v_old, v_new, bm.uname(), v_reason);
    perform bm.super_log('QR_REPLACED', format('Sample QR of truck %s (%s) replaced: %s -> %s. Reason: %s', t.truck_id, t.truck_reg_number, v_old, v_new, v_reason));
    return jsonb_build_object('success', true, 'old_barcode', v_old, 'sample1_barcode_id', v_new, 'entry_date', t.entry_date, 'truck_reg_number', t.truck_reg_number);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_restore_truck(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; t bm.trucks;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and cancel_status is not null for update;
    if not found then raise exception 'This truck is not cancelled or voided'; end if;
    if exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code) then
        raise exception 'The composite of its mixing group exists. Void that composite first, restore the truck, then create the composite again.'; end if;
    update bm.trucks set cancel_status = null, cancel_code = null, cancel_reason = null, cancelled_by = null, cancelled_at = null where truck_id = t.truck_id;
    perform bm.super_log('TRUCK_RESTORED', format('Truck %s (%s) restored (was %s: %s). Reason: %s', t.truck_id, t.truck_reg_number, t.cancel_status, coalesce(t.cancel_reason, '-'), v_reason));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_set_action_password(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_pw text := coalesce(p->>'password', ''); v_salt text; v_reason text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if length(v_pw) < 6 then raise exception 'The unloading actions password must have at least 6 characters'; end if;
    if length(v_pw) > 100 then raise exception 'The unloading actions password is too long'; end if;
    v_salt := bm.rand_hex(16);
    insert into bm.settings(key, value) values ('bottom_pw_salt', v_salt), ('bottom_pw_hash', bm.bottom_pw_hash(v_salt, v_pw)), ('bottom_pw_enc', bm.pw_enc(v_pw))
    on conflict (key) do update set value = excluded.value, updated_at = now();
    delete from bm.bottom_pw_fails;                                  -- a new password also lifts any lock-out
    perform bm.super_log('ACTION_PASSWORD_SET', 'Unloading actions password (bottom sample, cancel QR, day report) was set / changed. Reason: ' || v_reason);
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_set_login(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; v_user text := btrim(coalesce(p->>'username', '')); v_act text := upper(btrim(coalesce(p->>'action', ''))); pr bm.profiles;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into pr from bm.profiles where username = v_user;
    if not found then raise exception 'Login not found'; end if;
    if v_act = 'UNLOCK' then
        delete from bm.bottom_pw_fails where username = v_user;
        perform bm.super_log('LOGIN_UNLOCKED', format('Wrong-password lock of login %s cleared. Reason: %s', v_user, v_reason));
    elsif v_act in ('DISABLE', 'ENABLE') then
        if pr.role = 'superadmin' then raise exception 'The Super Admin login cannot be disabled here.'; end if;
        if v_act = 'DISABLE' and pr.role = 'admin' and (select count(*) from bm.profiles where role = 'admin' and active) <= 1 then raise exception 'This is the last active Admin login.'; end if;
        update bm.profiles set active = (v_act = 'ENABLE') where username = v_user;
        perform bm.super_log('LOGIN_' || v_act || 'D', format('Login %s %s. Reason: %s', v_user, case when v_act = 'ENABLE' then 'enabled' else 'disabled (it can no longer use any function)' end, v_reason));
    else
        raise exception 'Unknown action';
    end if;
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_set_override(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; v_st text := upper(btrim(coalesce(p->>'status', ''))); t bm.trucks; l bm.lab1_results; v_before text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_st not in ('ACCEPTED', 'REJECTED', 'NONE') then raise exception 'Choose ACCEPTED, REJECTED or NONE (back to the moisture rule)'; end if;
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and bottom_of is null and cancel_status is null for update;
    if not found then raise exception 'Truck not found (or its QR is cancelled)'; end if;
    if exists (select 1 from bm.composite_batches c where c.parent_truck_ids ? t.truck_id or (c.date = t.entry_date and c.daily_group_code = t.daily_group_code)) then
        raise exception 'The composite of this truck''s mixing group exists. Void it first.'; end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    v_before := bm.truck_status(t, l.moisture_pct);
    update bm.trucks set acceptance_override = case when v_st = 'NONE' then null else v_st end, override_reason = case when v_st = 'NONE' then null else v_reason end where truck_id = t.truck_id;
    select * into t from bm.trucks where truck_id = t.truck_id;
    perform bm.super_log('STATUS_OVERRIDE', format('Truck %s (%s, moisture %s): %s -> %s. Reason: %s', t.truck_id, t.truck_reg_number, coalesce(l.moisture_pct::text, 'none'), v_before, bm.truck_status(t, l.moisture_pct), v_reason));
    return jsonb_build_object('success', true, 'status', bm.truck_status(t, l.moisture_pct));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_truck_detail(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_id text := btrim(coalesce(p->>'truck_id', '')); v_bar text := btrim(coalesce(p->>'barcode', '')); t bm.trucks; l bm.lab1_results;
begin
    perform bm.require_super();
    select * into t from bm.trucks where truck_id = v_id;
    if not found and v_bar <> '' then select * into t from bm.trucks where sample1_barcode_id = v_bar; end if;
    if not found then raise exception 'Truck not found'; end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    return jsonb_build_object('success', true,
        'truck', (to_jsonb(t) - 'photo_url') || jsonb_build_object('has_photo', coalesce(t.photo_url, '') <> ''),
        'lab1', case when l.sample1_barcode_id is null then null else bm.lab1_admin_json(l) end,
        'status', bm.truck_status(t, l.moisture_pct), 'mix_status', bm.mix_status(t, l.moisture_pct),
        'mixing_scanned', exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = t.sample1_barcode_id),
        'composites', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from bm.composite_batches c where c.parent_truck_ids ? coalesce(t.bottom_of, t.truck_id)), '[]'::jsonb),
        'group_composite', (select to_jsonb(c) from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code),
        'bottom_request', (select to_jsonb(r) from bm.bottom_requests r where r.truck_id = coalesce(t.bottom_of, t.truck_id)),
        'bottom_sample', (select to_jsonb(b) - 'photo_url' from bm.trucks b where b.bottom_of = t.truck_id order by b.created_at desc limit 1),
        'qr_history', coalesce((select jsonb_agg(to_jsonb(h) order by h.id) from bm.qr_history h where h.truck_id = t.truck_id), '[]'::jsonb),
        'audit', coalesce((select jsonb_agg(jsonb_build_object('timestamp', x.timestamp, 'username', x.username, 'action', x.action, 'details', x.details, 'ip', x.ip) order by x.id desc)
                             from (select * from bm.activity_logs a where a.details ilike '%' || t.truck_id || '%' or a.details ilike '%' || t.sample1_barcode_id || '%' order by a.id desc limit 40) x), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_void_composite(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; b bm.composite_batches; v_code text := btrim(coalesce(p->>'code', ''));
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into b from bm.composite_batches where upper(composite_ref_id) = upper(v_code) or upper(composite_barcode_id) = upper(v_code) or upper(test_lot) = upper(v_code) for update;
    if not found then raise exception 'Composite not found'; end if;
    perform set_config('bm.allow_override', 'on', true);
    insert into bm.voided_composites(composite_ref_id, snapshot, voided_by, reason) values (b.composite_ref_id, to_jsonb(b), bm.uname(), v_reason);
    update bm.trucks set composite_barcode_id = null where composite_barcode_id = b.composite_barcode_id;
    delete from bm.composite_batches where composite_ref_id = b.composite_ref_id;
    perform bm.super_log('COMPOSITE_VOIDED', format('Composite %s (mixing code %s, %s) voided; it can be created again. Its record (incl. GCV %s, ash %s) is archived. Reason: %s',
        b.composite_ref_id, b.daily_group_code, b.date, coalesce(b.gcv_value::text, '-'), coalesce(b.ash_pct::text, '-'), v_reason));
    return jsonb_build_object('success', true, 'date', b.date, 'group_code', b.daily_group_code);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_void_truck(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; t bm.trucks;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and bottom_of is null for update;
    if not found then raise exception 'Truck not found'; end if;
    if exists (select 1 from bm.composite_batches c where c.parent_truck_ids ? t.truck_id) then raise exception 'The truck is part of a composite. Void that composite first.'; end if;
    if exists (select 1 from bm.trucks b where b.bottom_of = t.truck_id and b.cancel_status is null) then raise exception 'A bottom sample exists for this truck. Undo it first.'; end if;
    update bm.trucks set cancel_status = 'VOIDED', cancel_code = 'SUPERADMIN', cancel_reason = v_reason, cancelled_by = bm.uname(), cancelled_at = now() where truck_id = t.truck_id;
    delete from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;
    perform bm.super_log('TRUCK_VOIDED', format('Truck %s (%s, %s) voided - hidden from every list and report. Reason: %s', t.truck_id, t.truck_reg_number, t.company_name, v_reason));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_unloading_cancel_qr(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_tid text := btrim(coalesce(p->>'truck_id', '')); v_code text := upper(btrim(coalesce(p->>'reason_code', '')));
    v_note text := nullif(btrim(coalesce(p->>'note', '')), ''); v_msg text; v_reason text; t bm.trucks;
begin
    perform bm.require(array['unloading', 'admin']);
    v_msg := bm.check_action_password(p->>'password', 'cancel QR');
    if v_msg is not null then return jsonb_build_object('success', false, 'message', v_msg); end if;
    if v_code not in ('DOCUMENTS', 'QUALITY', 'OTHER') then return jsonb_build_object('success', false, 'message', 'Choose a reason.'); end if;
    if v_note is not null and (length(v_note) > 300 or not bm.is_safe_text(v_note)) then
        return jsonb_build_object('success', false, 'message', 'The comment is too long or contains characters that are not allowed.'); end if;
    if v_code = 'OTHER' and (v_note is null or length(v_note) < 3) then
        return jsonb_build_object('success', false, 'message', 'Please write the reason in the comment box.'); end if;
    v_reason := case v_code when 'DOCUMENTS' then 'Vendor documents inconsistent' when 'QUALITY' then 'Poor quality biomass' else v_note end
                || case when v_code <> 'OTHER' and v_note is not null then ' - ' || v_note else '' end;
    select * into t from bm.trucks where truck_id = v_tid and bottom_of is null and cancel_status is distinct from 'VOIDED' for update;
    if not found then return jsonb_build_object('success', false, 'message', 'Truck not found.'); end if;
    if t.cancel_status is not null then return jsonb_build_object('success', false, 'message', 'The QR of this truck is already cancelled.'); end if;
    if exists (select 1 from bm.composite_batches c where c.parent_truck_ids ? t.truck_id) then
        return jsonb_build_object('success', false, 'message', 'This truck is already part of a composite mixture, so its QR can no longer be cancelled here. Ask the administrator.'); end if;
    if exists (select 1 from bm.trucks b where b.bottom_of = t.truck_id and b.cancel_status is null) or exists (select 1 from bm.bottom_requests r where r.truck_id = t.truck_id) then
        return jsonb_build_object('success', false, 'message', 'A bottom sample exists for this truck. Ask the administrator to undo it first.'); end if;
    update bm.trucks set cancel_status = 'CANCELLED', cancel_code = v_code, cancel_reason = v_reason, cancelled_by = bm.uname(), cancelled_at = now() where truck_id = t.truck_id;
    delete from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;
    perform bm.log('QR_CANCELLED', format('QR of truck %s (%s) cancelled: %s', t.truck_id, t.truck_reg_number, v_reason));
    return jsonb_build_object('success', true, 'truck_id', t.truck_id, 'cancel_reason', v_reason);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_unloading_day_report(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text := bm.require(array['unloading','admin']);
        v_today date := bm.ist_date();
        v_date date := coalesce(nullif(p->>'date', '')::date, bm.ist_date());
        v_rows jsonb; v_msg text;
begin
    -- v10: the Unloading login must type the unloading-actions password (the same one as for bottom samples and QR cancelling) EVERY time:
    -- the report is no longer shown on screen, it is produced as a password-protected PDF protected with that same password.
    if v_role = 'unloading' then
        v_msg := bm.check_action_password(p->>'password', 'day report');
        if v_msg is not null then return jsonb_build_object('success', false, 'message', v_msg); end if;
    end if;
    if v_date > v_today then raise exception 'Choose today or an earlier date.'; end if;
    if v_role = 'unloading' and v_date = v_today and bm.ist_time() < '21:00' then
        raise exception 'Today''s day report can be generated after 9:00 PM. You can open any earlier day now.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
               'truck_reg_number', x.truck_reg_number, 'company_name', x.company_name, 'entry_time', x.entry_time,
               'po_number', x.po_number, 'lot', x.lot,
               'gross_weight', x.gross_weight, 'tare_weight', x.tare_weight, 'net_weight', x.net_weight,
               'moisture_pct', x.moisture_pct, 'fineness_value', x.fineness_value,
               'acceptance_status', x.st, 'cancel_reason', x.cancel_reason,
               'gcv', (x.c).gcv_value, 'ash', (x.c).ash_pct, 'tm', round((x.c).tm_value, 2), 'sulphur', (x.c).arb_sulphur, 'vm', (x.c).arb_vm,
               'gcv_source', case when x.has_bottom then 'BOTTOM SAMPLE' when (x.c).composite_ref_id is not null then 'COMPOSITE' end)
             order by x.entry_time, x.truck_id), '[]'::jsonb)
      into v_rows
      from (select t.*, l.moisture_pct, l.fineness_value, bm.truck_status(t, l.moisture_pct) as st,
                   exists (select 1 from bm.trucks b where b.bottom_of = t.truck_id) as has_bottom,
                   bm.truck_composite(t, bm.truck_status(t, l.moisture_pct)) as c
              from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
             where t.entry_date = v_date and t.bottom_of is null and t.cancel_status is distinct from 'VOIDED') x;
    perform bm.log('DAY_REPORT', format('Day report opened for %s', v_date));
    return jsonb_build_object('success', true, 'date', v_date, 'generated_at', to_char(bm.ist_ts(), 'YYYY-MM-DD HH24:MI'), 'rows', v_rows);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_unloading_request_bottom(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_user text; v_tid text := btrim(coalesce(p->>'truck_id', '')); v_pw text := coalesce(p->>'password', '');
    v_reason text := nullif(btrim(coalesce(p->>'reason', '')), '');
    v_salt text; v_hash text; v_fails int; t bm.trucks; l bm.lab1_results;
begin
    perform bm.require(array['unloading', 'admin']);
    v_user := bm.uname();
    select count(*) into v_fails from bm.bottom_pw_fails where username = v_user and at > now() - interval '10 minutes';
    if v_fails >= 5 then
        return jsonb_build_object('success', false, 'message', 'Too many wrong passwords. Wait 10 minutes or ask the administrator.'); end if;
    select value into v_salt from bm.settings where key = 'bottom_pw_salt';
    select value into v_hash from bm.settings where key = 'bottom_pw_hash';
    if v_hash is null then
        return jsonb_build_object('success', false, 'message', 'The bottom-sampling password has not been set yet. Ask the administrator.'); end if;
    if bm.bottom_pw_hash(v_salt, v_pw) <> v_hash then
        insert into bm.bottom_pw_fails(username) values (v_user);
        perform bm.log('BOTTOM_PASSWORD_WRONG', format('Wrong bottom-sampling password entered for truck %s', left(v_tid, 40)));
        return jsonb_build_object('success', false, 'message', 'Wrong password. The request was not sent.');
    end if;
    if v_reason is not null and (length(v_reason) > 300 or not bm.is_safe_text(v_reason)) then
        raise exception 'The reason is too long or contains characters that are not allowed'; end if;

    select * into t from bm.trucks where truck_id = v_tid and bottom_of is null and cancel_status is distinct from 'VOIDED' for update;
    if not found then return jsonb_build_object('success', false, 'message', 'Truck not found.'); end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    if bm.truck_status(t, l.moisture_pct) in ('REJECTED', 'CANCELLED') then
        return jsonb_build_object('success', false, 'message', 'This consignment is rejected or cancelled, so no bottom sample is needed.'); end if;
    if exists (select 1 from bm.bottom_requests where truck_id = t.truck_id) then
        return jsonb_build_object('success', false, 'message', 'A bottom sample was already requested for this truck.'); end if;
    if exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code) then
        return jsonb_build_object('success', false, 'message', 'The composite of this truck''s mixing group is already made, so the truck can no longer be taken out of it. Contact the administrator.'); end if;

    insert into bm.bottom_requests(truck_id, requested_by, requested_date, requested_time, reason)
    values (t.truck_id, v_user, bm.ist_date(), bm.ist_time(), v_reason);
    perform bm.log('BOTTOM_REQUESTED', format('Bottom sampling requested for truck %s (%s)', t.truck_id, t.truck_reg_number));
    return jsonb_build_object('success', true, 'truck_id', t.truck_id, 'message', 'Bottom sampling request sent to the Entry desk.');
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_update_weighment(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['admin','weighment','unloading']);
    g  numeric := coalesce(nullif(p->>'gross', '')::numeric, 0);
    tr numeric := coalesce(nullif(p->>'tare',  '')::numeric, 0);
    v_reason text := coalesce(nullif(btrim(coalesce(p->>'reason', '')), ''), 'Administrative weight calibration override');
    t bm.trucks; m numeric; net numeric; v_rej boolean;
begin
    if g < 0 or tr < 0 or g > 200000 or tr > 200000 then raise exception 'Weight is out of the allowed range'; end if;
    select * into t from bm.trucks where truck_id = p->>'truck_id' for update;
    if not found then return jsonb_build_object('success', false, 'message', 'Truck ID not found'); end if;
    select moisture_pct into m from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    -- a REJECTED / cancelled consignment is not unloaded: it leaves with the load it came with, so its final weight IS its gross weight (net 0). Nothing is typed for it.
    v_rej := bm.truck_status(t, m) in ('REJECTED', 'CANCELLED');

    if v_role = 'weighment' then
        if t.gross_weight > 0 and g > 0 and g <> t.gross_weight then
            raise exception 'Security Lock: Gross weight for truck [%] is already submitted and locked.', t.truck_id; end if;
        if not v_rej and t.tare_weight > 0 and tr > 0 and tr <> t.tare_weight then
            raise exception 'Security Lock: Final weight for truck [%] is already submitted and locked.', t.truck_id; end if;
        if t.gross_weight > 0 then g := t.gross_weight; end if;
        if not v_rej and t.tare_weight > 0 then tr := t.tare_weight; end if;
    elsif v_role = 'unloading' then
        if not v_rej and tr <> t.tare_weight then
            raise exception 'Unauthorized: Final (Tare) weight must be recorded at the weighbridge / weighment login.'; end if;
        g := t.gross_weight;
    end if;

    if v_rej then
        tr := g;                                    -- final weight = gross weight (0 while the gross is not yet recorded)
    else
        if v_role <> 'admin' and tr > 0 and t.tare_weight = 0 then
            if g = 0 then raise exception 'Record the inbound gross weight before the final tare weight.'; end if;
            if m is null then raise exception 'Final weight cannot be recorded until the Lab-1 moisture result is available.'; end if;
        end if;
        if g > 0 and tr > 0 and tr >= g then
            raise exception 'Tare weight (% kg) cannot be greater than or equal to Gross weight (% kg). Please verify scale readings.', tr, g;
        end if;
    end if;

    net := case when v_rej then 0 when g > 0 and tr > 0 and g > tr then g - tr else 0 end;
    update bm.trucks set gross_weight = g, tare_weight = tr, net_weight = net, tare_auto = (v_rej and g > 0) where truck_id = t.truck_id;

    if v_role = 'admin' and (t.gross_weight <> g or t.tare_weight <> tr) then
        perform bm.log('WEIGHT_OVERRIDE', format('Truck %s (%s): Gross %s kg -> %s kg, Tare %s kg -> %s kg, Net %s kg%s. Reason: %s',
                 t.truck_id, t.truck_reg_number, t.gross_weight, g, t.tare_weight, tr, net, case when v_rej then ' (rejected truck: final weight = gross weight)' else '' end, v_reason));
    end if;
    return jsonb_build_object('success', true, 'gross_weight', g, 'tare_weight', tr, 'net_weight', net, 'rejected', v_rej);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_whoami(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare pr bm.profiles;
begin
    select * into pr from bm.profiles where id = auth.uid() and active;
    if not found then
        raise exception 'This account has not been provisioned. Ask the administrator.' using errcode = '42501';
    end if;
    return jsonb_build_object('username', pr.username, 'role', pr.role, 'name', pr.name, 'moisture_limit', 14);
end $function$
;

-- LEGACY (old v1 schema): trigger function that checks the old public.companies table. Not used by the bm_* system.
CREATE OR REPLACE FUNCTION public.check_company_name_exists()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM companies WHERE name = NEW.company_name
    ) THEN
        RAISE EXCEPTION 'Company name "%" is not in the approved vendor list. Please select from the dropdown.', NEW.company_name;
    END IF;
    RETURN NEW;
END;
$function$
;

set check_function_bodies = on;
