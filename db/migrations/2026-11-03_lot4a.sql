-- =====================================================================================================
--  Migration: new lot "LOT4A" (Lot 4A) - same rules as Lot 4 (no moisture rejection, sulphur + VM recorded).
--  Run ONCE in Supabase > SQL Editor of project jarfhyraxjvtimradvbp, BEFORE publishing the new website files.
--  Safe to run twice (CREATE OR REPLACE / drop-if-exists). It runs as one transaction: if anything fails nothing changes.
--  It does not touch any data. Existing Lot 2 / 3 / 4 behaviour is unchanged (Lot 4A is only added).
--  Already done by the website: nothing else to set up. Vendors are moved to Lot 4A afterwards (see the app: Admin > Vendors,
--  and Super Admin > Tools > "Convert a vendor's existing samples" for vendors that already have trucks).
-- =====================================================================================================
begin;
set local check_function_bodies = off;

-- 1. the vendor list may now hold LOT4A
alter table bm.companies drop constraint if exists bm_companies_lot_ck;
alter table bm.companies add constraint bm_companies_lot_ck CHECK ((lot = ANY (ARRAY['LOT2/3'::text, 'LOT2'::text, 'LOT3'::text, 'LOT4'::text, 'LOT4A'::text])));

-- 2. the rules (functions, in the order they depend on each other)
CREATE OR REPLACE FUNCTION bm.is_lot4(p_lot text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(p_lot in ('LOT4', 'LOT4A'), false) $function$
;

CREATE OR REPLACE FUNCTION bm.accept(m numeric, p_lot text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case when m is null then 'PENDING' when bm.is_lot4(p_lot) then 'ACCEPTED' when m >= 14 then 'REJECTED' else 'ACCEPTED' end $function$
;

CREATE OR REPLACE FUNCTION bm.calc_values(b bm.composite_batches, p_adm numeric, p_gcv numeric, p_ash numeric, p_sul numeric, p_vm numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_tm numeric; v_x numeric; v_lot4 boolean := bm.is_lot4(b.lot);
begin
    v_tm := bm.composite_tm(b);
    if v_tm is null then raise exception 'The moisture of every truck in this composite must be recorded before the result can be calculated.'; end if;
    if v_tm >= 100 then raise exception 'Mean moisture (TM) must be below 100 %%'; end if;
    v_x := (100 - v_tm) / (100 - p_adm);
    return jsonb_build_object('tm', v_tm, 'x', v_x, 'arb_gcv', round(p_gcv * v_x, 0), 'arb_ash', round(p_ash * v_x, 2),
                              'arb_sulphur', case when v_lot4 then round(p_sul * v_x, 2) end, 'arb_vm', case when v_lot4 then round(p_vm * v_x, 2) end,
                              'warning', case when p_adm > v_tm then 'AD moisture is higher than TM - please check the value.' end);
end $function$
;

CREATE OR REPLACE FUNCTION bm.norm_lot(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9/]', '', 'g')
                when 'LOT4' then 'LOT4' when 'LOT04' then 'LOT4' when '4' then 'LOT4'
                when 'LOT4A' then 'LOT4A' when 'LOT04A' then 'LOT4A' when '4A' then 'LOT4A'
                when 'LOT3' then 'LOT3' when 'LOT03' then 'LOT3' when '3' then 'LOT3' when '03' then 'LOT3'
                when 'LOT2' then 'LOT2' when 'LOT02' then 'LOT2' when '2' then 'LOT2' when '02' then 'LOT2'
                when 'LOT2/3' then 'LOT2/3' when 'LOT23' then 'LOT2/3' when '2/3' then 'LOT2/3'
                else null end $function$
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
                            if v_new_lot <> c.lot and v_n > 0 and not (c.lot = 'LOT2/3' and v_new_lot in ('LOT2', 'LOT3')) then
                                raise exception '% has % truck(s), so its lot cannot be changed. Add it under % and retire this entry instead', c.name, v_n, v_new_lot; end if;
                            if (v_new_name <> c.name or v_new_lot <> c.lot)
                               and exists (select 1 from bm.companies x where x.vid <> v_vid and x.lot = v_new_lot and bm.norm_vendor(x.name) = bm.norm_vendor(v_new_name)) then
                                raise exception '% already exists under %', v_new_name, v_new_lot; end if;
                            if v_new_name <> c.name and v_n > 0 then            -- the name follows into the vendor's trucks, composites and mixing groups
                                update bm.trucks set company_name = v_new_name where company_name = c.name and lot = c.lot;
                                update bm.composite_batches set company_name = v_new_name where company_name = c.name and lot = c.lot;
                                update bm.mixing_groups set company_name = v_new_name where company_name = c.name and lot = c.lot;
                            end if;
                            if v_new_lot <> c.lot and v_n > 0 then              -- LOT2/3 -> LOT2 / LOT3: all the history of the vendor takes the new lot (same rules, nothing is re-evaluated)
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
    b bm.composite_batches; calc jsonb;
begin
    select * into b from bm.composite_batches where composite_barcode_id = v_code or test_lot = v_code for update;
    if not found then raise exception 'Invalid composite barcode (only the Test Lot -T code can be submitted).'; end if;
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
    l bm.lab1_results; ts text := bm.ist_now(); v_fin numeric; wrote boolean := false; v_status text; v_lot text; v_tid text; v_cs text; v_cr text; v_kind text; v_conf numeric; i int; v_own text; v_exs jsonb;
begin
    select lot, truck_id, cancel_status, cancel_reason into v_lot, v_tid, v_cs, v_cr from bm.trucks where sample1_barcode_id = v_bar;
    if not found then return jsonb_build_object('success', false, 'message', 'Invalid barcode. Truck entry not found.'); end if;
    if v_role <> 'admin' and v_cs is not null then
        return jsonb_build_object('success', false, 'cancelled', true, 'cancel_reason', v_cr,
            'message', format('This QR was %s%s. Nothing was saved - set the container aside.', case when v_cs = 'VOIDED' then 'voided (registration cancelled)' else 'CANCELLED' end, coalesce(' - reason: ' || v_cr, '')));
    end if;
    if v_m is null and v_iw is null and v_fw is null then raise exception 'Nothing to submit'; end if;
    if greatest(length(v_mph), length(v_iph), length(v_fph)) > 2500000 then raise exception 'Photo is too large'; end if;

    insert into bm.lab1_results(sample1_barcode_id) values (v_bar) on conflict do nothing;
    select * into l from bm.lab1_results where sample1_barcode_id = v_bar for update;

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

commit;
