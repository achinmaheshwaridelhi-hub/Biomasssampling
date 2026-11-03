-- public.bm_* functions, batch 4 of 5 (bm_storage_role ... bm_super_ip_label), exactly as dumped.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bm_storage_role(p jsonb DEFAULT '{}'::jsonb)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select bm.role() $function$
;

CREATE OR REPLACE FUNCTION public.bm_submit_composite_result(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['lab2','admin']);
    v_code text := btrim(coalesce(p->>'code', ''));
    v_adm numeric := nullif(p->>'ad_moisture', '')::numeric;  v_gcv numeric := nullif(p->>'ad_gcv', '')::numeric;
    v_ash numeric := nullif(p->>'ad_ash', '')::numeric;       v_sul numeric := nullif(p->>'ad_sulphur', '')::numeric;
    v_vm  numeric := nullif(p->>'ad_vm', '')::numeric;
    v_ov text := case when v_role = 'admin' then nullif(btrim(coalesce(p->>'override_reason', '')), '') end;
    b bm.composite_batches; calc jsonb; v_pwmsg text;
begin
    select * into b from bm.composite_batches where composite_barcode_id = v_code or test_lot = v_code for update;
    if not found then raise exception 'Invalid composite barcode (only the Test Lot -T code can be submitted).'; end if;
    if v_ov is not null and bm.real_role() = 'admin' then          -- the Admin needs the Admin edit password (kept by the Super Admin) for EVERY correction
        v_pwmsg := bm.check_edit_password(p->>'edit_password', 'correction of composite ' || b.composite_ref_id);
        if v_pwmsg is not null then return jsonb_build_object('success', false, 'message', v_pwmsg); end if;
    end if;
    if v_adm is null or v_gcv is null or v_ash is null then raise exception 'AD Moisture, AD GCV and AD Ash are required'; end if;
    if v_adm <= 0 or v_adm >= 100 then raise exception 'AD Moisture must be above 0 and below 100 %%'; end if;
    if v_gcv <= 0 or v_gcv > 15000 then raise exception 'AD GCV must be between 0 and 15000 kcal/kg'; end if;
    if v_ash < 0 or v_ash > 100 then raise exception 'AD Ash must be between 0 and 100 %%'; end if;
    if bm.is_lot4(b.lot) then
        if v_sul is null or v_vm is null then raise exception 'AD Sulphur and AD VM are required for this composite'; end if;
        if v_sul < 0 or v_sul > 100 then raise exception 'AD Sulphur must be between 0 and 100 %%'; end if;
        if v_vm  < 0 or v_vm  > 100 then raise exception 'AD VM must be between 0 and 100 %%'; end if;
    elsif v_sul is not null or v_vm is not null then
        raise exception 'Sulphur and VM are recorded for Lot-4 composites only';
    end if;
    if b.gcv_value is not null and v_ov is null then
        raise exception 'This composite result is already submitted and locked.'; end if;
    if v_ov is not null then perform set_config('bm.allow_override', 'on', true); end if;
    calc := bm.calc_values(b, v_adm, v_gcv, v_ash, v_sul, v_vm);
    update bm.composite_batches set ad_moisture = v_adm, ad_gcv = v_gcv, ad_ash = v_ash, ad_sulphur = v_sul, ad_vm = v_vm,
           tm_value = (calc->>'tm')::numeric, x_factor = (calc->>'x')::numeric,
           gcv_value = (calc->>'arb_gcv')::numeric, ash_pct = (calc->>'arb_ash')::numeric,
           arb_sulphur = (calc->>'arb_sulphur')::numeric, arb_vm = (calc->>'arb_vm')::numeric,
           tested_by = bm.uname(), tested_at = bm.ist_now()
     where composite_ref_id = b.composite_ref_id;
    perform bm.log(case when v_ov is null then 'COMPOSITE_RESULT' else 'COMPOSITE_OVERRIDE' end,
                   format('Composite %s result recorded (TM %s, X %s)%s', b.composite_ref_id, round((calc->>'tm')::numeric, 3), round((calc->>'x')::numeric, 6),
                          coalesce('. Reason: ' || v_ov, '')));
    if v_ov is not null and bm.real_role() = 'admin' then
        perform bm.log('ADMIN_VALUE_EDIT', format('Admin corrected composite %s: AD moisture %s -> %s, AD GCV %s -> %s, AD ash %s -> %s, AD sulphur %s -> %s, AD VM %s -> %s (ARB GCV %s -> %s, ARB ash %s -> %s). Reason: %s',
            b.composite_ref_id, coalesce(b.ad_moisture::text, '-'), v_adm, coalesce(b.ad_gcv::text, '-'), v_gcv, coalesce(b.ad_ash::text, '-'), v_ash, coalesce(b.ad_sulphur::text, '-'), coalesce(v_sul::text, '-'), coalesce(b.ad_vm::text, '-'), coalesce(v_vm::text, '-'),
            coalesce(b.gcv_value::text, '-'), calc->>'arb_gcv', coalesce(b.ash_pct::text, '-'), calc->>'arb_ash', v_ov));      -- shown in the Admin AND the Super Admin audit log
    end if;
    return jsonb_build_object('success', true) || calc;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_submit_lab1_result(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role  text := bm.require(array['lab1','lab1m','lab1f','admin']);
    v_bar   text := btrim(coalesce(p->>'barcode', ''));
    v_can_m boolean := v_role <> 'lab1f';
    v_can_f boolean := v_role <> 'lab1m';
    v_m     numeric := nullif(p->>'moisture', '')::numeric;
    v_iw    numeric := nullif(p->>'fineness_initial_weight', '')::numeric;
    v_fw    numeric := nullif(p->>'fineness_final_weight', '')::numeric;
    v_ov    text    := case when v_role = 'admin' then nullif(btrim(coalesce(p->>'override_reason', '')), '') end;
    v_mph   text := coalesce(p->>'moisture_photo', '');
    v_iph   text := coalesce(p->>'fineness_initial_photo', '');
    v_fph   text := coalesce(p->>'fineness_final_photo', '');
    l bm.lab1_results; ts text := bm.ist_now(); v_fin numeric; wrote boolean := false; v_status text; v_lot text; v_tid text; v_cs text; v_cr text; v_kind text; v_conf numeric; i int; v_own text; v_exs jsonb; v_pwmsg text; l0 bm.lab1_results; v_chg text := '';
begin
    select lot, truck_id, cancel_status, cancel_reason into v_lot, v_tid, v_cs, v_cr from bm.trucks where sample1_barcode_id = v_bar;
    if not found then return jsonb_build_object('success', false, 'message', 'Invalid barcode. Truck entry not found.'); end if;
    if v_role <> 'admin' and v_cs is not null then
        return jsonb_build_object('success', false, 'cancelled', true, 'cancel_reason', v_cr,
            'message', format('This QR was %s%s. Nothing was saved - set the container aside.', case when v_cs = 'VOIDED' then 'voided (registration cancelled)' else 'CANCELLED' end, coalesce(' - reason: ' || v_cr, '')));
    end if;
    if v_m is null and v_iw is null and v_fw is null then raise exception 'Nothing to submit'; end if;
    if v_ov is not null and bm.real_role() = 'admin' then          -- the Admin needs the Admin edit password (kept by the Super Admin) for EVERY correction
        v_pwmsg := bm.check_edit_password(p->>'edit_password', 'correction of sample ' || v_bar);
        if v_pwmsg is not null then return jsonb_build_object('success', false, 'message', v_pwmsg); end if;
    end if;
    if greatest(length(v_mph), length(v_iph), length(v_fph)) > 2500000 then raise exception 'Photo is too large'; end if;

    insert into bm.lab1_results(sample1_barcode_id) values (v_bar) on conflict do nothing;
    select * into l from bm.lab1_results where sample1_barcode_id = v_bar for update;
    l0 := l;

    if v_ov is not null then perform set_config('bm.allow_override', 'on', true); end if;

    if v_m is not null then
        if not v_can_m then raise exception 'This login is not allowed to record moisture'; end if;
        if v_m <= 0 or v_m >= 100 then raise exception 'Moisture must be greater than 0 and less than 100 %%'; end if;
        if l.moisture_pct is not null and v_ov is null then
            raise exception 'Moisture for this sample is already submitted and locked.'; end if;
        if v_role <> 'admin' and not bm.photo_ok(v_mph) then
            raise exception 'Mandatory scale photo proof required for the moisture reading'; end if;
        if v_ov is not null and l.moisture_pct is not null and round(v_m, 3) is distinct from l.moisture_pct then perform bm.guard_status_flip(v_tid, l.moisture_pct, round(v_m, 3)); end if;
        update bm.lab1_results set moisture_pct = round(v_m, 3), moisture_by = bm.uname(), moisture_at = ts,
               moisture_photo = coalesce(nullif(v_mph, ''), moisture_photo), tested_by = bm.uname(), tested_at = ts
         where sample1_barcode_id = v_bar;
        wrote := true;
        if v_ov is not null and l.moisture_pct is not null and round(v_m, 3) is distinct from l.moisture_pct then
            perform bm.recompute_for_truck(v_tid, format('moisture of truck %s corrected', v_tid));
        end if;
    end if;

    if v_iw is not null or v_fw is not null then
        if not v_can_f then raise exception 'This login is not allowed to record fineness'; end if;
        if v_iw is null or v_fw is null then raise exception 'Both the initial and the final weight are required for fineness'; end if;
        if v_iw <= 0 or v_fw < 0 then raise exception 'Invalid fineness weights'; end if;
        if v_fw > v_iw then raise exception 'Final retained weight cannot exceed the initial sample weight'; end if;
        if l.fineness_value is not null and v_ov is null then
            raise exception 'Fineness for this sample is already submitted and locked.'; end if;
        if v_role <> 'admin' and (not bm.photo_ok(v_iph) or not bm.photo_ok(v_fph)) then
            raise exception 'Mandatory scale photo proof required for BOTH fineness weights'; end if;
        v_fin := round(v_fw / v_iw * 100, 2);            -- computed on the server, never trusted from the browser
        update bm.lab1_results set fineness_initial_weight = v_iw, fineness_final_weight = v_fw, fineness_value = v_fin,
               fineness_by = bm.uname(), fineness_at = ts,
               fineness_initial_photo = coalesce(nullif(v_iph, ''), fineness_initial_photo),
               fineness_final_photo   = coalesce(nullif(v_fph, ''), fineness_final_photo),
               tested_by = bm.uname(), tested_at = ts
         where sample1_barcode_id = v_bar;
        wrote := true;
    end if;

    select * into l from bm.lab1_results where sample1_barcode_id = v_bar;
    select bm.truck_status(x, l.moisture_pct) into v_status from bm.trucks x where x.sample1_barcode_id = v_bar;
    update bm.trucks set acceptance_status = v_status where sample1_barcode_id = v_bar;
    if v_ov is not null then
        perform bm.log('LAB1_OVERRIDE', format('Sample %s corrected by admin. Reason: %s', v_bar, v_ov));
        if bm.real_role() = 'admin' then
            if v_m is not null then v_chg := v_chg || format('moisture %s -> %s %%; ', coalesce(l0.moisture_pct::text, 'none'), l.moisture_pct); end if;
            if v_iw is not null or v_fw is not null then v_chg := v_chg || format('fineness weights initial %s / final %s -> %s / %s kg (fineness %s -> %s %%); ', coalesce(l0.fineness_initial_weight::text, '-'), coalesce(l0.fineness_final_weight::text, '-'), l.fineness_initial_weight, l.fineness_final_weight, coalesce(l0.fineness_value::text, '-'), l.fineness_value); end if;
            perform bm.log('ADMIN_VALUE_EDIT', format('Admin corrected sample %s: %sReason: %s', v_bar, v_chg, v_ov));      -- shown in the Admin AND the Super Admin audit log
        end if;
    else
        perform bm.log('LAB1_RESULT', format('Sample %s result recorded (%s): moisture %s, fineness %s (initial %s / final %s)', v_bar, v_role,
            coalesce(l.moisture_pct::text, '-'), coalesce(l.fineness_value::text, '-'), coalesce(l.fineness_initial_weight::text, '-'), coalesce(l.fineness_final_weight::text, '-')));
    end if;
    -- Reader training: a photo the reader was NOT sure about (< 50 %) and the operator then confirmed is kept (value + photo, no supplier)
    -- so the Admin can let the reader learn from it. Only what was really saved in THIS submission, never for an Admin correction.
    if v_ov is null and wrote and jsonb_typeof(p->'low_conf') = 'array' and coalesce((select value from bm.settings where key = 'reader_training_collect'), 'on') = 'on' then
        for i in 0 .. least(jsonb_array_length(p->'low_conf'), 3) - 1 loop
            v_kind := p->'low_conf'->i->>'kind';
            v_conf := nullif(p->'low_conf'->i->>'conf', '')::numeric;
            v_own := nullif(p->'low_conf'->i->>'photo', '');                      -- the training copy of the photo (own file), when the browser made one
            v_exs := case when bm.valid_examples(p->'low_conf'->i->'examples') then p->'low_conf'->i->'examples' else null end;
            if v_own is not null and (length(v_own) > 2500000 or not bm.photo_ok(v_own)) then v_own := null; end if;
            if v_kind = 'moisture' and v_can_m and v_m is not null and bm.photo_ok(v_mph) then
                insert into bm.reader_training(kind, value, conf, photo, sample1_barcode_id, submitted_by) values ('moisture', round(v_m, 3), v_conf, coalesce(v_own, v_mph), v_bar, bm.uname());
            elsif v_kind = 'fineness_initial' and v_can_f and v_iw is not null and bm.photo_ok(v_iph) then
                insert into bm.reader_training(kind, value, conf, photo, sample1_barcode_id, submitted_by, examples) values ('fineness_initial', v_iw, v_conf, coalesce(v_own, v_iph), v_bar, bm.uname(), v_exs);
            elsif v_kind = 'fineness_final' and v_can_f and v_fw is not null and bm.photo_ok(v_fph) then
                insert into bm.reader_training(kind, value, conf, photo, sample1_barcode_id, submitted_by, examples) values ('fineness_final', v_fw, v_conf, coalesce(v_own, v_fph), v_bar, bm.uname(), v_exs);
            end if;
        end loop;
    end if;
    return jsonb_build_object('success', true,
        'record', jsonb_build_object('sample1_barcode_id', l.sample1_barcode_id, 'moisture_pct', l.moisture_pct,
                                     'fineness_value', l.fineness_value, 'tested_at', l.tested_at),
        'acceptance_status', v_status, 'moisture_limit', case when bm.is_lot4(v_lot) then null else 14 end);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_action_password_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('password_set', exists (select 1 from bm.settings where key = 'bottom_pw_hash'),
        'changed_at', (select updated_at from bm.settings where key = 'bottom_pw_hash'),
        'pending_requests', (select count(*) from bm.bottom_requests where status = 'REQUESTED'),
        'generated', (select count(*) from bm.bottom_requests where status = 'GENERATED'));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_bottom(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; v_act text := upper(btrim(coalesce(p->>'action', ''))); v_tid text := btrim(coalesce(p->>'truck_id', '')); t bm.trucks; r bm.bottom_requests; b bm.trucks;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = v_tid and bottom_of is null and cancel_status is null;
    if not found then raise exception 'Truck not found'; end if;
    select * into r from bm.bottom_requests where truck_id = t.truck_id;
    if v_act = 'REQUEST' then
        if found then raise exception 'A bottom sample was already requested for this truck.'; end if;
        if exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code) then raise exception 'The composite of its mixing group exists. Void it first.'; end if;
        insert into bm.bottom_requests(truck_id, requested_by, requested_date, requested_time, reason) values (t.truck_id, bm.uname(), bm.ist_date(), bm.ist_time(), 'Super Admin: ' || v_reason);
        perform bm.super_log('BOTTOM_REQUESTED', format('Bottom sample requested for truck %s (%s) without the password. Reason: %s', t.truck_id, t.truck_reg_number, v_reason));
    elsif v_act = 'CANCEL_REQUEST' then
        if not found or r.status <> 'REQUESTED' then raise exception 'There is no pending bottom-sample request for this truck.'; end if;
        delete from bm.bottom_requests where truck_id = t.truck_id;
        perform bm.super_log('BOTTOM_REQUEST_CANCELLED', format('Bottom-sample request of truck %s (%s) cancelled. Reason: %s', t.truck_id, t.truck_reg_number, v_reason));
    elsif v_act = 'UNDO' then
        if not found or r.status <> 'GENERATED' then raise exception 'No generated bottom sample exists for this truck.'; end if;
        select * into b from bm.trucks where truck_id = r.bottom_truck_id;
        if exists (select 1 from bm.composite_batches c where c.date = b.entry_date and c.daily_group_code = b.daily_group_code) then
            raise exception 'The bottom sample already has its composite. Void that composite first.'; end if;
        update bm.trucks set cancel_status = 'VOIDED', cancel_code = 'SUPERADMIN', cancel_reason = 'Bottom sample undone: ' || v_reason, cancelled_by = bm.uname(), cancelled_at = now() where truck_id = b.truck_id;
        delete from bm.mixing_scans where sample1_barcode_id = b.sample1_barcode_id;
        if not exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code) then
            update bm.trucks set excluded_from_mix = false where truck_id = t.truck_id;       -- the original sample is part of its mixture again
        end if;
        delete from bm.bottom_requests where truck_id = t.truck_id;
        perform bm.super_log('BOTTOM_UNDONE', format('Bottom sample of truck %s (%s) undone; the original sample is %s. Reason: %s', t.truck_id, t.truck_reg_number,
            case when exists (select 1 from bm.trucks x where x.truck_id = t.truck_id and not x.excluded_from_mix) then 'back in its mixture' else 'still out of the (already made) composite' end, v_reason));
    else
        raise exception 'Unknown bottom-sample action';
    end if;
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_cancel_qr(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; t bm.trucks;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and bottom_of is null and cancel_status is null for update;
    if not found then raise exception 'Truck not found or already cancelled'; end if;
    if exists (select 1 from bm.composite_batches c where c.parent_truck_ids ? t.truck_id) then raise exception 'The truck is part of a composite. Void that composite first.'; end if;
    update bm.trucks set cancel_status = 'CANCELLED', cancel_code = 'OTHER', cancel_reason = v_reason, cancelled_by = bm.uname(), cancelled_at = now() where truck_id = t.truck_id;
    delete from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;
    perform bm.super_log('QR_CANCELLED', format('QR of truck %s (%s) cancelled by the Super Admin: %s', t.truck_id, t.truck_reg_number, v_reason));
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_convert_lot(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_dry boolean := coalesce(p->>'dry_run', '') = 'true'; v_reason text; v_name text := btrim(regexp_replace(coalesce(p->>'company_name', ''), '\s+', ' ', 'g'));
    v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date; v_switch boolean := coalesce(p->>'switch_po', '') = 'true';
    v_both boolean := coalesce(p->>'keep_both', '') = 'true';
    v_target text := coalesce(nullif(btrim(p->>'target_lot'), ''), 'LOT4'); v_src text[];
    c4 bm.companies; v_tr int; v_bt int; v_grp int; v_cu int; v_ct int; v_rej int; v_conf jsonb; v_dates jsonb; v_ids text[];
begin
    perform bm.require_super();
    if v_name = '' then raise exception 'Choose the vendor'; end if;
    if v_target not in ('LOT4', 'LOT4A') then raise exception 'The target lot must be LOT4 or LOT4A'; end if;
    v_src := case when v_target = 'LOT4A' then array['LOT4'] else array['LOT2/3', 'LOT2', 'LOT3'] end;      -- Lot 4A takes over from Lot 4; Lot 4 from the old Lot 2/3, Lot 2 and Lot 3
    if v_from is not null and v_to is not null and v_from > v_to then raise exception 'The first date is after the last date'; end if;
    select * into c4 from bm.companies where lot = v_target and active and bm.norm_vendor(name) = bm.norm_vendor(v_name);
    if not found then raise exception 'There is no active % entry for "%". Add the vendor under that lot first (Admin > Vendors).', v_target, v_name; end if;
    select array_agg(t.truck_id), count(*) filter (where t.bottom_of is null), count(*) filter (where t.bottom_of is not null),
           count(distinct (t.entry_date, t.daily_group_code)) filter (where t.bottom_of is null)
      into v_ids, v_tr, v_bt, v_grp
      from bm.trucks t where t.lot = any(v_src) and bm.norm_vendor(t.company_name) = bm.norm_vendor(c4.name)
       and (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to);
    if coalesce(v_tr, 0) + coalesce(v_bt, 0) = 0 then raise exception 'There are no trucks of % to convert in that period', c4.name; end if;
    select count(*) filter (where b.gcv_value is null), count(*) filter (where b.gcv_value is not null) into v_cu, v_ct
      from bm.composite_batches b where b.lot = any(v_src) and bm.norm_vendor(b.company_name) = bm.norm_vendor(c4.name)
       and (v_from is null or b.date >= v_from) and (v_to is null or b.date <= v_to);
    select count(*) into v_rej from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
     where t.truck_id = any(v_ids) and t.bottom_of is null and t.cancel_status is null and t.acceptance_override is null and v_target = 'LOT4' and bm.accept(l.moisture_pct, 'LOT2/3') = 'REJECTED';
    -- a LOT4 group of the same vendor and day that already exists would collide with the converted one
    select coalesce(jsonb_agg(distinct g.entry_date), '[]'::jsonb) into v_conf
      from bm.mixing_groups g where g.lot = any(v_src) and (bm.norm_vendor(g.company_name) = bm.norm_vendor(c4.name))
       and (v_from is null or g.entry_date >= v_from) and (v_to is null or g.entry_date <= v_to)
       and exists (select 1 from bm.mixing_groups g4 where g4.lot = v_target and g4.entry_date = g.entry_date and g4.company_name = g.company_name);
    -- ...unless the Super Admin chooses to KEEP BOTH codes: the Lot-3 code (e.g. MRQ) stays as it is, only its trucks and composite become LOT4, next to the vendor's existing
    -- LOT4 code (e.g. NRB) of that day. (Its allocation row in bm.mixing_groups stays as it is; new bookings of the day keep joining the existing LOT4 code.)
    if jsonb_array_length(v_conf) > 0 and not v_both then
        raise exception 'On % the vendor already has a LOT4 mixing code as well as a Lot-2/3 one. Choose "keep both mixing codes" to convert the Lot-2/3 code in place (both stay, both Lot 4), or convert the other days only (set the dates).',
            (select string_agg(x, ', ') from jsonb_array_elements_text(v_conf) x); end if;
    if not v_dry then
        v_reason := bm.super_reason(p);
        perform set_config('bm.allow_override', 'on', true);
        -- trucks that were rejected under the Lot-3 rule stay rejected (Lot 4 itself never rejects for moisture)
        update bm.trucks t set acceptance_override = 'REJECTED',
               override_reason = 'Rejected under the Lot-3 rule (moisture ' || coalesce((select l.moisture_pct::text from bm.lab1_results l where l.sample1_barcode_id = t.sample1_barcode_id), '?') || ' %) before the vendor was converted to Lot 4'
         where t.truck_id = any(v_ids) and t.bottom_of is null and t.cancel_status is null and t.acceptance_override is null
           and v_target = 'LOT4' and bm.accept((select l.moisture_pct from bm.lab1_results l where l.sample1_barcode_id = t.sample1_barcode_id), 'LOT2/3') = 'REJECTED';
        update bm.mixing_groups g set lot = v_target
         where g.lot = any(v_src) and ((bm.norm_vendor(g.company_name) = bm.norm_vendor(c4.name) and (v_from is null or g.entry_date >= v_from) and (v_to is null or g.entry_date <= v_to)
                                      and g.entry_date::text not in (select jsonb_array_elements_text(v_conf)))
                                     or g.company_name in (select 'BOTTOM:' || t.bottom_of from bm.trucks t where t.truck_id = any(v_ids) and t.bottom_of is not null));
        update bm.composite_batches b set lot = v_target
         where b.lot = any(v_src) and bm.norm_vendor(b.company_name) = bm.norm_vendor(c4.name) and (v_from is null or b.date >= v_from) and (v_to is null or b.date <= v_to);
        update bm.trucks t set lot = v_target, po_number = case when v_switch then c4.po_number else t.po_number end where t.truck_id = any(v_ids);
        update bm.trucks x set acceptance_status = bm.truck_status(x, (select l.moisture_pct from bm.lab1_results l where l.sample1_barcode_id = x.sample1_barcode_id)) where x.truck_id = any(v_ids);
        perform bm.super_log('LOT_CONVERTED', format('%s: %s truck(s) + %s bottom sample(s) in %s mixing group(s) and %s composite(s) (%s still to be tested, %s already tested) converted to ' || v_target || ' in place (%s to %s)%s%s. Reason: %s',
            c4.name, v_tr, v_bt, v_grp, v_cu + v_ct, v_cu, v_ct, coalesce(v_from::text, 'first'), coalesce(v_to::text, 'last'),
            case when v_rej > 0 then '; ' || v_rej || ' rejected truck(s) kept rejected' else '' end
            || case when jsonb_array_length(v_conf) > 0 then '; both mixing codes kept on ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_conf) x) else '' end, case when v_switch then '; PO switched to ' || coalesce(c4.po_number, 'none') else '; PO of the trucks kept' end, v_reason));
    end if;
    return jsonb_build_object('success', true, 'dry_run', v_dry, 'company_name', c4.name, 'trucks', v_tr, 'bottom_samples', v_bt, 'groups', v_grp,
                              'composites_to_test', v_cu, 'composites_tested', v_ct, 'kept_rejected', v_rej, 'lot4_po', c4.po_number, 'both_codes_days', v_conf, 'target_lot', v_target);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_device_activity(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_n int := least(coalesce(nullif(p->>'limit', '')::int, 200), 1000); d bm.trusted_devices; v_who text;
begin
    perform bm.require_super();
    select * into d from bm.trusted_devices where id = v_id;
    if not found then raise exception 'That computer is not in the list'; end if;
    select username into v_who from bm.profiles where id = d.user_id;
    return jsonb_build_object('name', d.name, 'username', v_who,
        'total', (select count(*) from bm.activity_logs a where a.device_id = v_id),
        'rows', coalesce((select jsonb_agg(jsonb_build_object('timestamp', x.timestamp, 'username', x.username, 'action', x.action, 'details', x.details, 'ip', x.ip, 'ip_label', bm.ip_label(x.ip)) order by x.id desc)
                            from (select * from bm.activity_logs a where a.device_id = v_id order by a.id desc limit v_n) x), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_device_decide(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_act text := upper(coalesce(p->>'action', '')); v_reason text; d bm.trusted_devices; v_who text;
        v_name text := nullif(btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')), '');
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_act not in ('APPROVE', 'REVOKE', 'REMOVE', 'RENAME') then raise exception 'Choose approve, revoke, remove or rename'; end if;
    select * into d from bm.trusted_devices where id = v_id;
    if not found then raise exception 'That computer is not in the list'; end if;
    select username into v_who from bm.profiles where id = d.user_id;
    if v_name is not null and (length(v_name) < 2 or length(v_name) > 60 or not bm.is_safe_text(v_name)) then raise exception 'Give the computer a name of 2 to 60 characters'; end if;
    if v_act = 'RENAME' and v_name is null then raise exception 'Type the new name of the computer'; end if;
    if v_act = 'APPROVE' then
        update bm.trusted_devices set status = 'TRUSTED', approved_by = bm.uname(), approved_at = now(), name = coalesce(v_name, name) where id = v_id;
    elsif v_act = 'RENAME' then
        update bm.trusted_devices set name = v_name where id = v_id;      -- the log shows the CURRENT name of the computer, also on older lines
    else
        if d.user_id = auth.uid() and d.token_hash = bm.token_hash(p->>'token') then raise exception 'You cannot revoke the device you are using right now'; end if;
        if d.status = 'TRUSTED' and coalesce(bm.device_lock_on(d.user_id), false)
           and (select count(*) from bm.trusted_devices x where x.user_id = d.user_id and x.status = 'TRUSTED') <= 1 then
            raise exception 'That is the last approved computer of the login % and its lock is ON. Approve another computer first, or switch its lock off.', v_who;
        end if;
        delete from bm.verified_sessions where device_id = v_id;
        if v_act = 'REVOKE' then update bm.trusted_devices set status = 'REVOKED' where id = v_id; else delete from bm.trusted_devices where id = v_id; end if;
    end if;
    perform bm.super_log('DEVICE_' || v_act, case when v_act = 'RENAME' then format('Computer "%s" of login %s renamed to "%s". Reason: %s', d.name, v_who, v_name, v_reason)
                                                   else format('Computer "%s" of login %s: %s. Reason: %s', d.name, v_who, lower(v_act), v_reason) end);
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_device_list(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_h text := bm.token_hash(p->>'token'); v_super_lock boolean := coalesce((select value from bm.settings where key = 'super_lock'), 'off') = 'on';
begin
    perform bm.require_super();
    return jsonb_build_object('lock', v_super_lock, 'this_fp', upper(left(v_h, 6)),
        'session_verified', exists (select 1 from bm.verified_sessions v where v.session_id = bm.jwt_claim('session_id') and v.user_id = auth.uid()),
        'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'status', d.status, 'this_device', d.user_id = auth.uid() and d.token_hash = v_h,
                              'username', pr.username, 'login_name', pr.name, 'role', pr.role, 'mine', d.user_id = auth.uid(),
                              'requested_at', to_char(d.requested_at at time zone 'UTC' + interval '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI'),
                              'approved_by', d.approved_by, 'last_seen', to_char(d.last_seen at time zone 'UTC' + interval '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI'),
                              'last_ip', d.last_ip, 'ip_label', bm.ip_label(d.last_ip), 'agent', d.agent, 'fp', upper(left(d.token_hash, 6)), 'site', d.site)
                              order by (d.status = 'PENDING') desc, pr.username, d.id)
                             from bm.trusted_devices d join bm.profiles pr on pr.id = d.user_id), '[]'::jsonb),
        'logins', coalesce((select jsonb_agg(jsonb_build_object('username', x.username, 'name', x.name, 'role', x.role, 'exempt', x.mfa_exempt,
                              'lock', case when x.role = 'superadmin' then v_super_lock else x.device_lock end,
                              'trusted', (select count(*) from bm.trusted_devices d where d.user_id = x.id and d.status = 'TRUSTED'),
                              'pending', (select count(*) from bm.trusted_devices d where d.user_id = x.id and d.status = 'PENDING'))
                              order by (x.role = 'superadmin') desc, x.role, x.username)
                             from bm.profiles x where x.active), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_device_trust(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_tok text := coalesce(p->>'token', ''); v_name text := btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')); v_reason text; v_id bigint; v_sess text := bm.jwt_claim('session_id');
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if length(v_tok) < 32 then raise exception 'This browser has no device code yet'; end if;
    if length(v_name) < 2 or length(v_name) > 60 or not bm.is_safe_text(v_name) then raise exception 'Give the device a name of 2 to 60 characters'; end if;
    insert into bm.trusted_devices(user_id, name, token_hash, status, approved_by, approved_at, last_ip, agent, site, last_seen)
    values (auth.uid(), v_name, bm.token_hash(v_tok), 'TRUSTED', bm.uname(), now(), bm.client_ip(), left(bm.client_device(), 200), nullif(left(btrim(coalesce(p->>'site', '')), 80), ''), now())
    on conflict (user_id, token_hash) do update set status = 'TRUSTED', name = excluded.name, approved_by = excluded.approved_by, approved_at = now(), site = coalesce(excluded.site, bm.trusted_devices.site)
    returning id into v_id;
    if v_sess is not null then
        insert into bm.verified_sessions(session_id, user_id, device_id) values (v_sess, auth.uid(), v_id) on conflict (session_id) do update set device_id = excluded.device_id, verified_at = now();
    end if;
    perform bm.super_log('DEVICE_TRUSTED', format('Device "%s" is now trusted for the Super Admin login. Reason: %s', v_name, v_reason));
    return jsonb_build_object('success', true, 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_edit_truck(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_reason text; t bm.trucks; v_reg text; v_drv text; v_inv text; v_comp text; v_lot text; v_date date; c bm.companies; v_group text; v_regroup boolean := false; v_before text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and bottom_of is null for update;
    if not found then raise exception 'Truck not found'; end if;
    v_reg := coalesce(nullif(btrim(coalesce(p->>'truck_reg_number', '')), ''), t.truck_reg_number);
    v_drv := coalesce(nullif(btrim(coalesce(p->>'driver_name', '')), ''), t.driver_name);
    v_inv := coalesce(nullif(btrim(coalesce(p->>'invoice_no', '')), ''), t.invoice_no);
    v_comp := coalesce(nullif(btrim(regexp_replace(coalesce(p->>'company_name', ''), '\s+', ' ', 'g')), ''), t.company_name);
    v_lot := coalesce(nullif(btrim(coalesce(p->>'lot', '')), ''), t.lot);
    v_date := coalesce(nullif(p->>'entry_date', '')::date, t.entry_date);
    if not (bm.is_safe_text(v_reg) and bm.is_safe_text(coalesce(v_drv, '')) and bm.is_safe_text(coalesce(v_inv, '')) and bm.is_safe_text(v_comp)) then
        raise exception 'The text contains characters that are not allowed'; end if;
    if length(v_reg) > 50 or length(coalesce(v_drv, '')) > 200 or length(coalesce(v_inv, '')) > 100 then raise exception 'One of the fields is too long'; end if;
    v_before := format('vehicle %s, driver %s, invoice %s, vendor %s (%s, PO %s), group %s, date %s', t.truck_reg_number, coalesce(t.driver_name, '-'), coalesce(t.invoice_no, '-'),
                       t.company_name, t.lot, coalesce(t.po_number, '-'), t.daily_group_code, t.entry_date);
    if v_comp is distinct from t.company_name or v_lot is distinct from t.lot or v_date is distinct from t.entry_date then
        v_regroup := true;
        select * into c from bm.companies where lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))) = lower(v_comp) and lot = v_lot and (active or coalesce(p->>'allow_retired', '') = 'true');
        if not found then raise exception 'There is no vendor "%" under %. Choose a vendor from the list.', v_comp, v_lot; end if;
        if exists (select 1 from bm.composite_batches b where b.parent_truck_ids ? t.truck_id) or exists (select 1 from bm.composite_batches b where b.date = t.entry_date and b.daily_group_code = t.daily_group_code) then
            raise exception 'The composite of the truck''s present mixing group exists. Void that composite first (Super Admin > Tools).'; end if;
        if exists (select 1 from bm.trucks b where b.bottom_of = t.truck_id and b.cancel_status is null) then
            raise exception 'A bottom sample exists for this truck. Undo it first (Super Admin > Tools).'; end if;
        v_group := bm.group_for(c.name, v_date, c.lot);
        if exists (select 1 from bm.composite_batches b where b.date = v_date and b.daily_group_code = v_group) then
            raise exception 'The composite of the target mixing group (% on %) already exists. Void it first.', v_group, v_date; end if;
        update bm.trucks set company_name = c.name, lot = c.lot, po_number = c.po_number, entry_date = v_date, daily_group_code = v_group where truck_id = t.truck_id;
        -- the lot decides the moisture rule: re-evaluate the stored status (LOT4 -> never rejected for moisture; LOT2/3 -> 14 % limit)
        update bm.trucks x set acceptance_status = bm.truck_status(x, (select l.moisture_pct from bm.lab1_results l where l.sample1_barcode_id = x.sample1_barcode_id)) where x.truck_id = t.truck_id;
        delete from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;        -- the container must be scanned again for its new group
    end if;
    update bm.trucks set truck_reg_number = v_reg, driver_name = v_drv, invoice_no = v_inv where truck_id = t.truck_id;
    perform bm.super_log('TRUCK_EDIT', format('Truck %s: [%s] -> [vehicle %s, driver %s, invoice %s%s]. Reason: %s', t.truck_id, v_before, v_reg, coalesce(v_drv, '-'), coalesce(v_inv, '-'),
        case when v_regroup then format(', vendor %s (%s)%s, NEW mixing group %s, date %s', c.name, c.lot, case when not c.active then ' [RETIRED vendor entry chosen]' else '' end, v_group, v_date) else '' end, v_reason));
    return jsonb_build_object('success', true, 'regrouped', v_regroup, 'daily_group_code', coalesce(v_group, t.daily_group_code));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_edit_weighment(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; t bm.trucks; m numeric; g numeric; tr numeric; net numeric; v_rej boolean;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    select * into t from bm.trucks where truck_id = btrim(coalesce(p->>'truck_id', '')) and bottom_of is null for update;
    if not found then raise exception 'Truck not found'; end if;
    g := coalesce(nullif(btrim(coalesce(p->>'gross', '')), '')::numeric, t.gross_weight);
    tr := coalesce(nullif(btrim(coalesce(p->>'tare', '')), '')::numeric, t.tare_weight);
    if g < 0 or tr < 0 or g > 200000 or tr > 200000 then raise exception 'Weight is out of the allowed range (0 to 200000 kg)'; end if;
    select moisture_pct into m from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    v_rej := bm.truck_status(t, m) in ('REJECTED', 'CANCELLED');
    if v_rej then
        tr := g; net := 0;
    else
        if tr > 0 and g = 0 then raise exception 'A final weight needs a gross weight'; end if;
        if g > 0 and tr > 0 and tr >= g then raise exception 'The final (tare) weight (% kg) must be smaller than the gross weight (% kg)', tr, g; end if;
        net := case when g > 0 and tr > 0 then g - tr else 0 end;
    end if;
    update bm.trucks set gross_weight = g, tare_weight = tr, net_weight = net, tare_auto = (v_rej and g > 0) where truck_id = t.truck_id;
    perform bm.super_log('WEIGHT_EDIT', format('Truck %s (%s): gross %s -> %s kg, final %s -> %s kg, net %s -> %s kg%s. Reason: %s', t.truck_id, t.truck_reg_number,
        t.gross_weight, g, t.tare_weight, tr, t.net_weight, net, case when v_rej then ' (rejected truck: final weight = gross weight)' else '' end, v_reason));
    return jsonb_build_object('success', true, 'gross_weight', g, 'tare_weight', tr, 'net_weight', net, 'rejected', v_rej);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_feed_composite(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_code text := btrim(coalesce(p->>'code', '')); v_reason text := btrim(coalesce(p->>'reason', ''));
    b bm.composite_batches; res jsonb; v_before text;
begin
    perform bm.require_super();
    if length(v_reason) < 5 or length(v_reason) > 300 or not bm.is_safe_text(v_reason) then
        raise exception 'A reason of 5 to 300 characters is required for every Super Admin change'; end if;
    select * into b from bm.composite_batches where upper(composite_ref_id) = upper(v_code) or upper(composite_barcode_id) = upper(v_code) or upper(test_lot) = upper(v_code);
    if not found then raise exception 'Composite not found'; end if;
    v_before := format('AD moisture %s, GCV %s, ash %s, sulphur %s, VM %s => ARB GCV %s, ash %s, sulphur %s, VM %s', coalesce(b.ad_moisture::text, '-'), coalesce(b.ad_gcv::text, '-'),
                       coalesce(b.ad_ash::text, '-'), coalesce(b.ad_sulphur::text, '-'), coalesce(b.ad_vm::text, '-'), coalesce(b.gcv_value::text, '-'), coalesce(b.ash_pct::text, '-'),
                       coalesce(b.arb_sulphur::text, '-'), coalesce(b.arb_vm::text, '-'));
    res := public.bm_submit_composite_result((p - 'reason' - 'code') || jsonb_build_object('code', b.composite_barcode_id, 'override_reason', v_reason));
    perform bm.super_log('COMPOSITE_EDIT', format('Composite %s: [%s] -> [AD moisture %s, GCV %s, ash %s, sulphur %s, VM %s => ARB GCV %s, ash %s, sulphur %s, VM %s; TM %s, X %s]. Reason: %s',
        b.composite_ref_id, v_before, p->>'ad_moisture', p->>'ad_gcv', p->>'ad_ash', coalesce(p->>'ad_sulphur', '-'), coalesce(p->>'ad_vm', '-'),
        res->>'arb_gcv', res->>'arb_ash', coalesce(res->>'arb_sulphur', '-'), coalesce(res->>'arb_vm', '-'), round((res->>'tm')::numeric, 3), round((res->>'x')::numeric, 6), v_reason));
    return res;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_feed_lab1(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_bar text := btrim(coalesce(p->>'barcode', '')); v_tid text := btrim(coalesce(p->>'truck_id', ''));
    v_m numeric := nullif(p->>'moisture', '')::numeric; v_f numeric := nullif(p->>'fineness_value', '')::numeric;
    v_iw numeric := nullif(p->>'fineness_initial_weight', '')::numeric; v_fw numeric := nullif(p->>'fineness_final_weight', '')::numeric;
    v_reason text := btrim(coalesce(p->>'reason', ''));
    t bm.trucks; l bm.lab1_results; l2 bm.lab1_results; ts text := bm.ist_now(); v_before text; v_fin numeric;
begin
    perform bm.require_super();
    if length(v_reason) < 5 or length(v_reason) > 300 or not bm.is_safe_text(v_reason) then
        raise exception 'A reason of 5 to 300 characters is required for every Super Admin change'; end if;
    select * into t from bm.trucks where sample1_barcode_id = v_bar;
    if not found and v_tid <> '' then select * into t from bm.trucks where truck_id = v_tid; end if;
    if not found then raise exception 'Sample not found'; end if;
    if v_m is null and v_f is null and v_iw is null and v_fw is null then raise exception 'Nothing to change'; end if;
    if v_m is not null and (v_m <= 0 or v_m >= 100) then raise exception 'Moisture must be above 0 and below 100 %%'; end if;
    if v_f is not null and (v_f < 0 or v_f > 100) then raise exception 'Fineness must be between 0 and 100 %%'; end if;
    if (v_iw is not null or v_fw is not null) then
        if v_iw is null or v_fw is null then raise exception 'Both the initial and the final weight are needed'; end if;
        if v_iw <= 0 or v_fw < 0 or v_fw > v_iw then raise exception 'Invalid fineness weights (final cannot exceed initial)'; end if;
    end if;

    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    v_before := format('moisture %s, fineness %s (initial %s / final %s)', coalesce(l.moisture_pct::text, 'none'), coalesce(l.fineness_value::text, 'none'),
                       coalesce(l.fineness_initial_weight::text, '-'), coalesce(l.fineness_final_weight::text, '-'));
    if v_m is not null and l.moisture_pct is not null and round(v_m, 3) is distinct from l.moisture_pct then perform bm.guard_status_flip(t.truck_id, l.moisture_pct, round(v_m, 3)); end if;
    perform set_config('bm.allow_override', 'on', true);
    insert into bm.lab1_results(sample1_barcode_id) values (t.sample1_barcode_id) on conflict do nothing;
    if v_m is not null then
        update bm.lab1_results set moisture_pct = round(v_m, 3), moisture_by = bm.uname(), moisture_at = ts, tested_by = bm.uname(), tested_at = ts
         where sample1_barcode_id = t.sample1_barcode_id;
    end if;
    if v_iw is not null then
        v_fin := round(v_fw / v_iw * 100, 2);
        update bm.lab1_results set fineness_initial_weight = v_iw, fineness_final_weight = v_fw, fineness_value = v_fin,
               fineness_by = bm.uname(), fineness_at = ts, tested_by = bm.uname(), tested_at = ts where sample1_barcode_id = t.sample1_barcode_id;
    elsif v_f is not null then
        update bm.lab1_results set fineness_value = round(v_f, 2), fineness_initial_weight = null, fineness_final_weight = null,
               fineness_by = bm.uname(), fineness_at = ts, tested_by = bm.uname(), tested_at = ts where sample1_barcode_id = t.sample1_barcode_id;
    end if;
    select * into l2 from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    update bm.trucks set acceptance_status = bm.truck_status(t, l2.moisture_pct) where sample1_barcode_id = t.sample1_barcode_id;
    if v_m is not null and l.moisture_pct is distinct from l2.moisture_pct then
        perform bm.recompute_for_truck(t.truck_id, format('moisture of truck %s set by the Super Admin', t.truck_id));
    end if;
    perform bm.super_log('LAB1_EDIT', format('Truck %s (%s), sample %s: [%s] -> [moisture %s, fineness %s (initial %s / final %s)]. Reason: %s',
        t.truck_id, t.truck_reg_number, t.sample1_barcode_id, v_before, l2.moisture_pct, l2.fineness_value,
        coalesce(l2.fineness_initial_weight::text, '-'), coalesce(l2.fineness_final_weight::text, '-'), v_reason));
    return jsonb_build_object('success', true, 'moisture_pct', l2.moisture_pct, 'fineness_value', l2.fineness_value, 'acceptance_status', bm.truck_status(t, l2.moisture_pct));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_find(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_q text := btrim(coalesce(p->>'q', '')); v_nq text := bm.norm_reg(coalesce(p->>'q', ''));
    v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date;
    v_n int := least(coalesce(nullif(p->>'limit', '')::int, 200), 500);
    v_s jsonb; v_c jsonb;
begin
    perform bm.require_super();
    select coalesce(jsonb_agg(x.j order by x.d desc, x.tm desc), '[]'::jsonb) into v_s from (
        select t.entry_date as d, t.entry_time as tm, jsonb_build_object(
                   'kind', case when t.bottom_of is not null then 'BOTTOM_SAMPLE' else 'TRUCK_SAMPLE' end,
                   'entry_date', t.entry_date, 'entry_time', t.entry_time, 'company_name', t.company_name, 'lot', t.lot, 'po_number', t.po_number,
                   'truck_reg_number', t.truck_reg_number, 'truck_id', coalesce(t.bottom_of, t.truck_id), 'mixing_code', t.daily_group_code,
                   'sample1_barcode_id', t.sample1_barcode_id, 'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value,
                   'fineness_initial_weight', l.fineness_initial_weight, 'fineness_final_weight', l.fineness_final_weight,
                   'acceptance_status', bm.truck_status(t, l.moisture_pct), 'excluded_from_mix', t.excluded_from_mix,
                   'cancel_status', t.cancel_status, 'cancel_reason', t.cancel_reason, 'acceptance_override', t.acceptance_override,
                   'old_codes', (select coalesce(jsonb_agg(h.old_barcode order by h.id), '[]'::jsonb) from bm.qr_history h where h.truck_id = t.truck_id)) as j
          from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
         where (v_from is null or t.entry_date >= v_from) and (v_to is null or t.entry_date <= v_to)
           and (v_q = '' or upper(t.daily_group_code) = upper(v_q) or upper(t.sample1_barcode_id) = upper(v_q) or upper(t.truck_id) like '%' || upper(v_q) || '%'
                or t.company_name ilike '%' || v_q || '%' or coalesce(t.po_number, '') = v_q
                or t.truck_id in (select h.truck_id from bm.qr_history h where upper(h.old_barcode) = upper(v_q))
                or (length(v_nq) >= 3 and bm.norm_reg(t.truck_reg_number) like '%' || v_nq || '%'))
         order by t.entry_date desc, t.entry_time desc limit v_n) x;
    select coalesce(jsonb_agg(x.j order by x.d desc, x.ref desc), '[]'::jsonb) into v_c from (
        select b.date as d, b.composite_ref_id as ref, jsonb_build_object(
                   'composite_ref_id', b.composite_ref_id, 'date', b.date, 'company_name', b.company_name, 'lot', b.lot, 'mixing_code', b.daily_group_code,
                   'test_lot', b.test_lot, 'referee_lot', b.referee_lot, 'vendor_lot', b.vendor_lot, 'vendor_initials', bm.company_initials(b.company_name),
                   'truck_count', jsonb_array_length(b.parent_truck_ids),
                   'ad_moisture', b.ad_moisture, 'ad_gcv', b.ad_gcv, 'ad_ash', b.ad_ash, 'ad_sulphur', b.ad_sulphur, 'ad_vm', b.ad_vm,
                   'tm_value', b.tm_value, 'x_factor', b.x_factor, 'arb_gcv', b.gcv_value, 'arb_ash', b.ash_pct, 'arb_sulphur', b.arb_sulphur, 'arb_vm', b.arb_vm,
                   'tested_at', b.tested_at) as j
          from bm.composite_batches b
         where (v_from is null or b.date >= v_from) and (v_to is null or b.date <= v_to)
           and (v_q = '' or upper(b.daily_group_code) = upper(v_q) or upper(b.composite_ref_id) = upper(v_q) or upper(b.composite_barcode_id) = upper(v_q)
                or upper(b.test_lot) = upper(v_q) or upper(b.referee_lot) = upper(v_q) or upper(b.vendor_lot) = upper(v_q) or b.company_name ilike '%' || v_q || '%'
                or (length(v_nq) >= 3 and exists (select 1 from bm.trucks t2 where t2.truck_id in (select jsonb_array_elements_text(b.parent_truck_ids))
                                                     and bm.norm_reg(t2.truck_reg_number) like '%' || v_nq || '%')))
         order by b.date desc, b.composite_ref_id desc limit v_n) x;
    return jsonb_build_object('success', true, 'samples', v_s, 'composites', v_c);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_force_composite(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_reason text; res jsonb; v_missing int;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    res := public.bm_lab2_create_composite((p - 'reason') || jsonb_build_object('_force', 'true'));
    perform bm.super_log('COMPOSITE_FORCED', format('Composite %s created for mixing code %s on %s without the complete fineness scan. Reason: %s',
        res->'batch'->>'composite_ref_id', upper(p->>'group_code'), coalesce(p->>'date', bm.ist_date()::text), v_reason));
    return res;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_health(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare out jsonb := '[]'::jsonb; x jsonb;
begin
    perform bm.require_super();
    -- a) groups waiting for results for more than a day
    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'code', code, 'detail', format('%s truck(s) still without a moisture result', n)) order by d), '[]'::jsonb) into x from (
        select t.entry_date d, t.daily_group_code code, count(*) n from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
         where t.entry_date < bm.ist_date() and bm.mix_status(t, l.moisture_pct) = 'PENDING' and t.cancel_status is null
           and not exists (select 1 from bm.composite_batches c where c.date = t.entry_date and c.daily_group_code = t.daily_group_code)
         group by 1, 2) q;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'PENDING_BLOCKS_COMPOSITE', 'severity', 'WARN', 'title', 'Mixing groups waiting for moisture results (older than today)',
        'help', 'These groups cannot get a composite until every truck has a moisture result. Feed the result, or cancel the truck''s QR if it was turned away.', 'items', x)); end if;
    -- b) composites that cannot be calculated / are not tested
    select coalesce(jsonb_agg(jsonb_build_object('date', c.date, 'code', c.daily_group_code, 'detail', c.composite_ref_id || case when bm.composite_tm(c) is null then ' - a truck of this composite has no moisture' else ' - no AD values yet' end) order by c.date), '[]'::jsonb) into x
      from bm.composite_batches c where c.gcv_value is null and (c.date < bm.ist_date() - 1 or bm.composite_tm(c) is null);
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'COMPOSITE_NOT_TESTED', 'severity', 'WARN', 'title', 'Composites without results for more than a day (or with a missing moisture)',
        'help', 'Feed the AD values in the Inspector, or feed the missing moisture first.', 'items', x)); end if;
    -- c) mixing scans that belong to nothing
    select coalesce(jsonb_agg(jsonb_build_object('date', m.entry_date, 'code', m.group_code, 'detail', 'scan of ' || m.sample1_barcode_id) order by m.entry_date), '[]'::jsonb) into x
      from bm.mixing_scans m join bm.trucks t on t.sample1_barcode_id = m.sample1_barcode_id
     where t.cancel_status is not null or t.entry_date <> m.entry_date or t.daily_group_code <> m.group_code;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'ORPHAN_SCANS', 'severity', 'INFO', 'title', 'Mixing scans of cancelled / moved samples', 'fix', 'DROP_ORPHAN_SCANS',
        'help', 'Harmless leftovers. "Fix" removes them.', 'items', x)); end if;
    -- d) trucks pointing to a composite that no longer exists
    select coalesce(jsonb_agg(jsonb_build_object('date', t.entry_date, 'code', t.daily_group_code, 'detail', t.truck_reg_number || ' -> ' || t.composite_barcode_id) order by t.entry_date), '[]'::jsonb) into x
      from bm.trucks t where t.composite_barcode_id is not null and not exists (select 1 from bm.composite_batches c where c.composite_barcode_id = t.composite_barcode_id);
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'BROKEN_COMPOSITE_LINK', 'severity', 'WARN', 'title', 'Trucks linked to a composite that does not exist', 'fix', 'CLEAR_BROKEN_LINKS',
        'help', '"Fix" clears the broken link so the truck can be mixed again.', 'items', x)); end if;
    -- e) same vehicle registered twice the same day, still open
    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'code', null, 'detail', reg || ' registered ' || n || ' times') order by d), '[]'::jsonb) into x from (
        select t.entry_date d, max(t.truck_reg_number) reg, count(*) n from bm.trucks t where t.bottom_of is null and t.cancel_status is null and t.entry_date >= bm.ist_date() - 7
         group by t.entry_date, bm.norm_reg(t.truck_reg_number) having count(*) > 1) q;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_VEHICLE', 'severity', 'INFO', 'title', 'Same vehicle registered more than once on a day (last 7 days)',
        'help', 'Often legitimate (two trips). If it was a mistake, void the extra registration in the Inspector.', 'items', x)); end if;
    -- f) trucks that came in but never left
    select coalesce(jsonb_agg(jsonb_build_object('date', t.entry_date, 'code', t.daily_group_code, 'detail', t.truck_reg_number || ' - gross weighed, final weight missing') order by t.entry_date), '[]'::jsonb) into x
      from bm.trucks t where t.bottom_of is null and t.cancel_status is null and t.gross_weight > 0 and t.tare_weight = 0 and t.entry_date < bm.ist_date() - 1;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'OPEN_TRUCK', 'severity', 'WARN', 'title', 'Trucks without a final weight for more than a day',
        'help', 'Record the final weight at the weighment login, or void / cancel the truck.', 'items', x)); end if;
    -- g) old trucks without any moisture
    select coalesce(jsonb_agg(jsonb_build_object('date', t.entry_date, 'code', t.daily_group_code, 'detail', t.truck_reg_number) order by t.entry_date), '[]'::jsonb) into x
      from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
     where t.bottom_of is null and t.cancel_status is null and l.moisture_pct is null and t.entry_date < bm.ist_date() - 1;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'NO_MOISTURE', 'severity', 'WARN', 'title', 'Trucks older than a day without a moisture result',
        'help', 'Feed the moisture in the Inspector, or cancel the QR if the truck was turned away.', 'items', x)); end if;
    -- h) stale bottom-sample requests
    select coalesce(jsonb_agg(jsonb_build_object('date', r.requested_date, 'code', null, 'detail', t.truck_reg_number || ' requested ' || r.requested_time) order by r.requested_date), '[]'::jsonb) into x
      from bm.bottom_requests r join bm.trucks t on t.truck_id = r.truck_id where r.status = 'REQUESTED' and r.requested_date < bm.ist_date();
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'STALE_BOTTOM_REQUEST', 'severity', 'INFO', 'title', 'Bottom-sample requests waiting for more than a day',
        'help', 'Ask Entry to generate them, or cancel the request (Super Admin > Tools).', 'items', x)); end if;
    -- i) composites that contain cancelled / voided trucks
    select coalesce(jsonb_agg(jsonb_build_object('date', c.date, 'code', c.daily_group_code, 'detail', c.composite_ref_id || ' contains ' || t.truck_reg_number) order by c.date), '[]'::jsonb) into x
      from bm.composite_batches c join bm.trucks t on c.parent_truck_ids ? t.truck_id where t.cancel_status is not null;
    if jsonb_array_length(x) > 0 then out := out || jsonb_build_array(jsonb_build_object('code', 'COMPOSITE_HAS_CANCELLED', 'severity', 'WARN', 'title', 'Composites that contain a cancelled / voided truck',
        'help', 'Void the composite, restore or leave out the truck, and create it again.', 'items', x)); end if;
    return jsonb_build_object('success', true, 'issues', out, 'checked_at', bm.ist_now());
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_health_fix(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_fix text := upper(btrim(coalesce(p->>'fix', ''))); n int; v_reason text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if v_fix = 'DROP_ORPHAN_SCANS' then
        delete from bm.mixing_scans m using bm.trucks t where t.sample1_barcode_id = m.sample1_barcode_id and (t.cancel_status is not null or t.entry_date <> m.entry_date or t.daily_group_code <> m.group_code);
        get diagnostics n = row_count;
    elsif v_fix = 'CLEAR_BROKEN_LINKS' then
        update bm.trucks t set composite_barcode_id = null where t.composite_barcode_id is not null and not exists (select 1 from bm.composite_batches c where c.composite_barcode_id = t.composite_barcode_id);
        get diagnostics n = row_count;
    else raise exception 'Unknown fix'; end if;
    perform bm.super_log('HEALTH_FIX', format('%s: %s record(s) fixed. Reason: %s', v_fix, n, v_reason));
    return jsonb_build_object('success', true, 'fixed', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_ip_label(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ip text := btrim(coalesce(p->>'ip', '')); v_l text := nullif(btrim(regexp_replace(coalesce(p->>'label', ''), '\s+', ' ', 'g')), ''); old text;
begin
    perform bm.require_super();
    if not exists (select 1 from bm.known_ips where ip = v_ip) then raise exception 'This IP address is not in the list'; end if;
    if v_l is not null and (length(v_l) < 2 or length(v_l) > 60 or not bm.is_safe_text(v_l)) then raise exception 'The name must be 2 to 60 characters, without special characters'; end if;
    select label into old from bm.known_ips where ip = v_ip;
    update bm.known_ips set label = v_l, labelled_by = bm.uname(), labelled_at = now() where ip = v_ip;
    perform bm.super_log('IP_LABELLED', format('IP address %s: name %s -> %s', v_ip, coalesce('"' || old || '"', 'unknown'), coalesce('"' || v_l || '"', 'unknown (name removed)')));
    return jsonb_build_object('success', true);
end $function$
;

set check_function_bodies = on;
