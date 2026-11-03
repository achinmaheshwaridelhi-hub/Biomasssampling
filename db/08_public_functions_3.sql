-- public.bm_* functions, batch 3 of 5 (bm_entry_bottom_reprint ... bm_register_truck), exactly as dumped.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bm_entry_bottom_reprint(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text := bm.require(array['entry', 'admin']); r bm.bottom_requests; b bm.trucks;
begin
    select * into r from bm.bottom_requests where truck_id = btrim(coalesce(p->>'truck_id', ''));
    if not found or r.status <> 'GENERATED' then raise exception 'No generated bottom sample for this truck'; end if;
    if v_role = 'entry' and (r.generated_at at time zone 'UTC' + interval '5 hours 30 minutes')::date <> bm.ist_date() then
        raise exception 'Labels can be reprinted on the day they were generated. Ask the administrator.'; end if;
    select * into b from bm.trucks where truck_id = r.bottom_truck_id;
    return jsonb_build_object('success', true, 'sample1_barcode_id', b.sample1_barcode_id, 'entry_date', b.entry_date,
                              'truck_reg_number', b.truck_reg_number, 'company_name', b.company_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_composite_details(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['lab2','admin']);
    v_code text := btrim(coalesce(p->>'code', ''));
    b bm.composite_batches; v_lot text;
begin
    select * into b from bm.composite_batches
     where composite_barcode_id = v_code or test_lot = v_code or referee_lot = v_code or vendor_lot = v_code;
    if not found then return jsonb_build_object('success', false, 'message', 'Invalid composite barcode.'); end if;
    v_lot := case when v_code = b.referee_lot then 'Referee' when v_code = b.vendor_lot then 'Vendor' else 'Test Lot' end;
    if v_role = 'lab2' and v_lot <> 'Test Lot' then
        return jsonb_build_object('success', false, 'message', 'Lab Station 2 can only process the Lab Testing Lot (-T) barcode.');
    end if;
    return jsonb_build_object('success', true, 'composite_barcode_id', b.composite_barcode_id, 'lot_type', v_lot,
        'is_tested', b.gcv_value is not null, 'gcv_value', b.gcv_value, 'ash_pct', b.ash_pct, 'tested_at', b.tested_at,
        'is_lot4', bm.is_lot4(b.lot), 'tm', round(bm.composite_tm(b), 6))
        || case when v_role = 'admin' then jsonb_build_object('meta', jsonb_build_object(
                'company_name', b.company_name, 'date', b.date, 'truck_count', jsonb_array_length(b.parent_truck_ids)))
           else '{}'::jsonb end;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_lab1_history(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text := bm.require(array['lab1','lab1m','lab1f','admin']); u text := bm.uname();
begin
    -- newest submission first; the time shown is when THIS login submitted its part (moisture / fineness), not when the other part was added later
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                'sample1_barcode_id', x.sample1_barcode_id, 'tested_at', x.tested_at, 'submitted_at', x.sub_at,
                'moisture_pct',   case when v_role = 'lab1f' then null else x.moisture_pct end,
                'fineness_value', case when v_role = 'lab1m' then null else x.fineness_value end)
               order by x.sub_at desc, x.sample1_barcode_id)
          from (select l.sample1_barcode_id, l.tested_at, l.moisture_pct, l.fineness_value,
                       coalesce(case v_role when 'lab1m' then l.moisture_at when 'lab1f' then l.fineness_at else greatest(l.moisture_at, l.fineness_at) end, l.tested_at, '') as sub_at
                  from bm.lab1_results l
                 where (v_role = 'admin' and not exists (select 1 from bm.trucks bt where bt.sample1_barcode_id = l.sample1_barcode_id and bt.bottom_of is not null))
                    or ((l.moisture_by = u or l.fineness_by = u) and left(coalesce(l.tested_at, ''), 10) = bm.ist_date()::text)) x
    ), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_lab2_history(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text := bm.require(array['lab2','admin']); u text := bm.uname();
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object('composite_barcode_id', c.composite_barcode_id, 'tested_at', c.tested_at,
                                            'gcv_value', c.gcv_value, 'ash_pct', c.ash_pct, 'tm', round(c.tm_value, 2), 'is_lot4', bm.is_lot4(c.lot),
                                            'arb_sulphur', c.arb_sulphur, 'arb_vm', c.arb_vm) order by c.tested_at desc, c.created_at desc)
          from bm.composite_batches c
         where c.gcv_value is not null
           and (v_role = 'admin' or (c.tested_by = u and left(coalesce(c.tested_at, ''), 10) = bm.ist_date()::text))
    ), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_reader_templates(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_have int := coalesce(nullif(p->>'have_version', '')::int, -1); v_ver int; v_ex jsonb;
begin
    perform bm.require(array['lab1', 'lab1m', 'lab1f', 'admin']);
    select version, examples into v_ver, v_ex from bm.reader_templates where active;
    if v_ver is null then return jsonb_build_object('version', 0, 'examples', '[]'::jsonb); end if;
    if v_ver = v_have then return jsonb_build_object('version', v_ver, 'unchanged', true); end if;
    return jsonb_build_object('version', v_ver, 'examples', v_ex);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_sample1_details(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['lab1','lab1m','lab1f','admin']);
    t bm.trucks; l bm.lab1_results; res jsonb;
begin
    select * into t from bm.trucks where sample1_barcode_id = btrim(coalesce(p->>'barcode', ''));
    if not found then return jsonb_build_object('success', false, 'message', 'Invalid barcode scanned.'); end if;
    if v_role <> 'admin' and t.cancel_status is not null then          -- a cancelled / voided QR is not tested: the container is set aside
        return jsonb_build_object('success', false, 'cancelled', true, 'cancel_reason', t.cancel_reason,
            'message', format('This QR was %s%s. Do NOT test it - set the container aside.', case when t.cancel_status = 'VOIDED' then 'voided (registration cancelled)' else 'CANCELLED' end,
                              coalesce(' - reason: ' || t.cancel_reason, '')));
    end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    res := jsonb_build_object('success', true, 'sample1_barcode_id', t.sample1_barcode_id,
        'is_tested', l.sample1_barcode_id is not null,
        'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value, 'tested_at', l.tested_at);
    if v_role = 'admin' then
        res := res || jsonb_build_object('meta', jsonb_build_object(
            'truck_id', t.truck_id, 'company_name', t.company_name, 'truck_reg_number', t.truck_reg_number));
    end if;
    return res;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_truck_by_id(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare t bm.trucks;
begin
    perform bm.require(array['admin','entry','weighment','unloading']);
    select * into t from bm.trucks where truck_id = p->>'truck_id' and bottom_of is null and cancel_status is distinct from 'VOIDED';
    if not found then return null; end if;
    return bm.truck_view(t);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_trucks(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    r text := bm.require(array['admin','entry','weighment','unloading']);
    v_from date; v_to date; v_lim int := least(coalesce(nullif(p->>'limit','')::int, 20000), 50000);
    v_pending boolean := coalesce((p->>'include_pending')::boolean, false);   -- also return trucks still awaiting final weight, any age
begin
    if r = 'entry' then
        v_from := bm.ist_date(); v_to := v_from;              -- gate entry only ever sees today
    elsif coalesce((p->>'today')::boolean, false) then
        v_from := bm.ist_date(); v_to := v_from;
    elsif nullif(p->>'from', '') is not null and nullif(p->>'to', '') is not null then
        v_from := (p->>'from')::date; v_to := (p->>'to')::date;
    elsif nullif(p->>'days', '') is not null then
        v_from := bm.ist_date() - (p->>'days')::int;
    end if;
    return coalesce((
        select jsonb_agg(q.v order by q.ca desc)
          from (select bm.truck_view(x) as v, x.created_at as ca
                  from bm.trucks x
                 where x.bottom_of is null and x.cancel_status is distinct from 'VOIDED'
                   and (v_from is null or x.entry_date >= v_from or (v_pending and r <> 'entry' and x.tare_weight = 0))
                   and (v_to is null or x.entry_date <= v_to)
                 order by x.created_at desc limit v_lim) q
    ), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_get_unloading_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['unloading','admin']);
    v_code text := btrim(coalesce(p->>'code', ''));
    t bm.trucks; l bm.lab1_results; m numeric; st text; v_stage text; net numeric;
begin
    -- Truck-level lookup ONLY (truck id or vehicle number).  A sample barcode is never resolved for
    -- the unloading login, so it cannot be used to map a sample QR to a truck/supplier.
    select * into t from bm.trucks where truck_id = upper(v_code) and bottom_of is null and cancel_status is distinct from 'VOIDED' limit 1;
    if not found then
        select * into t from bm.trucks where bm.norm_reg(truck_reg_number) = bm.norm_reg(v_code) and bottom_of is null and cancel_status is distinct from 'VOIDED'
         order by created_at desc limit 1;
    end if;
    if not found and v_role = 'admin' then
        select * into t from bm.trucks where sample1_barcode_id = v_code limit 1;
    end if;
    if not found then
        return jsonb_build_object('success', false,
            'message', 'No consignment found. Enter the Truck ID or the vehicle number from the weighment slip.');
    end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    m := l.moisture_pct; st := bm.truck_status(t, m);
    net := case when t.gross_weight > 0 and t.tare_weight > 0 and t.gross_weight > t.tare_weight
                then t.gross_weight - t.tare_weight else t.net_weight end;
    v_stage := case when st = 'CANCELLED' then 'CANCELLED' when st = 'REJECTED' then 'REJECTED' when t.tare_weight > 0 then 'UNLOADED'
                    when st = 'ACCEPTED' then 'APPROVED_UNLOAD_PENDING' else 'SAMPLING_PENDING' end;
    return jsonb_build_object(
        'success', true, 'truck_id', t.truck_id, 'truck_reg_number', t.truck_reg_number,
        'invoice_no', coalesce(t.invoice_no, ''), 'challan_no', coalesce(t.invoice_no, ''),
        'driver_name', t.driver_name,
        'entry_date', t.entry_date, 'entry_time', t.entry_time,
        'moisture_pct', m, 'fineness_value', l.fineness_value,
        'gross_weight', t.gross_weight, 'tare_weight', t.tare_weight, 'net_weight', net,
        'acceptance_status', st, 'is_unloaded', t.tare_weight > 0 and st not in ('REJECTED', 'CANCELLED'), 'unloading_stage', v_stage,
        'moisture_limit', case when bm.is_lot4(t.lot) then null else 14 end, 'unloading_allowed', st = 'ACCEPTED',
        'cancel_status', t.cancel_status, 'cancel_code', t.cancel_code, 'cancel_reason', t.cancel_reason,
        'bottom_request', (select br.status from bm.bottom_requests br where br.truck_id = t.truck_id))
        || case when v_role = 'admin' then jsonb_build_object('company_name', t.company_name) else '{}'::jsonb end;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_lab2_composite_by_code(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_code text := upper(btrim(coalesce(p->>'code', ''))); v_date date := coalesce(nullif(p->>'date', '')::date, bm.ist_date()); b bm.composite_batches;
begin
    perform bm.require(array['lab2', 'admin']);
    if v_code = '' then return jsonb_build_object('success', false, 'message', 'Type the mixing code.'); end if;
    select * into b from bm.composite_batches where date = v_date and upper(daily_group_code) = v_code;
    if not found then
        return jsonb_build_object('success', false, 'message', format('No composite has been generated for mixing code %s on %s.', v_code, to_char(v_date, 'DD-MM-YYYY')));
    end if;
    return public.bm_get_composite_details(jsonb_build_object('code', b.composite_barcode_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_lab2_create_composite(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role  text := bm.require(array['lab2','admin']);
    v_date  date := coalesce(nullif(p->>'date', '')::date, bm.ist_date());
    v_group text := upper(btrim(coalesce(p->>'group_code', '')));
    v_acc_ids text[]; v_acc_raw text[]; v_acc_bars text[]; v_pending int; v_missing int; v_company text; v_lot text;
    v_n int; v_ref text; b bm.composite_batches;
    v_force boolean := coalesce(p->>'_force', '') = 'true' and bm.real_role() = 'superadmin';    -- only the Super Admin can switch this on
begin
    if v_group = '' then raise exception 'Mixing group code is required'; end if;

    perform 1 from bm.trucks where entry_date = v_date and daily_group_code = v_group for update;
    if not found then raise exception 'No trucks are registered under group [%] on %', v_group, v_date; end if;
    if exists (select 1 from bm.composite_batches where date = v_date and daily_group_code = v_group) then
        raise exception 'A composite has already been generated for group [%].', v_group; end if;

    select count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'PENDING'),
           coalesce(array_agg(coalesce(t.bottom_of, t.truck_id)) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED'), '{}'),
           coalesce(array_agg(t.truck_id) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED'), '{}'),
           coalesce(array_agg(t.sample1_barcode_id) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED'), '{}'),
           min(t.company_name), min(t.lot)
      into v_pending, v_acc_ids, v_acc_raw, v_acc_bars, v_company, v_lot
      from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
     where t.entry_date = v_date and t.daily_group_code = v_group;

    if v_pending > 0 then raise exception 'Lab-1 moisture results are still pending for % consignment(s) in this group.', v_pending; end if;
    if coalesce(array_length(v_acc_ids, 1), 0) = 0 then
        raise exception 'Cannot create a composite: every consignment in group [%] was REJECTED.', v_group; end if;
    select count(*) into v_missing from unnest(v_acc_bars) a where not exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = a);
    if v_missing > 0 and not v_force then
        raise exception 'Mixing scan incomplete: % accepted container(s) have not been scanned in the Fineness login yet.', v_missing; end if;

    v_n   := bm.next_counter('composite', v_date);
    v_ref := 'CMP-' || to_char(v_date, 'YYYYMMDD') || '-' || lpad(v_n::text, 3, '0');
    insert into bm.composite_batches(composite_ref_id, composite_barcode_id, company_name, date, daily_group_code,
            parent_truck_ids, test_lot, referee_lot, vendor_lot, system_samples_count, mixed_samples_count, lot)
    values (v_ref, v_ref || '-T', v_company, v_date, v_group, to_jsonb(v_acc_ids),
            v_ref || '-T', v_ref || '-R', v_ref || '-V', array_length(v_acc_ids, 1), array_length(v_acc_ids, 1), v_lot)
    returning * into b;
    update bm.trucks set composite_barcode_id = b.composite_barcode_id where truck_id = any(v_acc_ids) or truck_id = any(v_acc_raw);
    perform bm.log('COMPOSITE_CREATED', format('Composite %s created for group %s (%s samples)', v_ref, v_group, array_length(v_acc_ids, 1)));

    return jsonb_build_object('success', true, 'batch', jsonb_build_object(
        'composite_ref_id', b.composite_ref_id, 'composite_barcode_id', b.composite_barcode_id,
        'date', b.date, 'daily_group_code', b.daily_group_code,
        'test_lot', b.test_lot, 'referee_lot', b.referee_lot, 'vendor_lot', b.vendor_lot,
        'lots', jsonb_build_object('test', b.test_lot, 'referee', b.referee_lot, 'vendor', b.vendor_lot),
        'vendor_initials', bm.company_initials(b.company_name), 'vendor_name', b.company_name,
        'system_samples_count', b.system_samples_count, 'mixed_samples_count', b.mixed_samples_count));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_lab2_get_batch(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare b bm.composite_batches; v_date date := coalesce(nullif(p->>'date', '')::date, bm.ist_date());
begin
    perform bm.require(array['lab2','admin']);
    select * into b from bm.composite_batches where date = v_date and daily_group_code = upper(btrim(coalesce(p->>'group_code', '')));
    if not found then return null; end if;
    return jsonb_build_object(
        'composite_ref_id', b.composite_ref_id, 'composite_barcode_id', b.composite_barcode_id,
        'date', b.date, 'daily_group_code', b.daily_group_code,
        'test_lot', b.test_lot, 'referee_lot', b.referee_lot, 'vendor_lot', b.vendor_lot,
        'lots', jsonb_build_object('test', b.test_lot, 'referee', b.referee_lot, 'vendor', b.vendor_lot),
        'vendor_initials', bm.company_initials(b.company_name), 'vendor_name', b.company_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_lab2_mixing_groups(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['lab2','admin']);
    v_from date := coalesce(nullif(p->>'from', '')::date, nullif(p->>'date', '')::date, bm.ist_date());
    v_to   date := coalesce(nullif(p->>'to', '')::date, v_from);
    v_q    text := upper(btrim(coalesce(p->>'q', '')));
    v_open boolean := coalesce(nullif(p->>'from', ''), nullif(p->>'date', '')) is null or (v_from <= bm.ist_date() and v_to >= bm.ist_date());
    out jsonb := '[]'::jsonb; g record; c bm.composite_batches; item jsonb; prog jsonb;
begin
    if v_to < v_from then raise exception 'The "to" date is before the "from" date'; end if;
    if v_to - v_from > 366 then raise exception 'Please choose a range of at most one year'; end if;
    for g in
        select t.entry_date as d, t.daily_group_code as code,
               count(*) filter (where bm.mix_status(t, l.moisture_pct) <> 'CANCELLED')   as total,
               count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'CANCELLED')    as cnc,
               count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED')     as acc,
               count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'REJECTED')     as rej,
               count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'PENDING')      as pen,
               min(t.company_name)                                                as company,
               jsonb_agg(jsonb_build_object('sample1_barcode_id', t.sample1_barcode_id,
                                            'acceptance_status', bm.mix_status(t, l.moisture_pct),
                                            'moisture_pct', l.moisture_pct)
                         order by t.sample1_barcode_id)                           as trucks
          from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
         where (t.entry_date between v_from and v_to
                or (v_open and t.bottom_of is not null and t.created_at > now() - interval '7 days'      -- a bottom sample carries its ORIGINAL truck's (older) date
                    and not exists (select 1 from bm.composite_batches cc where cc.date = t.entry_date and cc.daily_group_code = t.daily_group_code)))
         group by t.entry_date, t.daily_group_code
        having count(*) filter (where bm.mix_status(t, l.moisture_pct) <> 'CANCELLED') > 0
         order by t.entry_date desc, t.daily_group_code
    loop
        select * into c from bm.composite_batches where date = g.d and daily_group_code = g.code;
        if v_q <> '' and position(v_q in upper(g.code)) = 0 and position(v_q in upper(coalesce(c.composite_ref_id, ''))) = 0 then continue; end if;
        prog := bm.mixing_progress(g.d, g.code);
        item := jsonb_build_object(
            'group_code', g.code, 'date', g.d, 'total_registered', g.total, 'total_trucks', g.total,
            'accepted_count', g.acc, 'rejected_count', g.rej, 'pending_count', g.pen, 'cancelled_count', g.cnc,
            'scanned_accepted', prog->'accepted_scanned', 'rejected_scanned', prog->'rejected_scanned',
            'all_scanned', g.acc > 0 and (prog->>'accepted_scanned')::int >= g.acc,
            'is_batch_created', c.composite_ref_id is not null, 'already_batched', c.composite_ref_id is not null,
            'batch_ref_id', c.composite_ref_id, 'composite_barcode_id', c.composite_barcode_id,
            'mixed_samples_count', c.mixed_samples_count);
        if v_role = 'admin' then item := item || jsonb_build_object('company_name', g.company, 'trucks', g.trucks); end if;
        out := out || jsonb_build_array(item);
    end loop;
    return jsonb_build_object('success', true, 'from', v_from, 'to', v_to, 'date', v_from, 'groups', out);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_lab2_scan_sample(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare t bm.trucks; l bm.lab1_results; st text;
begin
    perform bm.require(array['admin']);
    select * into t from bm.trucks where sample1_barcode_id = btrim(coalesce(p->>'barcode', ''));
    if not found then
        return jsonb_build_object('success', false, 'message', 'Sample barcode not recognized in the system.');
    end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    st := bm.mix_status(t, l.moisture_pct);
    return jsonb_build_object('success', true,
        'sample1_barcode_id', t.sample1_barcode_id, 'sample_barcode_id', t.sample1_barcode_id,
        'daily_group_code', t.daily_group_code, 'entry_date', t.entry_date,
        'moisture_pct', l.moisture_pct, 'acceptance_status', st,
        'is_accepted', st = 'ACCEPTED', 'is_rejected', st = 'REJECTED', 'is_pending', st = 'PENDING',
        'already_batched', coalesce(t.composite_barcode_id, '') <> '',
        'composite_barcode_id', coalesce(t.composite_barcode_id, ''));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_list_companies(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text;
begin
    v_role := bm.require(array['admin','entry','weighment']);
    return coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'po_number', c.po_number, 'lot', c.lot, 'active', c.active) order by c.name, c.lot)
                     from bm.companies c where c.active or (v_role = 'admin' and coalesce(p->>'include_retired', '') = 'true')), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_log_activity(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text; v_a text := translate(coalesce(p->>'action', 'Event'), '<>"`', '‹›″´');
begin
    v_role := bm.require(array['admin','entry','weighment','unloading','lab1','lab1m','lab1f','lab2']);
    -- Any signed-in user can write log text (e.g. a scanned code they typed). Neutralise markup characters so a log
    -- line can never carry script into the admin's audit-log page - and never let the browser write a line that looks like a server-written one
    -- (SUPERADMIN_*, NEW_IP_DETECTED, VENDOR_* ...): only the two events the app itself reports keep their name, everything else is marked CLIENT_.
    if not (lower(v_a) = 'security exception' or (v_a = 'PHOTOS_PURGED' and v_role = 'admin')) then v_a := 'CLIENT_' || left(v_a, 80); end if;
    perform bm.log(v_a, translate(coalesce(p->>'details', ''), '<>"`', '‹›″´'));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_mixing_scan(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare t bm.trucks; l bm.lab1_results; st text; v_bar text := btrim(coalesce(p->>'barcode', ''));
        v_new boolean := false; s bm.mixing_scans;
begin
    perform bm.require(array['lab1f']);
    select * into t from bm.trucks where sample1_barcode_id = v_bar;
    if not found then return jsonb_build_object('success', false, 'message', 'Sample barcode not recognized in the system.'); end if;
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    st := bm.mix_status(t, l.moisture_pct);
    if st = 'CANCELLED' then          -- cancelled QR: set it aside, it is not part of the mixture and nothing waits for it
        return jsonb_build_object('success', true, 'cancelled', true, 'duplicate', false, 'include', false, 'sample1_barcode_id', t.sample1_barcode_id,
            'daily_group_code', t.daily_group_code, 'entry_date', t.entry_date, 'status', 'CANCELLED', 'scanned_time', bm.ist_time(), 'cancel_reason', t.cancel_reason,
            'progress', bm.mixing_progress(t.entry_date, t.daily_group_code));
    end if;
    if exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code) then
        return jsonb_build_object('success', false, 'daily_group_code', t.daily_group_code, 'entry_date', t.entry_date,
            'message', format('Mixing group %s already has its composite generated. Nothing more can be scanned for it.', t.daily_group_code));
    end if;
    if st = 'PENDING' then
        return jsonb_build_object('success', false, 'daily_group_code', t.daily_group_code, 'entry_date', t.entry_date, 'status', st,
            'message', 'Lab 1 has not recorded the moisture result for this container yet, so it cannot be mixed yet.');
    end if;
    insert into bm.mixing_scans(sample1_barcode_id, entry_date, group_code, scanned_by, scanned_time)
    values (t.sample1_barcode_id, t.entry_date, t.daily_group_code, bm.uname(), bm.ist_time())
    on conflict (sample1_barcode_id) do nothing;
    v_new := found;
    select * into s from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;
    if v_new then perform bm.log('MIXING_SCAN', format('Container %s scanned for mixing group %s', t.sample1_barcode_id, t.daily_group_code)); end if;
    return jsonb_build_object('success', true, 'duplicate', not v_new, 'sample1_barcode_id', t.sample1_barcode_id,
        'daily_group_code', t.daily_group_code, 'entry_date', t.entry_date, 'status', st, 'include', st = 'ACCEPTED',
        'scanned_time', s.scanned_time, 'scanned_by', s.scanned_by, 'progress', bm.mixing_progress(t.entry_date, t.daily_group_code));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_mixing_scan_summary(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_date date := coalesce(nullif(p->>'date', '')::date, bm.ist_date()); out jsonb := '[]'::jsonb; g record; c bm.composite_batches;
begin
    perform bm.require(array['lab1f', 'admin']);
    for g in select t.daily_group_code as code from bm.trucks t where t.entry_date = v_date group by t.daily_group_code order by t.daily_group_code
    loop
        select * into c from bm.composite_batches where date = v_date and daily_group_code = g.code;
        out := out || jsonb_build_array(bm.mixing_progress(v_date, g.code) || jsonb_build_object(
            'group_code', g.code, 'date', v_date, 'composite_generated', c.composite_ref_id is not null,
            'scanned', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'include', x.st = 'ACCEPTED', 'time', x.tm) order by x.tm, x.id)
                                   from (select t.sample1_barcode_id as id, bm.mix_status(t, l.moisture_pct) as st, m.scanned_time as tm
                                           from bm.mixing_scans m join bm.trucks t on t.sample1_barcode_id = m.sample1_barcode_id
                                           left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
                                          where m.entry_date = v_date and m.group_code = g.code) x), '[]'::jsonb),
            'to_scan', coalesce((select jsonb_agg(t.sample1_barcode_id order by t.sample1_barcode_id)
                                   from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
                                  where t.entry_date = v_date and t.daily_group_code = g.code and bm.mix_status(t, l.moisture_pct) = 'ACCEPTED'
                                    and not exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = t.sample1_barcode_id)), '[]'::jsonb),
            'rejected_to_set_aside', coalesce((select jsonb_agg(t.sample1_barcode_id order by t.sample1_barcode_id)
                                   from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
                                  where t.entry_date = v_date and t.daily_group_code = g.code and bm.mix_status(t, l.moisture_pct) in ('REJECTED', 'CANCELLED')
                                    and not exists (select 1 from bm.mixing_scans m where m.sample1_barcode_id = t.sample1_barcode_id)), '[]'::jsonb)));
    end loop;
    return jsonb_build_object('success', true, 'date', v_date, 'groups', out);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_my_security(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    if bm.real_role() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    return jsonb_build_object('role', bm.real_role(), 'enrolled', bm.is_enrolled(auth.uid()), 'aal', coalesce(bm.jwt_claim('aal'), 'aal1'),
        'mfa_required', coalesce((select value from bm.settings where key = 'mfa_required'), 'off') = 'on');
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_register_truck(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role   text := bm.require(array['admin','entry']);
    v_company text := btrim(regexp_replace(coalesce(p->>'company_name', ''), '\s+', ' ', 'g'));
    v_driver text := btrim(coalesce(p->>'driver_name', ''));
    v_reg    text := btrim(coalesce(p->>'truck_reg_number', ''));
    v_inv    text := btrim(coalesce(nullif(p->>'invoice_no', ''), p->>'challan_no', ''));
    v_photo  text := coalesce(p->>'photo_url', '');
    v_date   date := bm.ist_date();
    v_canon  text; v_po text; v_group text; v_n int; v_truck text; v_s1 text;
    v_lot    text := nullif(btrim(coalesce(p->>'lot', '')), '');
    v_cnt    int; v_all int; v_lot_req text;
    t bm.trucks;
begin
    if v_company = '' then raise exception 'Supplier name is required'; end if;
    if v_lot is not null and v_lot not in ('LOT2/3', 'LOT2', 'LOT3', 'LOT4', 'LOT4A') then raise exception 'Unknown lot "%"', v_lot; end if;
    if v_reg = ''     then raise exception 'Vehicle registration number is required'; end if;
    if length(v_company) > 200 or length(v_driver) > 200 or length(v_reg) > 50 or length(v_inv) > 100 then
        raise exception 'One of the fields is too long'; end if;
    if not (bm.is_safe_text(v_company) and bm.is_safe_text(v_driver) and bm.is_safe_text(v_reg) and bm.is_safe_text(v_inv)) then
        raise exception 'Supplier, driver, vehicle and invoice fields may not contain < > " ` \ or ${ characters'; end if;
    if v_photo <> '' and not bm.photo_ok(v_photo) then raise exception 'Invalid gate photo'; end if;
    if length(v_photo) > 2500000 then raise exception 'Gate photo is too large'; end if;
    if v_role = 'admin' and nullif(p->>'entry_date', '') is not null then v_date := (p->>'entry_date')::date; end if;

    -- canonical supplier (case / spacing tolerant) so "Anshika" and "ANSHIKA " are one supplier.
    -- A supplier may exist under both lots (different PO): the operator must then say which one (lot), it is never guessed.
    select count(*) filter (where c.active), count(*) into v_cnt, v_all from bm.companies c where bm.vkey(c.name) = bm.vkey(v_company);
    if v_cnt = 0 and v_all > 0 then
        raise exception 'This supplier has been retired and can no longer be booked. Ask the administrator (Vendors tab).';
    elsif v_cnt = 0 then
        v_lot := coalesce(v_lot, 'LOT2/3');
        insert into bm.companies(name, lot) values (v_company, v_lot);
        v_canon := v_company;
        perform bm.log('NEW_SUPPLIER', format('New supplier added at gate entry: %s (%s)', v_company, v_lot));
    else
        if v_cnt > 1 and v_lot is null then
            raise exception 'This supplier exists under more than one Lot / PO. Select the correct Lot / PO from the list.'; end if;
        v_lot_req := v_lot;
        select c.name, c.po_number, c.lot into v_canon, v_po, v_lot from bm.companies c
         where bm.vkey(c.name) = bm.vkey(v_company) and c.active and (v_lot is null or c.lot = v_lot)
         order by c.lot limit 1;
        if v_canon is null then
            raise exception 'This supplier has no % entry. Ask the administrator to add it.', v_lot_req; end if;
        if nullif(p->>'po_number', '') is not null and v_po is not null and p->>'po_number' <> v_po then
            raise exception 'The PO number chosen on screen (%) does not match the supplier record (%). Reload the page and select again.', p->>'po_number', v_po; end if;
    end if;

    v_group := bm.group_for(v_canon, v_date, v_lot);
    v_n     := bm.next_counter('truck', v_date);
    v_truck := 'TRK-' || to_char(v_date, 'YYYYMMDD') || '-' || lpad(v_n::text, 4, '0');
    loop
        v_s1 := 'S1-' || upper(bm.rand_hex(8));
        exit when not exists (select 1 from bm.trucks where sample1_barcode_id = v_s1);
    end loop;

    insert into bm.trucks(truck_id, company_name, driver_name, truck_reg_number, invoice_no, po_number, lot,
                          entry_date, entry_time, sample1_barcode_id, daily_group_code, photo_url, created_by)
    values (v_truck, v_canon, v_driver, v_reg, v_inv, v_po, v_lot, v_date, bm.ist_time(), v_s1, v_group,
            nullif(v_photo, ''), bm.uname())
    returning * into t;

    perform bm.log('TRUCK_REGISTERED', format('Truck %s registered (vehicle %s)', v_truck, v_reg));

    -- Entry receives its own just-created barcode (needed to print the label once) but NEVER the group code.
    return jsonb_build_object(
        'truck_id', t.truck_id, 'company_name', t.company_name, 'driver_name', t.driver_name,
        'truck_reg_number', t.truck_reg_number, 'invoice_no', coalesce(t.invoice_no, ''),
        'challan_no', coalesce(t.invoice_no, ''), 'entry_date', t.entry_date, 'entry_time', t.entry_time,
        'lot', t.lot, 'po_number', t.po_number,
        'sample1_barcode_id', t.sample1_barcode_id,
        'daily_group_code', case when v_role = 'admin' then t.daily_group_code else null end);
end $function$
;

set check_function_bodies = on;
