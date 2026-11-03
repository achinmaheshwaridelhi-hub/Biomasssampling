-- public.bm_* functions, batch 1 of 5 (bm_admin_ack_logs ... bm_admin_storage_status), exactly as dumped.
-- Run AFTER 01-05. Execute privileges are NOT included here (see grants file, pending Block I).
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bm_admin_ack_logs(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ids bigint[]; n int;
begin
    perform bm.require(array['admin']);
    if bm.real_role() <> 'admin' then raise exception 'Only the Admin can acknowledge log lines' using errcode = '42501'; end if;
    if jsonb_typeof(p->'ids') is distinct from 'array' then raise exception 'No log lines were given'; end if;
    if jsonb_array_length(p->'ids') > 2000 then raise exception 'Too many lines at once (maximum 2000)'; end if;
    select coalesce(array_agg(value::bigint), '{}') into v_ids from jsonb_array_elements_text(p->'ids');
    insert into bm.log_acks(log_id, acked_by) select a.id, bm.uname() from bm.activity_logs a where a.id = any(v_ids) on conflict do nothing;
    get diagnostics n = row_count;
    perform bm.log('ADMIN_ACK_LOGS', format('The Admin acknowledged %s log line(s)', n));
    return jsonb_build_object('success', true, 'acknowledged', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_backup_extra(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    if bm.real_role() = 'superadmin' then raise exception 'Not available for this login' using errcode = '42501'; end if;
    return jsonb_build_object(
        'mixing_scans',     coalesce((select jsonb_agg(to_jsonb(m) order by m.entry_date, m.sample1_barcode_id) from bm.mixing_scans m), '[]'::jsonb),
        'mixing_groups',    coalesce((select jsonb_agg(to_jsonb(g) order by g.entry_date, g.group_code) from bm.mixing_groups g), '[]'::jsonb),
        'counters',         coalesce((select jsonb_agg(to_jsonb(c)) from bm.counters c), '[]'::jsonb),
        'qr_history',       coalesce((select jsonb_agg(to_jsonb(h) order by h.id) from bm.qr_history h), '[]'::jsonb),
        'voided_composites',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from bm.voided_composites v), '[]'::jsonb),
        'settings',         coalesce((select jsonb_agg(to_jsonb(x)) from bm.settings x), '[]'::jsonb),
        'known_ips',        coalesce((select jsonb_agg(to_jsonb(k) order by k.first_seen) from bm.known_ips k), '[]'::jsonb),
        'profiles',         coalesce((select jsonb_agg(jsonb_build_object('username', r.username, 'role', r.role, 'name', r.name, 'active', r.active) order by r.username) from bm.profiles r), '[]'::jsonb),
        'companies',        coalesce((select jsonb_agg(to_jsonb(c) order by c.vid) from bm.companies c), '[]'::jsonb),
        -- photo links only (the pictures themselves stay in Supabase Storage): 'ev/...' paths
        'truck_photos',     coalesce((select jsonb_agg(jsonb_build_object('truck_id', t.truck_id, 'photo', t.photo_url)) from bm.trucks t where t.photo_url like 'ev/%'), '[]'::jsonb),
        'lab1_photos',      coalesce((select jsonb_agg(jsonb_build_object('sample1_barcode_id', l.sample1_barcode_id, 'moisture_photo', case when l.moisture_photo like 'ev/%' then l.moisture_photo end,
                                       'fineness_initial_photo', case when l.fineness_initial_photo like 'ev/%' then l.fineness_initial_photo end,
                                       'fineness_final_photo', case when l.fineness_final_photo like 'ev/%' then l.fineness_final_photo end))
                                      from bm.lab1_results l where l.moisture_photo like 'ev/%' or l.fineness_initial_photo like 'ev/%' or l.fineness_final_photo like 'ev/%'), '[]'::jsonb),
        'counts', jsonb_build_object('mixing_scans', (select count(*) from bm.mixing_scans), 'mixing_groups', (select count(*) from bm.mixing_groups), 'qr_history', (select count(*) from bm.qr_history),
                                     'voided_composites', (select count(*) from bm.voided_composites), 'known_ips', (select count(*) from bm.known_ips), 'activity_logs', (select count(*) from bm.activity_logs),
                                     'companies', (select count(*) from bm.companies), 'settings', (select count(*) from bm.settings)));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_bottom_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return jsonb_build_object('password_set', exists (select 1 from bm.settings where key = 'bottom_pw_hash'),
        'pending_requests', (select count(*) from bm.bottom_requests where status = 'REQUESTED'),
        'generated', (select count(*) from bm.bottom_requests where status = 'GENERATED'));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_composites(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from bm.composite_batches c), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_dashboard(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date;
    v_company text := nullif(p->>'company', '');
begin
    perform bm.require(array['admin']);
    return jsonb_build_object(
        'trucks', coalesce((select jsonb_agg(bm.truck_view(t) order by t.created_at desc) from bm.trucks t
                             where t.bottom_of is null and t.cancel_status is distinct from 'VOIDED'
                               and (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to)
                               and (v_company is null or t.company_name = v_company)), '[]'::jsonb),
        'bottom_requests', coalesce((select jsonb_agg(to_jsonb(r) order by r.requested_at) from bm.bottom_requests r), '[]'::jsonb),
        'voided_trucks', coalesce((select jsonb_agg((to_jsonb(t) - 'photo_url') order by t.created_at desc) from bm.trucks t
                             where t.cancel_status = 'VOIDED' and t.bottom_of is null
                               and (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to)
                               and (v_company is null or t.company_name = v_company)), '[]'::jsonb),
        'bottom_trucks', coalesce((select jsonb_agg((to_jsonb(t) - 'photo_url') order by t.created_at desc) from bm.trucks t
                             where t.bottom_of is not null
                               and (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to)
                               and (v_company is null or t.company_name = v_company)), '[]'::jsonb),
        'lab1', coalesce((select jsonb_agg(bm.lab1_admin_json(l)) from bm.lab1_results l
                           where exists (select 1 from bm.trucks t where t.sample1_barcode_id = l.sample1_barcode_id and t.bottom_of is null     -- (also those of voided trucks: the backup must keep them)
                                           and (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to)
                                           and (v_company is null or t.company_name = v_company))), '[]'::jsonb),
        'composites', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from bm.composite_batches c
                                 where (v_from is null or c.date >= v_from) and (v_to is null or c.date <= v_to)
                                   and (v_company is null or c.company_name = v_company)), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_exceptions(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date;
    v_status text := lower(coalesce(nullif(btrim(p->>'status'), ''), 'open')); v_q text := btrim(coalesce(p->>'q', ''));
    v_wm bigint := coalesce((select value::bigint from bm.settings where key = 'super_ack_id'), 0);
    v_super boolean; v_rows jsonb; v_open_all int; v_open_range int; v_n int; v_limit int := 1000;
begin
    perform bm.require(array['admin']);
    v_super := bm.real_role() = 'superadmin';
    if v_status not in ('open', 'acked', 'all') then raise exception 'Unknown status'; end if;
    if v_from is null and v_to is null then v_from := bm.ist_date(); v_to := v_from; end if;
    v_from := coalesce(v_from, v_to); v_to := coalesce(v_to, v_from);
    if v_from > v_to then raise exception 'The start date is after the end date'; end if;
    select count(*) into v_open_all from bm.activity_logs a
     where bm.is_exception_log(a.action, a.details) and (not v_super or a.action like 'SUPERADMIN\_%') and a.id > v_wm and not exists (select 1 from bm.log_acks k where k.log_id = a.id);
    select count(*) into v_open_range from bm.activity_logs a
     where bm.is_exception_log(a.action, a.details) and (not v_super or a.action like 'SUPERADMIN\_%') and a.id > v_wm and not exists (select 1 from bm.log_acks k where k.log_id = a.id)
       and left(a.timestamp, 10) between to_char(v_from, 'YYYY-MM-DD') and to_char(v_to, 'YYYY-MM-DD');
    select coalesce(jsonb_agg(x.j order by x.id desc), '[]'::jsonb), count(*) into v_rows, v_n from (
        select a.id, jsonb_build_object('id', a.id, 'timestamp', a.timestamp, 'username', a.username, 'action', a.action, 'details', a.details, 'ip', a.ip, 'device', a.device, 'device_name', coalesce((select dd.name from bm.trusted_devices dd where dd.id = a.device_id), a.device_name),
                   'ip_label', bm.ip_label(a.ip), 'acknowledged', (a.id <= v_wm or exists (select 1 from bm.log_acks k where k.log_id = a.id))) as j
          from bm.activity_logs a
         where bm.is_exception_log(a.action, a.details) and (not v_super or a.action like 'SUPERADMIN\_%')
           and left(a.timestamp, 10) between to_char(v_from, 'YYYY-MM-DD') and to_char(v_to, 'YYYY-MM-DD')
           and (v_status = 'all' or (v_status = 'acked') = (a.id <= v_wm or exists (select 1 from bm.log_acks k where k.log_id = a.id)))
           and (v_q = '' or a.username ilike '%' || v_q || '%' or a.action ilike '%' || v_q || '%' or a.details ilike '%' || v_q || '%' or coalesce(a.ip, '') ilike '%' || v_q || '%' or coalesce(a.device_name, '') ilike '%' || v_q || '%' or exists (select 1 from bm.trusted_devices dd where dd.id = a.device_id and dd.name ilike '%' || v_q || '%'))
         order by a.id desc limit v_limit) x;
    return jsonb_build_object('success', true, 'from', v_from, 'to', v_to, 'status', v_status, 'rows', v_rows, 'truncated', v_n >= v_limit,
                              'open_total', v_open_all, 'open_in_range', v_open_range, 'can_acknowledge', not v_super);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_health(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return jsonb_build_object('success', true, 'truck_count', (select count(*) from bm.trucks where bottom_of is null and cancel_status is distinct from 'VOIDED'),
        'bottom_count', (select count(*) from bm.trucks where bottom_of is not null),
        'voided_count', (select count(*) from bm.trucks where cancel_status = 'VOIDED' and bottom_of is null),
        'lab1_count', (select count(*) from bm.lab1_results l where not exists (select 1 from bm.trucks t where t.sample1_barcode_id = l.sample1_barcode_id and t.bottom_of is not null)), 'composite_count', (select count(*) from bm.composite_batches),
        'user_count', (select count(*) from bm.profiles where active), 'status', 'OPERATIONAL');
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_inspect(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_code text := btrim(coalesce(p->>'code', ''));
    v_core text; t bm.trucks; l bm.lab1_results; b bm.composite_batches; n int;
begin
    perform bm.require(array['admin']);
    select * into t from bm.trucks where sample1_barcode_id = v_code;
    if not found then select * into t from bm.trucks where truck_id = v_code; end if;
    if not found then select * into t from bm.trucks where bm.norm_reg(truck_reg_number) = bm.norm_reg(v_code)
                                                            order by created_at desc limit 1; end if;
    if found then
        select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
        select * into b from bm.composite_batches where composite_barcode_id = t.composite_barcode_id;
        return jsonb_build_object('success', true, 'type', 'sample1', 'barcode_id', v_code,
            'truck', bm.truck_view(t),
            'lab1', case when l.sample1_barcode_id is null then null else bm.lab1_admin_json(l) end,
            'composite', case when b.composite_ref_id is null then null else to_jsonb(b) end);
    end if;

    v_core := regexp_replace(upper(regexp_replace(regexp_replace(v_code, 'MIXING GROUP:', '', 'gi'), 'GROUP:', '', 'gi')), '^\s+|\s+$', '', 'g');
    select * into b from bm.composite_batches
     where upper(composite_ref_id) = v_core or upper(composite_barcode_id) = v_core or upper(test_lot) = v_core
        or upper(referee_lot) = v_core or upper(vendor_lot) = v_core
        or upper(composite_ref_id) = regexp_replace(v_core, '[-_][RVT]$', '')
     limit 1;
    n := 0;
    if not found then
        -- a bare mixing-group code is only unique per date: choose the latest and report how many matched
        select count(*) into n from bm.composite_batches where upper(daily_group_code) = v_core;
        select * into b from bm.composite_batches where upper(daily_group_code) = v_core order by date desc limit 1;
    end if;
    if found then
        return jsonb_build_object('success', true, 'type', 'composite', 'barcode_id', v_code,
            'batch', to_jsonb(b) || jsonb_build_object('lots', jsonb_build_object('test', b.test_lot, 'referee', b.referee_lot, 'vendor', b.vendor_lot)),
            'ambiguous_group_matches', case when n > 1 then n else 0 end,
            'matching_trucks', coalesce((select jsonb_agg(bm.truck_view(x)) from bm.trucks x
                                          where x.truck_id in (select jsonb_array_elements_text(b.parent_truck_ids))), '[]'::jsonb),
            'lab1_results', coalesce((select jsonb_agg(bm.lab1_admin_json(y)) from bm.lab1_results y
                                       where y.sample1_barcode_id in (select x.sample1_barcode_id from bm.trucks x
                                              where x.truck_id in (select jsonb_array_elements_text(b.parent_truck_ids)))), '[]'::jsonb));
    end if;
    return jsonb_build_object('success', false, 'message', format('No record found in database for barcode ID: "%s"', left(v_code, 60)));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_logs(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return coalesce((select jsonb_agg(jsonb_build_object('timestamp', x.timestamp, 'username', x.username, 'action', x.action, 'details', x.details, 'ip', x.ip, 'device', x.device, 'device_name', coalesce((select dd.name from bm.trusted_devices dd where dd.id = x.device_id), x.device_name),
                                                          'ip_label', bm.ip_label(x.ip)) order by x.id desc)
                       from (select * from bm.activity_logs where bm.real_role() <> 'superadmin' or action like 'SUPERADMIN\_%' order by id desc limit 3000) x), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_logs_page(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_after bigint := coalesce(nullif(p->>'after_id', '')::bigint, 0); v_n int := least(coalesce(nullif(p->>'limit', '')::int, 5000), 10000);
begin
    perform bm.require(array['admin']);
    if bm.real_role() = 'superadmin' then raise exception 'Not available for this login' using errcode = '42501'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'timestamp', x.timestamp, 'username', x.username, 'action', x.action, 'details', x.details, 'ip', x.ip, 'device', x.device, 'device_name', coalesce((select dd.name from bm.trusted_devices dd where dd.id = x.device_id), x.device_name)) order by x.id)
                       from (select * from bm.activity_logs where id > v_after order by id limit v_n) x), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_mark_photo_purged(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_kind text := p->>'kind'; v_id text := p->>'id'; v_path text := coalesce(p->>'path', ''); n int := 0;
        v_mark text := 'purged:' || to_char(bm.ist_date(), 'YYYY-MM-DD');
begin
    perform bm.require(array['admin']);
    if v_path !~ '^ev/[A-Za-z0-9_./-]{8,200}$' then raise exception 'Not a Storage photo path'; end if;
    if exists (select 1 from storage.objects o where o.bucket_id = 'evidence' and o.name = substr(v_path, 4)) then
        raise exception 'That photo file still exists in Storage - delete it first'; end if;
    if v_kind = 'truck' then
        update bm.trucks set photo_url = v_mark where truck_id = v_id and photo_url = v_path; get diagnostics n = row_count;
    elsif v_kind = 'moisture' then
        update bm.lab1_results set moisture_photo = v_mark where sample1_barcode_id = v_id and moisture_photo = v_path; get diagnostics n = row_count;
    elsif v_kind = 'fineness_initial' then
        update bm.lab1_results set fineness_initial_photo = v_mark where sample1_barcode_id = v_id and fineness_initial_photo = v_path; get diagnostics n = row_count;
    elsif v_kind = 'fineness_final' then
        update bm.lab1_results set fineness_final_photo = v_mark where sample1_barcode_id = v_id and fineness_final_photo = v_path; get diagnostics n = row_count;
    else raise exception 'Unknown photo type'; end if;
    return jsonb_build_object('success', true, 'updated', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_mixing_range(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date;
    v_q text := btrim(coalesce(p->>'q', '')); v_nq text := bm.norm_reg(coalesce(p->>'q', ''));
    v_lot text := bm.norm_lot(nullif(btrim(coalesce(p->>'lot', '')), ''));
    v_groups jsonb; v_cut boolean := false; v_limit int := 400;
begin
    perform bm.require(array['admin']);
    if v_from is null and v_to is null and v_q = '' then raise exception 'Choose a date range or type a mixing code / vendor / truck number'; end if;
    if v_from is not null or v_to is not null then
        v_to := coalesce(v_to, bm.ist_date()); v_from := coalesce(v_from, v_to);
        if v_from > v_to then raise exception 'The start date is after the end date'; end if;
        if v_to - v_from > 92 then raise exception 'Choose at most 3 months at a time'; end if;
    end if;
    with m as (
        select distinct t.entry_date as d, upper(t.daily_group_code) as code
          from bm.trucks t
         where (v_from is null or t.entry_date between v_from and v_to)
           and (v_q = '' or upper(t.daily_group_code) = upper(v_q) or t.company_name ilike '%' || v_q || '%' or coalesce(t.po_number, '') = v_q
                or (length(v_nq) >= 3 and bm.norm_reg(t.truck_reg_number) like '%' || v_nq || '%'))
           and (v_lot is null or t.lot = v_lot or (t.lot = 'LOT2/3' and v_lot in ('LOT2', 'LOT3')))
         order by 1 desc, 2 limit v_limit + 1),
    ms as (select d, code, row_number() over (order by d desc, code) as rn from m),
    x as (
        select t.entry_date as d, upper(t.daily_group_code) as code, t.entry_time, t.truck_id, (t.bottom_of is not null) as is_b,
               t.company_name, t.lot, t.po_number, bm.truck_status(t, l.moisture_pct) as st,
               case when c.composite_ref_id is null then null else jsonb_build_object(
                    'composite_ref_id', c.composite_ref_id, 'composite_barcode_id', c.composite_barcode_id, 'test_lot', c.test_lot, 'referee_lot', c.referee_lot, 'vendor_lot', c.vendor_lot,
                    'tested', c.gcv_value is not null, 'tested_at', c.tested_at, 'truck_count', jsonb_array_length(c.parent_truck_ids)) end as cj,
               jsonb_build_object(
                   'entry_date', t.entry_date, 'entry_time', t.entry_time, 'group_code', t.daily_group_code,
                   'truck_id', coalesce(t.bottom_of, t.truck_id), 'is_bottom_sample', t.bottom_of is not null,
                   'company_name', t.company_name, 'lot', t.lot, 'po_number', t.po_number,
                   'truck_reg_number', t.truck_reg_number, 'driver_name', t.driver_name, 'invoice_no', coalesce(t.invoice_no, ''),
                   'sample1_barcode_id', t.sample1_barcode_id,
                   'gross_weight', t.gross_weight, 'tare_weight', t.tare_weight, 'net_weight', t.net_weight,
                   'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value,
                   'acceptance_status', bm.truck_status(t, l.moisture_pct), 'mix_status', bm.mix_status(t, l.moisture_pct),
                   'excluded_from_mix', t.excluded_from_mix,
                   'cancel_status', t.cancel_status, 'cancel_reason', t.cancel_reason, 'acceptance_override', t.acceptance_override,
                   'linked_group_code', coalesce((select b.daily_group_code from bm.trucks b where b.bottom_of = t.truck_id limit 1),
                                                 (select o.daily_group_code from bm.trucks o where o.truck_id = t.bottom_of)),
                   'mixing_scanned', exists (select 1 from bm.mixing_scans ms2 where ms2.sample1_barcode_id = t.sample1_barcode_id),
                   'composite_ref_id', case when t.excluded_from_mix then null else c.composite_ref_id end,
                   'gcv', case when t.excluded_from_mix then null else c.gcv_value end, 'ash', case when t.excluded_from_mix then null else c.ash_pct end,
                   'tm', case when t.excluded_from_mix then null else round(c.tm_value, 2) end,
                   'sulphur', case when t.excluded_from_mix then null else c.arb_sulphur end, 'vm', case when t.excluded_from_mix then null else c.arb_vm end) as j,
               c.gcv_value as c_gcv, c.ash_pct as c_ash, round(c.tm_value, 2) as c_tm, c.arb_sulphur as c_s, c.arb_vm as c_vm
          from ms join bm.trucks t on t.entry_date = ms.d and upper(t.daily_group_code) = ms.code
          left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
          left join bm.composite_batches c on c.date = t.entry_date and c.daily_group_code = t.daily_group_code
         where ms.rn <= v_limit)
    select coalesce(jsonb_agg(y.gj order by y.d desc, y.code), '[]'::jsonb), (select count(*) from m) > v_limit into v_groups, v_cut
      from (select x.d, x.code, jsonb_build_object(
                   'date', x.d, 'group_code', x.code,
                   'company_name', min(x.company_name), 'lot', min(x.lot), 'po_number', min(coalesce(x.po_number, '')),
                   'trucks', count(*) filter (where not x.is_b), 'bottom_samples', count(*) filter (where x.is_b),
                   'accepted', count(*) filter (where not x.is_b and x.st = 'ACCEPTED'), 'rejected', count(*) filter (where not x.is_b and x.st in ('REJECTED', 'CANCELLED')),
                   'pending', count(*) filter (where not x.is_b and x.st not in ('ACCEPTED', 'REJECTED', 'CANCELLED')),
                   'net_weight', coalesce(sum(case when not x.is_b and x.st = 'ACCEPTED' then (x.j->>'net_weight')::numeric end), 0),
                   'composite', (array_agg(x.cj) filter (where x.cj is not null))[1],
                   'gcv', max(x.c_gcv), 'ash', max(x.c_ash), 'tm', max(x.c_tm), 'sulphur', max(x.c_s), 'vm', max(x.c_vm),
                   'rows', jsonb_agg(x.j order by x.is_b, x.entry_time, x.truck_id)) as gj
              from x group by x.d, x.code) y;
    return jsonb_build_object('success', true, 'groups', v_groups, 'truncated', v_cut);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_mixing_search(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_code text := upper(btrim(coalesce(p->>'code', ''))); v_rows jsonb;
begin
    perform bm.require(array['admin']);
    if v_code = '' then raise exception 'Type a mixing code'; end if;
    select coalesce(jsonb_agg(x.j order by x.d desc, x.is_bottom, x.tid), '[]'::jsonb) into v_rows
      from (select t.entry_date as d, (t.bottom_of is not null) as is_bottom, t.truck_id as tid,
                   jsonb_build_object(
                       'entry_date', t.entry_date, 'entry_time', t.entry_time, 'group_code', t.daily_group_code,
                       'truck_id', coalesce(t.bottom_of, t.truck_id), 'is_bottom_sample', t.bottom_of is not null,
                       'company_name', t.company_name, 'lot', t.lot, 'po_number', t.po_number,
                       'truck_reg_number', t.truck_reg_number, 'driver_name', t.driver_name, 'invoice_no', coalesce(t.invoice_no, ''),
                       'sample1_barcode_id', t.sample1_barcode_id,
                       'gross_weight', t.gross_weight, 'tare_weight', t.tare_weight, 'net_weight', t.net_weight,
                       'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value,
                       'acceptance_status', bm.truck_status(t, l.moisture_pct), 'mix_status', bm.mix_status(t, l.moisture_pct),
                       'excluded_from_mix', t.excluded_from_mix,
                       'cancel_status', t.cancel_status, 'cancel_reason', t.cancel_reason, 'acceptance_override', t.acceptance_override,
                       'linked_group_code', coalesce((select b.daily_group_code from bm.trucks b where b.bottom_of = t.truck_id limit 1),
                                                     (select o.daily_group_code from bm.trucks o where o.truck_id = t.bottom_of)),
                       'mixing_scanned', exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = t.sample1_barcode_id),
                       'composite_ref_id', case when t.excluded_from_mix then null else c.composite_ref_id end,
                       'gcv', case when t.excluded_from_mix then null else c.gcv_value end, 'ash', case when t.excluded_from_mix then null else c.ash_pct end,
                       'tm', case when t.excluded_from_mix then null else round(c.tm_value, 2) end,
                       'sulphur', case when t.excluded_from_mix then null else c.arb_sulphur end, 'vm', case when t.excluded_from_mix then null else c.arb_vm end) as j
              from bm.trucks t
              left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
              left join bm.composite_batches c on c.date = t.entry_date and c.daily_group_code = t.daily_group_code
             where upper(t.daily_group_code) = v_code) x;
    return jsonb_build_object('success', true, 'code', v_code, 'rows', v_rows);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_photo(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_kind text := p->>'kind'; v_id text := p->>'id'; v text;
begin
    perform bm.require(array['admin']);
    if v_kind = 'truck' then select photo_url into v from bm.trucks where truck_id = v_id;
    elsif v_kind = 'moisture' then select moisture_photo into v from bm.lab1_results where sample1_barcode_id = v_id;
    elsif v_kind = 'fineness_initial' then select fineness_initial_photo into v from bm.lab1_results where sample1_barcode_id = v_id;
    elsif v_kind = 'fineness_final' then select fineness_final_photo into v from bm.lab1_results where sample1_barcode_id = v_id;
    else raise exception 'Unknown photo type'; end if;
    return jsonb_build_object('photo', v);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_photo_inventory(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return coalesce((select jsonb_agg(to_jsonb(x) order by x.kind, x.id) from (
        select 'truck'::text as kind, truck_id as id, length(photo_url) as chars from bm.trucks where photo_url like 'data:image/%'
        union all select 'moisture', sample1_barcode_id, length(moisture_photo) from bm.lab1_results where moisture_photo like 'data:image/%'
        union all select 'fineness_initial', sample1_barcode_id, length(fineness_initial_photo) from bm.lab1_results where fineness_initial_photo like 'data:image/%'
        union all select 'fineness_final', sample1_barcode_id, length(fineness_final_photo) from bm.lab1_results where fineness_final_photo like 'data:image/%'
    ) x), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_photo_purge_candidates(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_keep int := greatest(coalesce(nullif(p->>'keep_days', '')::int, 60), 0);
        v_lim  int := least(coalesce(nullif(p->>'limit', '')::int, 5000), 50000);
begin
    perform bm.require(array['admin']);
    return coalesce((select jsonb_agg(to_jsonb(x) order by x.created, x.id) from (
        with refs as (
            select 'truck'::text as kind, t.truck_id as id, t.photo_url as path, t.truck_id as truck_id from bm.trucks t where t.photo_url like 'ev/%'
            union all select 'moisture', l.sample1_barcode_id, l.moisture_photo, t.truck_id from bm.lab1_results l join bm.trucks t on t.sample1_barcode_id = l.sample1_barcode_id where l.moisture_photo like 'ev/%'
            union all select 'fineness_initial', l.sample1_barcode_id, l.fineness_initial_photo, t.truck_id from bm.lab1_results l join bm.trucks t on t.sample1_barcode_id = l.sample1_barcode_id where l.fineness_initial_photo like 'ev/%'
            union all select 'fineness_final', l.sample1_barcode_id, l.fineness_final_photo, t.truck_id from bm.lab1_results l join bm.trucks t on t.sample1_barcode_id = l.sample1_barcode_id where l.fineness_final_photo like 'ev/%'
        ), held as (
            select jsonb_array_elements_text(c.parent_truck_ids) as truck_id from bm.composite_batches c where c.referee_status = 'CHALLENGED'
        )
        select r.kind, r.id, r.path, coalesce(nullif(o.metadata->>'size', '')::bigint, 0) as bytes, o.created_at as created
          from refs r join storage.objects o on o.bucket_id = 'evidence' and o.name = substr(r.path, 4)
         where o.created_at < now() - make_interval(days => v_keep)
           and r.truck_id not in (select h.truck_id from held h)
           and r.path not in (select tr.photo from bm.reader_training tr where tr.photo like 'ev/%' and tr.status <> 'REJECTED')
         order by o.created_at, r.id
         limit v_lim
    ) x), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_reset_group_scans(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_date date := nullif(p->>'date', '')::date; v_group text := upper(btrim(coalesce(p->>'group_code', ''))); n int;
begin
    perform bm.require(array['admin']);
    if v_date is null or v_group = '' then raise exception 'Date and mixing group code are required'; end if;
    if exists (select 1 from bm.composite_batches c where c.date = v_date and c.daily_group_code = v_group) then
        raise exception 'The composite for group % on % is already generated; its scans cannot be reset.', v_group, v_date; end if;
    delete from bm.mixing_scans where entry_date = v_date and group_code = v_group; get diagnostics n = row_count;
    perform bm.log('MIXING_SCANS_RESET', format('Admin reset %s mixing scan(s) of group %s (%s)', n, v_group, v_date));
    return jsonb_build_object('success', true, 'removed', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_set_bottom_password(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    raise exception 'Only the Super Admin can set or change the unloading actions password (Super Admin login > Passwords).' using errcode = '42501';
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_set_photo_path(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_kind text := p->>'kind'; v_id text := p->>'id'; v_path text := coalesce(p->>'path', ''); n int := 0;
begin
    perform bm.require(array['admin']);
    if not bm.photo_ok(v_path) or v_path like 'data:%' then raise exception 'No such object in Storage: %', v_path; end if;
    if v_kind = 'truck' then
        update bm.trucks set photo_url = v_path where truck_id = v_id and photo_url like 'data:image/%'; get diagnostics n = row_count;
    elsif v_kind = 'moisture' then
        update bm.lab1_results set moisture_photo = v_path where sample1_barcode_id = v_id and moisture_photo like 'data:image/%'; get diagnostics n = row_count;
    elsif v_kind = 'fineness_initial' then
        update bm.lab1_results set fineness_initial_photo = v_path where sample1_barcode_id = v_id and fineness_initial_photo like 'data:image/%'; get diagnostics n = row_count;
    elsif v_kind = 'fineness_final' then
        update bm.lab1_results set fineness_final_photo = v_path where sample1_barcode_id = v_id and fineness_final_photo like 'data:image/%'; get diagnostics n = row_count;
    else raise exception 'Unknown photo type'; end if;
    if n = 0 then raise exception 'Nothing to move: that photo is not inline (already moved, or not found)'; end if;
    perform bm.log('PHOTO_MOVED', format('%s photo of %s moved to Storage', v_kind, v_id));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_storage_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare n bigint; b bigint; o timestamptz; w timestamptz;
begin
    perform bm.require(array['admin']);
    select count(*), coalesce(sum(nullif(metadata->>'size', '')::bigint), 0), min(created_at), max(created_at)
      into n, b, o, w from storage.objects where bucket_id = 'evidence';
    return jsonb_build_object('files', n, 'bytes', b, 'oldest', o, 'newest', w);
end $function$
;

set check_function_bodies = on;
