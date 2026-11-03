-- =====================================================================================================
--  Migration 2026-11-04:
--    (a) a vendor can be switched between Lot 4 and Lot 4A in Admin > Vendors even when it has trucks (its trucks, mixing codes and
--        composites move along; QR codes and results are not touched)
--    (b) NEW "Admin edit password": the Admin must type it (set by the Super Admin) for every correction of a lab value in the
--        Barcode Inspector; every correction is written to the Admin AND the Super Admin audit log (old -> new value)
--    (c) the Super Admin can VIEW the Unloading actions password and the Admin edit password (login password + authenticator code needed)
--
--  Run ONCE in Supabase > SQL Editor, AFTER db/migrations/2026-11-03_lot4a.sql. One transaction: if anything fails, nothing changes.
--  Afterwards: Super Admin > Passwords > set the Admin edit password, and set the Unloading actions password once more
--  (the old one is stored only as a one-way scramble and cannot be shown until it is typed again).
-- =====================================================================================================
begin;
set local check_function_bodies = off;

do $$
begin
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'bm' and p.proname = 'is_lot4') then
        raise exception 'Run db/migrations/2026-11-03_lot4a.sql first (the Lot 4A migration is missing).';
    end if;
end $$;

CREATE OR REPLACE FUNCTION bm.is_exception_log(p_action text, p_details text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select lower(coalesce(p_action, '')) like '%exception%' or lower(coalesce(p_action, '')) like '%reissue%' or lower(coalesce(p_action, '')) like '%lockout%'
          or coalesce(p_action, '') like 'SUPERADMIN%' or coalesce(p_action, '') in ('BOTTOM_PASSWORD_WRONG', 'QR_CANCELLED', 'ADMIN_EDIT_PASSWORD_WRONG')
          or lower(coalesce(p_details, '')) like '%fail%' or lower(coalesce(p_details, '')) like '%expired%' or lower(coalesce(p_details, '')) like '%tampered%' $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_vendor_apply(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_dry boolean := coalesce(p->>'dry_run', '') = 'true';
    r jsonb; i int := 0; res jsonb := '[]'::jsonb; v_err int := 0;
    v_vid bigint; v_name text; v_lot text; v_po text; v_has_po boolean; v_act boolean; v_rm boolean; v_canon text;
    v_new_name text; v_new_lot text; v_new_po text; v_new_act boolean; v_n int; c bm.companies; act text; msg text; v_cnt jsonb := '{}'::jsonb;
begin
    perform bm.require(array['admin']);
    if jsonb_typeof(p->'rows') is distinct from 'array' then raise exception 'rows must be a list'; end if;
    if jsonb_array_length(p->'rows') = 0 then raise exception 'There is nothing to apply'; end if;
    if jsonb_array_length(p->'rows') > 3000 then raise exception 'Too many rows in one go (maximum 3000)'; end if;
    begin
        for r in select value from jsonb_array_elements(p->'rows') loop
            i := i + 1; act := null; msg := null; v_vid := null; v_name := null; v_lot := null; c := null;
            begin
                v_vid := nullif(btrim(coalesce(r->>'id', '')), '')::bigint;
                v_name := btrim(regexp_replace(coalesce(r->>'name', ''), '\s+', ' ', 'g'));
                if nullif(btrim(coalesce(r->>'lot', '')), '') is not null then
                    v_lot := bm.norm_lot(r->>'lot');
                    if v_lot is null then raise exception 'The lot must be LOT2, LOT3, LOT4 or LOT4A (found "%")', r->>'lot'; end if;
                end if;
                v_has_po := r ? 'po_number';
                v_po := nullif(btrim(coalesce(r->>'po_number', '')), '');
                if v_po is not null and (length(v_po) > 40 or not bm.is_safe_text(v_po)) then raise exception 'The PO number is too long or has characters that are not allowed'; end if;
                if v_name <> '' and (length(v_name) > 200 or not bm.is_safe_text(v_name)) then raise exception 'The vendor name is too long or has characters that are not allowed'; end if;
                v_act := case when nullif(btrim(coalesce(r->>'active', '')), '') is null then null else (r->>'active')::boolean end;
                v_rm := coalesce(r->>'remove', '') in ('true', 't');

                if v_vid is null then                                           -- ---- a new vendor
                    if v_rm then act := 'SKIPPED'; msg := 'Marked for removal but it is not in the database';
                    else
                        if v_name = '' or v_lot is null then raise exception 'A new vendor needs a name and a lot'; end if;
                        select x.name into v_canon from bm.companies x where bm.norm_vendor(x.name) = bm.norm_vendor(v_name) limit 1;
                        if v_canon is not null then v_name := v_canon; end if;     -- the same vendor under the other lot keeps ONE spelling
                        if exists (select 1 from bm.companies x where x.name = v_name and x.lot = v_lot) then raise exception '% already exists under %', v_name, v_lot; end if;
                        insert into bm.companies(name, po_number, lot, active) values (v_name, v_po, v_lot, coalesce(v_act, true));
                        act := 'ADDED'; msg := format('%s (%s)%s', v_name, v_lot, coalesce(', PO ' || v_po, ', no PO'));
                        perform bm.log('VENDOR_ADDED', 'Vendor added: ' || msg);
                    end if;
                else                                                            -- ---- an existing vendor
                    select * into c from bm.companies where vid = v_vid for update;
                    if not found then raise exception 'Vendor id % does not exist (deleted meanwhile?)', v_vid; end if;
                    select count(*) into v_n from bm.trucks t where t.company_name = c.name and t.lot = c.lot;
                    v_name := coalesce(nullif(v_name, ''), c.name);
                    if v_rm then
                        if v_n = 0 then
                            delete from bm.companies where vid = v_vid;
                            act := 'DELETED'; msg := format('%s (%s) removed', c.name, c.lot);
                        else
                            update bm.companies set active = false, retired_at = coalesce(retired_at, now()), retired_by = coalesce(retired_by, bm.uname()) where vid = v_vid;
                            act := 'RETIRED'; msg := format('%s (%s) has %s truck(s): kept for the history, hidden from gate entry', c.name, c.lot, v_n);
                        end if;
                        perform bm.log('VENDOR_' || act, 'Vendor ' || msg);
                    else
                        v_new_name := v_name; v_new_lot := coalesce(v_lot, c.lot); v_new_act := coalesce(v_act, c.active);
                        v_new_po := case when v_has_po then v_po else c.po_number end;
                        if v_new_name = c.name and v_new_lot = c.lot and v_new_po is not distinct from c.po_number and v_new_act = c.active then
                            act := 'UNCHANGED'; msg := format('%s (%s)', c.name, c.lot);
                        else
                            if v_new_lot <> c.lot and v_n > 0 and not (c.lot = 'LOT2/3' and v_new_lot in ('LOT2', 'LOT3')) and not (bm.is_lot4(c.lot) and bm.is_lot4(v_new_lot)) then
                                raise exception '% has % truck(s), so its lot cannot be changed. Add it under % and retire this entry instead', c.name, v_n, v_new_lot; end if;
                            if (v_new_name <> c.name or v_new_lot <> c.lot)
                               and exists (select 1 from bm.companies x where x.vid <> v_vid and x.lot = v_new_lot and bm.norm_vendor(x.name) = bm.norm_vendor(v_new_name)) then
                                raise exception '% already exists under %', v_new_name, v_new_lot; end if;
                            if v_new_name <> c.name and v_n > 0 then            -- the name follows into the vendor's trucks, composites and mixing groups
                                update bm.trucks set company_name = v_new_name where company_name = c.name and lot = c.lot;
                                update bm.composite_batches set company_name = v_new_name where company_name = c.name and lot = c.lot;
                                update bm.mixing_groups set company_name = v_new_name where company_name = c.name and lot = c.lot;
                            end if;
                            if v_new_lot <> c.lot and v_n > 0 then              -- LOT2/3 -> LOT2 / LOT3, or LOT4 <-> LOT4A: all the history of the vendor takes the new lot (same rules, nothing is re-evaluated)
                                update bm.trucks set lot = v_new_lot where company_name = v_new_name and lot = c.lot;
                                update bm.composite_batches set lot = v_new_lot where company_name = v_new_name and lot = c.lot;
                                update bm.mixing_groups set lot = v_new_lot where company_name = v_new_name and lot = c.lot;
                                update bm.mixing_groups g set lot = v_new_lot where g.lot = c.lot
                                   and g.company_name in (select 'BOTTOM:' || x.truck_id from bm.trucks x where x.company_name = v_new_name and x.lot = v_new_lot
                                                          union select 'BOTTOM:' || x.bottom_of from bm.trucks x where x.company_name = v_new_name and x.lot = v_new_lot and x.bottom_of is not null);
                            end if;
                            update bm.companies set name = v_new_name, lot = v_new_lot, po_number = v_new_po, active = v_new_act,
                                   retired_at = case when v_new_act then null else coalesce(retired_at, now()) end,
                                   retired_by = case when v_new_act then null else coalesce(retired_by, bm.uname()) end
                             where vid = v_vid;
                            act := case when v_new_act <> c.active and v_new_name = c.name and v_new_lot = c.lot and v_new_po is not distinct from c.po_number
                                        then case when v_new_act then 'RESTORED' else 'RETIRED' end else 'EDITED' end;
                            msg := format('%s (%s)%s%s%s%s', c.name, c.lot,
                                          case when v_new_name <> c.name then ' -> renamed to ' || v_new_name || case when v_n > 0 then ' (' || v_n || ' truck(s) follow)' else '' end else '' end,
                                          case when v_new_lot <> c.lot then ' -> moved to ' || v_new_lot else '' end,
                                          case when v_new_po is distinct from c.po_number then ', PO ' || coalesce(c.po_number, 'none') || ' -> ' || coalesce(v_new_po, 'none') else '' end,
                                          case when v_new_act <> c.active then case when v_new_act then ', re-activated' else ', retired' end else '' end);
                            perform bm.log('VENDOR_' || act, 'Vendor ' || msg);
                        end if;
                    end if;
                end if;
            exception when others then
                act := 'ERROR'; msg := sqlerrm; v_err := v_err + 1;
            end;
            v_cnt := jsonb_set(v_cnt, array[act], to_jsonb(coalesce((v_cnt->>act)::int, 0) + 1));
            res := res || jsonb_build_array(jsonb_build_object('row', i, 'id', v_vid, 'name', coalesce(v_name, c.name), 'lot', coalesce(v_lot, c.lot), 'action', act, 'message', msg));
        end loop;
        if v_dry or v_err > 0 then raise exception using errcode = 'VD001', message = 'rollback'; end if;
    exception when sqlstate 'VD001' then null;
    end;
    return jsonb_build_object('success', v_err = 0, 'dry_run', v_dry, 'applied', (not v_dry and v_err = 0), 'errors', v_err, 'counts', v_cnt, 'results', res);
end $function$
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

-- ---- password storage, the Admin edit password, viewing ----
-- Action passwords the Super Admin can SEE (recoverable) + the new "Admin edit password".   Run after 01-11.
--
-- * The Unloading actions password and the Admin edit password are still checked through a salted hash (fast, as before).
--   Next to the hash an ENCRYPTED copy is kept (pgcrypto, key in Supabase Vault) so that the Super Admin can reveal it.
--   Revealing needs: the Super Admin login, the login password (checked here), AND an authenticator code typed within the last 2 minutes.
-- * Login passwords are never stored in a readable form and are not part of this.

do $$
begin
    if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto') is distinct from 'extensions' then
        raise exception 'pgcrypto is not installed in the "extensions" schema - stop and tell the developer';
    end if;
    if not exists (select 1 from vault.secrets where name = 'bm_pw_key') then
        perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bm_pw_key', 'Key that keeps the Super-Admin-viewable action passwords encrypted');
    end if;
end $$;

CREATE OR REPLACE FUNCTION bm.pw_key()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare k text;
begin
    select decrypted_secret into k from vault.decrypted_secrets where name = 'bm_pw_key';
    if k is null then raise exception 'The password key is missing'; end if;
    return k;
end $function$
;

CREATE OR REPLACE FUNCTION bm.pw_enc(p text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select encode(extensions.pgp_sym_encrypt(p, bm.pw_key()), 'base64') $function$
;

CREATE OR REPLACE FUNCTION bm.pw_dec(v text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select extensions.pgp_sym_decrypt(decode(v, 'base64'), bm.pw_key()) $function$
;

-- null = the password is right; otherwise the message to show. Wrong tries are counted per login (5 in 10 minutes lock the editing).
CREATE OR REPLACE FUNCTION bm.check_edit_password(p_pw text, p_what text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_key text := 'edit:' || coalesce(bm.uname(), ''); v_fails int; v_salt text; v_hash text;
begin
    select count(*) into v_fails from bm.bottom_pw_fails where username = v_key and at > now() - interval '10 minutes';
    if v_fails >= 5 then return 'Too many wrong passwords. Wait 10 minutes or ask the Super Admin.'; end if;
    select value into v_salt from bm.settings where key = 'admin_edit_pw_salt';
    select value into v_hash from bm.settings where key = 'admin_edit_pw_hash';
    if v_hash is null then return 'The Admin edit password has not been set yet. Ask the Super Admin (Super Admin login > Passwords).'; end if;
    if bm.bottom_pw_hash(v_salt, coalesce(p_pw, '')) <> v_hash then
        insert into bm.bottom_pw_fails(username) values (v_key);
        perform bm.log('ADMIN_EDIT_PASSWORD_WRONG', format('Wrong Admin edit password entered (%s)', left(coalesce(p_what, ''), 120)));
        return 'Wrong password. Nothing was changed.';
    end if;
    return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_set_edit_password(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_pw text := coalesce(p->>'password', ''); v_salt text; v_reason text;
begin
    perform bm.require_super();
    v_reason := bm.super_reason(p);
    if length(v_pw) < 6 then raise exception 'The Admin edit password must have at least 6 characters'; end if;
    if length(v_pw) > 100 then raise exception 'The Admin edit password is too long'; end if;
    v_salt := bm.rand_hex(16);
    insert into bm.settings(key, value) values ('admin_edit_pw_salt', v_salt), ('admin_edit_pw_hash', bm.bottom_pw_hash(v_salt, v_pw)), ('admin_edit_pw_enc', bm.pw_enc(v_pw))
    on conflict (key) do update set value = excluded.value, updated_at = now();
    delete from bm.bottom_pw_fails where username like 'edit:%';                  -- a new password also lifts any lock-out of the Admin edits
    perform bm.super_log('ADMIN_EDIT_PASSWORD_SET', 'Admin edit password (needed to correct lab values in the Barcode Inspector) was set / changed. Reason: ' || v_reason);
    return jsonb_build_object('success', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_super_password_status(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require_super();
    return jsonb_build_object('mfa_ready', bm.is_enrolled(auth.uid()), 'passwords', jsonb_build_array(
        jsonb_build_object('id', 'unloading', 'name', 'Unloading actions password', 'used_for', 'Unloading login: request a bottom sample, cancel a QR, open the day report',
            'is_set', exists (select 1 from bm.settings where key = 'bottom_pw_hash'), 'viewable', exists (select 1 from bm.settings where key = 'bottom_pw_enc'),
            'changed_at', (select updated_at from bm.settings where key = 'bottom_pw_hash')),
        jsonb_build_object('id', 'admin_edit', 'name', 'Admin edit password', 'used_for', 'Admin login > Barcode Inspector: correcting a moisture, fineness, GCV, ash, sulphur or VM value (asked at every save)',
            'is_set', exists (select 1 from bm.settings where key = 'admin_edit_pw_hash'), 'viewable', exists (select 1 from bm.settings where key = 'admin_edit_pw_enc'),
            'changed_at', (select updated_at from bm.settings where key = 'admin_edit_pw_hash'))));
end $function$
;

-- Show a password: Super Admin only + the login password (checked against the real one) + an authenticator code typed in the last 2 minutes.
CREATE OR REPLACE FUNCTION public.bm_super_reveal_password(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_which text := coalesce(p->>'which', ''); v_login text := coalesce(p->>'login_password', ''); v_claims jsonb; v_totp bigint; v_ok boolean; v_enc text; v_name text;
begin
    perform bm.require_super();
    if v_which not in ('unloading', 'admin_edit') then raise exception 'Unknown password'; end if;
    v_name := case v_which when 'unloading' then 'Unloading actions' else 'Admin edit' end;
    if (select count(*) from bm.recovery_fails where uid = auth.uid() and at > now() - interval '15 minutes') >= 5 then
        return jsonb_build_object('success', false, 'message', 'Too many wrong attempts. Wait 15 minutes.'); end if;
    if coalesce(bm.jwt_claim('aal'), 'aal1') <> 'aal2' then
        return jsonb_build_object('success', false, 'message', 'The authenticator code was not accepted. Type the current 6-digit code.'); end if;
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    select max((a->>'timestamp')::bigint) into v_totp from jsonb_array_elements(coalesce(v_claims->'amr', '[]'::jsonb)) a where jsonb_typeof(a) = 'object' and a->>'method' = 'totp';
    if v_totp is null and not exists (select 1 from jsonb_array_elements(coalesce(v_claims->'amr', '[]'::jsonb)) a where jsonb_typeof(a) = 'object') then
        v_totp := nullif(v_claims->>'iat', '')::bigint; end if;
    if v_totp is null or extract(epoch from now()) - v_totp > 120 then
        return jsonb_build_object('success', false, 'message', 'A fresh authenticator code is needed: type the current 6-digit code.'); end if;
    select (extensions.crypt(v_login, u.encrypted_password) = u.encrypted_password) into v_ok from auth.users u where u.id = auth.uid();
    if not coalesce(v_ok, false) then
        insert into bm.recovery_fails(uid) values (auth.uid());
        perform bm.super_log('PASSWORD_REVEAL_FAILED', format('A WRONG login password was typed when trying to view the %s password (IP %s).', v_name, bm.client_ip()));
        return jsonb_build_object('success', false, 'message', 'The login password is not correct.');
    end if;
    select value into v_enc from bm.settings where key = case v_which when 'unloading' then 'bottom_pw_enc' else 'admin_edit_pw_enc' end;
    if v_enc is null then
        return jsonb_build_object('success', false, 'message', 'This password was set before viewing was possible. Set it again once (Set / change) and it can then be shown.'); end if;
    delete from bm.recovery_fails where uid = auth.uid();
    perform bm.super_log('PASSWORD_REVEALED', format('The Super Admin viewed the %s password (login password and authenticator code confirmed).', v_name));
    return jsonb_build_object('success', true, 'password', bm.pw_dec(v_enc));
end $function$
;


-- who may call the new functions (same rule as every public.bm_* function: signed-in users only, never anonymous)
do $$
declare f record;
begin
    for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('bm_super_set_edit_password', 'bm_super_password_status', 'bm_super_reveal_password')
    loop
        execute format('revoke all on function %s from public, anon', f.sig);
        execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end loop;
end $$;

commit;
