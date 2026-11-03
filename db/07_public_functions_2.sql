-- public.bm_* functions, batch 2 of 5 (bm_admin_super_ack ... bm_entry_bottom_list), exactly as dumped.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bm_admin_super_ack(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_max bigint; n int;
begin
    perform bm.require(array['admin']);
    if bm.real_role() <> 'admin' then raise exception 'Only the Admin can acknowledge the Super Admin changes'; end if;
    select max(id) into v_max from bm.activity_logs;
    select count(*) into n from bm.activity_logs where id > coalesce((select value::bigint from bm.settings where key = 'super_ack_id'), 0) and action like 'SUPERADMIN\_%';
    insert into bm.settings(key, value) values ('super_ack_id', coalesce(v_max, 0)::text) on conflict (key) do update set value = excluded.value, updated_at = now();
    perform bm.log('ADMIN_ACK_SUPER', format('The Admin acknowledged %s Super Admin change(s)', n));
    return jsonb_build_object('success', true, 'acknowledged', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_super_alerts(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ack bigint := coalesce((select value::bigint from bm.settings where key = 'super_ack_id'), 0);
begin
    perform bm.require(array['admin']);
    return jsonb_build_object('unacknowledged', (select count(*) from bm.activity_logs a where a.id > v_ack and a.action like 'SUPERADMIN\_%' and not exists (select 1 from bm.log_acks k where k.log_id = a.id)),
        'unknown_ips', (select count(*) from bm.known_ips where label is null),
        'is_real_admin', bm.real_role() = 'admin');
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_templates_activate(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ver int := coalesce(nullif(p->>'version', '')::int, 0);
begin
    perform bm.require(array['admin']);
    if v_ver <> 0 and not exists (select 1 from bm.reader_templates where version = v_ver) then raise exception 'That version does not exist'; end if;
    update bm.reader_templates set active = (version = v_ver);
    perform bm.log('READER_TEMPLATES_ACTIVATED', case when v_ver = 0 then 'Reader went back to the built-in examples only' else format('Reader version %s is now active', v_ver) end);
    return jsonb_build_object('success', true, 'active_version', nullif(v_ver, 0));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_templates_publish(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ex jsonb := p->'examples'; v_ids bigint[]; v_note text := nullif(btrim(coalesce(p->>'note', '')), ''); v_ver int; n int;
begin
    perform bm.require(array['admin']);
    if jsonb_typeof(v_ex) is distinct from 'array' or jsonb_array_length(v_ex) = 0 then raise exception 'There are no learned examples to publish'; end if;
    if jsonb_array_length(v_ex) > 30000 then raise exception 'Too many examples (maximum 30000)'; end if;
    if exists (select 1 from jsonb_array_elements_text(v_ex) e where e !~ '^[0-9]{161}$') then raise exception 'An example has the wrong format'; end if;
    if v_note is not null and (length(v_note) > 300 or not bm.is_safe_text(v_note)) then raise exception 'The note is too long or has characters that are not allowed'; end if;
    select coalesce(array_agg(value::bigint), '{}') into v_ids from jsonb_array_elements_text(coalesce(p->'sample_ids', '[]'::jsonb));
    update bm.reader_templates set active = false where active;
    insert into bm.reader_templates(created_by, note, sample_count, examples, active)
    values (bm.uname(), v_note, (select count(*) from bm.reader_training where id = any(v_ids) and status <> 'REJECTED') + coalesce((select max(sample_count) from bm.reader_templates), 0), v_ex, true)
    returning version into v_ver;
    update bm.reader_training set status = 'USED', used_version = v_ver where id = any(v_ids) and status = 'PENDING';
    get diagnostics n = row_count;
    perform bm.log('READER_TEMPLATES_PUBLISHED', format('Reader version %s published (%s examples, %s new training sample(s))', v_ver, jsonb_array_length(v_ex), n));
    return jsonb_build_object('success', true, 'version', v_ver, 'samples_used', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_collect(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_on boolean := coalesce((p->>'collect')::boolean, true);
begin
    perform bm.require(array['admin']);
    insert into bm.settings(key, value) values ('reader_training_collect', case when v_on then 'on' else 'off' end)
    on conflict (key) do update set value = excluded.value, updated_at = now();
    perform bm.log('READER_TRAINING_COLLECT', 'Collecting low-confidence photos for reader training was switched ' || case when v_on then 'ON' else 'OFF' end);
    return jsonb_build_object('success', true, 'collect', v_on);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_delete_plan(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_scope text := lower(coalesce(nullif(btrim(p->>'scope'), ''), 'done'));
begin
    perform bm.require(array['admin']);
    if v_scope not in ('done', 'all') then raise exception 'Unknown scope'; end if;
    return jsonb_build_object(
        'files', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'path', r.photo, 'bytes', coalesce(nullif(o.metadata->>'size', '')::bigint, 0)) order by r.id)
                             from bm.reader_training r join storage.objects o on o.bucket_id = 'evidence' and o.name = substr(r.photo, 4)
                            where r.photo like 'ev/tr/%' and (v_scope = 'all' or r.status <> 'PENDING')), '[]'::jsonb),
        'detach', coalesce((select jsonb_agg(r.id order by r.id) from bm.reader_training r
                             where r.photo not like 'purged:%' and r.photo not like 'ev/tr/%' and (v_scope = 'all' or r.status <> 'PENDING')), '[]'::jsonb),
        'missing', coalesce((select jsonb_agg(r.id order by r.id) from bm.reader_training r
                              where r.photo like 'ev/tr/%' and not exists (select 1 from storage.objects o where o.bucket_id = 'evidence' and o.name = substr(r.photo, 4))
                                and (v_scope = 'all' or r.status <> 'PENDING')), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_examples(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ids bigint[];
begin
    perform bm.require(array['admin']);
    if jsonb_typeof(p->'ids') is distinct from 'array' or jsonb_array_length(p->'ids') > 200 then raise exception 'Give at most 200 samples'; end if;
    select coalesce(array_agg(value::bigint), '{}') into v_ids from jsonb_array_elements_text(p->'ids');
    return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'examples', r.examples) order by r.id) from bm.reader_training r where r.id = any(v_ids) and r.examples is not null), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_list(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_status text := upper(coalesce(nullif(btrim(p->>'status'), ''), 'PENDING'));
begin
    perform bm.require(array['admin']);
    if v_status not in ('PENDING', 'USED', 'REJECTED') then raise exception 'Unknown status'; end if;
    return jsonb_build_object(
        'collect', coalesce((select value from bm.settings where key = 'reader_training_collect'), 'on') = 'on',
        'counts', jsonb_build_object('pending', (select count(*) from bm.reader_training where status = 'PENDING'),
                                     'used', (select count(*) from bm.reader_training where status = 'USED'),
                                     'rejected', (select count(*) from bm.reader_training where status = 'REJECTED')),
        'last7',  (select count(*) from bm.reader_training where created_at >= now() - interval '7 days'),
        'prev7',  (select count(*) from bm.reader_training where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days'),
        'last30', (select count(*) from bm.reader_training where created_at >= now() - interval '30 days'),
        'prev30', (select count(*) from bm.reader_training where created_at >= now() - interval '60 days' and created_at < now() - interval '30 days'),
        'active_version', (select version from bm.reader_templates where active),
        'versions', coalesce((select jsonb_agg(jsonb_build_object('version', t.version, 'created_at', t.created_at, 'created_by', t.created_by, 'note', t.note, 'sample_count', t.sample_count,
                                  'examples', jsonb_array_length(t.examples), 'active', t.active) order by t.version desc) from bm.reader_templates t), '[]'::jsonb),
        'rows', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'created_at', x.created_at, 'kind', x.kind, 'value', x.value, 'conf', x.conf, 'status', x.status, 'used_version', x.used_version,
                                  'photo', x.photo, 'examples_n', coalesce(jsonb_array_length(x.examples), 0), 'operator', x.submitted_by, 'sample', x.sample1_barcode_id,
                                  'truck_reg_number', t.truck_reg_number, 'company_name', t.company_name, 'lot', t.lot, 'entry_date', t.entry_date) order by x.id desc)
                            from (select * from bm.reader_training where status = v_status order by id desc limit 300) x
                            left join bm.trucks t on t.sample1_barcode_id = x.sample1_barcode_id), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_mark(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ids bigint[]; v_status text := upper(coalesce(p->>'status', '')); n int;
begin
    perform bm.require(array['admin']);
    if v_status not in ('PENDING', 'REJECTED') then raise exception 'Choose REJECTED or PENDING'; end if;
    if jsonb_typeof(p->'ids') is distinct from 'array' or jsonb_array_length(p->'ids') = 0 then raise exception 'No samples were given'; end if;
    if jsonb_array_length(p->'ids') > 500 then raise exception 'Too many samples at once (maximum 500)'; end if;
    select coalesce(array_agg(value::bigint), '{}') into v_ids from jsonb_array_elements_text(p->'ids');
    update bm.reader_training set status = v_status, used_version = null where id = any(v_ids) and status <> 'USED';
    get diagnostics n = row_count;
    perform bm.log('READER_TRAINING_' || v_status, format('%s training sample(s) set to %s', n, v_status));
    return jsonb_build_object('success', true, 'updated', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_mark_deleted(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ids bigint[]; n int; v_mark text := 'purged:' || to_char(bm.ist_date(), 'YYYY-MM-DD');
begin
    perform bm.require(array['admin']);
    if jsonb_typeof(p->'ids') is distinct from 'array' or jsonb_array_length(p->'ids') = 0 then raise exception 'No samples were given'; end if;
    if jsonb_array_length(p->'ids') > 5000 then raise exception 'Too many samples at once (maximum 5000)'; end if;
    select coalesce(array_agg(value::bigint), '{}') into v_ids from jsonb_array_elements_text(p->'ids');
    if exists (select 1 from bm.reader_training r join storage.objects o on o.bucket_id = 'evidence' and o.name = substr(r.photo, 4) where r.id = any(v_ids) and r.photo like 'ev/tr/%') then
        raise exception 'A training photo file still exists in Storage - delete the files first'; end if;
    update bm.reader_training set photo = v_mark, status = case when status = 'PENDING' then 'REJECTED' else status end
     where id = any(v_ids) and photo not like 'purged:%';
    get diagnostics n = row_count;
    perform bm.log('READER_TRAINING_PHOTOS_DELETED', format('%s training photo(s) deleted from storage', n));
    return jsonb_build_object('success', true, 'updated', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_training_space(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return (select jsonb_build_object(
        'files', count(*) filter (where o.id is not null),
        'bytes', coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0),
        'waiting_files', count(*) filter (where o.id is not null and r.status = 'PENDING'),
        'waiting_bytes', coalesce(sum(nullif(o.metadata->>'size', '')::bigint) filter (where r.status = 'PENDING'), 0),
        'done_files', count(*) filter (where o.id is not null and r.status <> 'PENDING'),
        'done_bytes', coalesce(sum(nullif(o.metadata->>'size', '')::bigint) filter (where r.status <> 'PENDING'), 0),
        'inline_rows', count(*) filter (where r.photo like 'data:image/%'),
        'shared_rows', count(*) filter (where r.photo like 'ev/%' and r.photo not like 'ev/tr/%'),
        'deleted_rows', count(*) filter (where r.photo like 'purged:%'),
        'samples', count(*))
      from bm.reader_training r
      left join storage.objects o on o.bucket_id = 'evidence' and r.photo like 'ev/tr/%' and o.name = substr(r.photo, 4));
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_admin_update_referee(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    b bm.composite_batches; v_vendor numeric; v_ref numeric; v_status text := nullif(p->>'refereeStatus', '');
    v_ov text := nullif(btrim(coalesce(p->>'override_reason', '')), '');
begin
    perform bm.require(array['admin']);
    select * into b from bm.composite_batches where composite_ref_id = p->>'composite_ref_id' for update;
    if not found then raise exception 'Composite lot not found'; end if;
    if p ? 'vendorGcv'  then v_vendor := nullif(p->>'vendorGcv', '')::numeric; end if;
    if p ? 'refereeGcv' then v_ref    := nullif(p->>'refereeGcv', '')::numeric; end if;
    if v_status is not null and v_status not in ('CHALLENGED', 'RESOLVED') then raise exception 'Invalid referee status'; end if;
    if v_vendor is not null and (v_vendor <= 0 or v_vendor > 15000) then raise exception 'Vendor GCV out of range'; end if;
    if v_ref    is not null and (v_ref    <= 0 or v_ref    > 15000) then raise exception 'Referee GCV out of range'; end if;
    if v_ref is not null and b.referee_status is distinct from 'CHALLENGED' and b.referee_gcv is null and v_ov is null then
        raise exception 'Raise the referee challenge before entering the Referee GCV'; end if;
    if v_status = 'CHALLENGED' and b.vendor_gcv is null and v_vendor is null then
        raise exception 'Enter the Vendor GCV before raising a referee challenge'; end if;
    if v_ov is not null then perform set_config('bm.allow_override', 'on', true); end if;
    update bm.composite_batches set
        vendor_gcv = coalesce(v_vendor, vendor_gcv), referee_gcv = coalesce(v_ref, referee_gcv),
        referee_status = coalesce(v_status, referee_status), referee_updated_at = bm.ist_now()
     where composite_ref_id = b.composite_ref_id;
    perform bm.log('REFEREE_UPDATE', format('Lot %s updated%s', b.composite_ref_id, coalesce('. Reason: ' || v_ov, '')));
    return jsonb_build_object('success', true);
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

CREATE OR REPLACE FUNCTION public.bm_admin_vendors(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.require(array['admin']);
    return coalesce((select jsonb_agg(jsonb_build_object('id', c.vid, 'name', c.name, 'lot', c.lot, 'po_number', c.po_number, 'active', c.active,
                          'trucks', (select count(*) from bm.trucks t where t.company_name = c.name and t.lot = c.lot),
                          'last_used', (select max(t.entry_date) from bm.trucks t where t.company_name = c.name and t.lot = c.lot)) order by c.name, c.lot)
                       from bm.companies c), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_check_duplicate_vehicle(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_id text;
begin
    perform bm.require(array['admin','entry']);
    select t.truck_id into v_id from bm.trucks t
     where t.entry_date = bm.ist_date() and t.tare_weight = 0 and t.bottom_of is null and t.cancel_status is distinct from 'VOIDED'
       and bm.norm_reg(t.truck_reg_number) = bm.norm_reg(p->>'truck_reg_number') limit 1;
    return jsonb_build_object('duplicate', v_id is not null, 'truck_id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_device_recover(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_code text := upper(regexp_replace(coalesce(p->>'code', ''), '[^A-Za-z0-9]', '', 'g')); v_tok text := coalesce(p->>'token', '');
        v_name text := btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')); v_site text := nullif(left(btrim(coalesce(p->>'site', '')), 80), '');
        v_salt text; v_hash text; v_id bigint; v_sess text := bm.jwt_claim('session_id');
begin
    if bm.real_role() is distinct from 'superadmin' then raise exception 'Only the Super Admin login can use a recovery code' using errcode = '42501'; end if;
    if coalesce((select value from bm.settings where key = 'mfa_required'), 'off') = 'on' and coalesce(bm.jwt_claim('aal'), 'aal1') <> 'aal2' then
        raise exception 'Second step required: sign in again and type the 6-digit code from your authenticator app.' using errcode = '42501'; end if;
    if (select count(*) from bm.recovery_fails where uid = auth.uid() and at > now() - interval '15 minutes') >= 5 then
        return jsonb_build_object('success', false, 'message', 'Too many wrong codes. Wait 15 minutes (or use the emergency SQL in Supabase).'); end if;
    select value into v_salt from bm.settings where key = 'super_recovery_salt';
    select value into v_hash from bm.settings where key = 'super_recovery_hash';
    if v_hash is null then return jsonb_build_object('success', false, 'message', 'No recovery code has been created.'); end if;
    if length(v_tok) < 32 then raise exception 'This browser has no device code yet'; end if;
    if length(v_name) < 2 or length(v_name) > 60 or not bm.is_safe_text(v_name) then raise exception 'Give this computer a name of 2 to 60 characters'; end if;
    if bm.bottom_pw_hash(v_salt, v_code) <> v_hash then
        insert into bm.recovery_fails(uid) values (auth.uid());
        perform bm.super_log('RECOVERY_CODE_WRONG', format('A WRONG recovery code was typed for the Super Admin login (%s, IP %s).', bm.agent_brief(bm.client_device()), bm.client_ip()));
        return jsonb_build_object('success', false, 'message', 'That recovery code is not correct.');
    end if;
    insert into bm.trusted_devices(user_id, name, token_hash, status, approved_by, approved_at, last_ip, agent, site, last_seen)
    values (auth.uid(), v_name, bm.token_hash(v_tok), 'TRUSTED', 'recovery code', now(), bm.client_ip(), left(bm.client_device(), 200), v_site, now())
    on conflict (user_id, token_hash) do update set status = 'TRUSTED', name = excluded.name, approved_by = 'recovery code', approved_at = now(), site = coalesce(excluded.site, bm.trusted_devices.site)
    returning id into v_id;
    if v_sess is not null then
        insert into bm.verified_sessions(session_id, user_id, device_id) values (v_sess, auth.uid(), v_id) on conflict (session_id) do update set device_id = excluded.device_id, verified_at = now();
    end if;
    delete from bm.settings where key in ('super_recovery_hash', 'super_recovery_salt');          -- one use only
    delete from bm.recovery_fails where uid = auth.uid();
    perform bm.super_log('DEVICE_RECOVERED', format('The recovery code was used: "%s" (%s, IP %s) is now a trusted computer of the Super Admin login. The code is used up - create a new one.', v_name, bm.agent_brief(bm.client_device()), bm.client_ip()));
    return jsonb_build_object('success', true, 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_device_request(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_tok text := coalesce(p->>'token', ''); v_name text := btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')); d bm.trusted_devices;
begin
    if bm.real_role() is null then raise exception 'Not signed in, or this account has not been provisioned' using errcode = '42501'; end if;
    if length(v_tok) < 32 then raise exception 'This browser has no device code yet'; end if;
    if length(v_name) < 2 or length(v_name) > 60 or not bm.is_safe_text(v_name) then raise exception 'Give the device a name of 2 to 60 characters'; end if;
    select * into d from bm.trusted_devices where user_id = auth.uid() and token_hash = bm.token_hash(v_tok);
    if found then
        if d.status = 'PENDING' and d.name <> v_name then update bm.trusted_devices set name = v_name where id = d.id; end if;       -- the person on that computer gives it a name the Super Admin will recognise
        return jsonb_build_object('success', true, 'status', d.status);
    end if;
    insert into bm.trusted_devices(user_id, name, token_hash, last_ip, agent, site, last_seen) values (auth.uid(), v_name, bm.token_hash(v_tok), bm.client_ip(), left(bm.client_device(), 200), nullif(left(btrim(coalesce(p->>'site', '')), 80), ''), now());
    perform bm.super_log('DEVICE_REQUESTED', format('A new computer asks to be trusted for the login %s: "%s". Approve it in Super Admin > Security.', bm.uname(), v_name));
    return jsonb_build_object('success', true, 'status', 'PENDING');
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_device_verify(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_tok text := coalesce(p->>'token', ''); d bm.trusted_devices; v_sess text := bm.jwt_claim('session_id'); v_lock boolean; v_role text := bm.real_role();
        v_user text := bm.uname(); v_ip text := bm.client_ip(); v_ag text := bm.client_device(); v_name text; v_site text := left(btrim(coalesce(p->>'site', '')), 80);
begin
    if v_role is null then raise exception 'Not signed in, or this account has not been provisioned' using errcode = '42501'; end if;
    v_lock := coalesce(bm.device_lock_on(auth.uid()), false);
    if length(v_tok) < 32 then return jsonb_build_object('verified', false, 'status', 'NONE', 'lock', v_lock); end if;
    select * into d from bm.trusted_devices where user_id = auth.uid() and token_hash = bm.token_hash(v_tok);
    if not found then
        if v_role = 'superadmin' or (select count(*) from bm.trusted_devices x where x.user_id = auth.uid() and x.status = 'PENDING') >= 10 then
            -- (the Super Admin names its own computer when it asks; nobody can pile up more than 10 waiting computers)
            if v_lock and not bm.recent_log('SUPERADMIN_DEVICE_BLOCKED', v_user, v_ip, 30) then
                perform bm.super_log('DEVICE_BLOCKED', format('The login %s was used from a computer that is NOT approved (%s, IP %s).', v_user, bm.agent_brief(v_ag), v_ip));
            end if;
            return jsonb_build_object('verified', false, 'status', 'UNKNOWN', 'lock', v_lock);
        end if;
        v_name := left(bm.agent_brief(v_ag) || ' - ' || coalesce(bm.ip_label(v_ip), v_ip), 60);
        insert into bm.trusted_devices(user_id, name, token_hash, last_ip, agent, site, last_seen) values (auth.uid(), v_name, bm.token_hash(v_tok), v_ip, left(v_ag, 200), nullif(v_site, ''), now()) returning * into d;
        perform bm.super_log('DEVICE_REQUESTED', format('A new computer is waiting for approval for the login %s: "%s". Approve it in Super Admin > Security.', v_user, v_name));
    end if;
    update bm.trusted_devices set last_seen = now(), last_ip = v_ip, agent = left(v_ag, 200), site = coalesce(nullif(v_site, ''), site) where id = d.id;
    if d.status = 'TRUSTED' then
        if v_sess is not null then
            insert into bm.verified_sessions(session_id, user_id, device_id) values (v_sess, auth.uid(), d.id)
            on conflict (session_id) do update set device_id = excluded.device_id, verified_at = now(), user_id = excluded.user_id;
        end if;
        delete from bm.verified_sessions where verified_at < now() - interval '365 days';
        return jsonb_build_object('verified', true, 'status', 'TRUSTED', 'lock', v_lock, 'name', d.name);
    end if;
    if v_lock and not bm.recent_log('SUPERADMIN_DEVICE_BLOCKED', v_user, v_ip, 30) then
        perform bm.super_log('DEVICE_BLOCKED', format('The login %s was used from the computer "%s" which is %s.', v_user, d.name, case when d.status = 'PENDING' then 'still waiting for approval' else 'REVOKED' end));
    end if;
    return jsonb_build_object('verified', false, 'status', d.status, 'lock', v_lock, 'name', d.name);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_entry_bottom_generate(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v_role text := bm.require(array['entry', 'admin']);
    v_tid text := btrim(coalesce(p->>'truck_id', ''));
    o bm.trucks; r bm.bottom_requests; v_s1 text; v_group text; v_bt text; v_date date;
begin
    select * into o from bm.trucks where truck_id = v_tid and bottom_of is null and cancel_status is distinct from 'VOIDED' for update;
    if not found then raise exception 'Truck not found'; end if;
    v_date := o.entry_date;       -- the bottom sample belongs to the day of its ORIGINAL truck (labels, mixing code, composite, reports), not the day it was requested / generated
    select * into r from bm.bottom_requests where truck_id = v_tid for update;
    if not found then raise exception 'No bottom-sampling request exists for this truck'; end if;
    if r.status = 'GENERATED' then raise exception 'The bottom sample for this truck was already generated. Use Reprint.'; end if;
    if exists (select 1 from bm.composite_batches c where c.date = o.entry_date and c.daily_group_code = o.daily_group_code) then
        raise exception 'The composite of this truck''s mixing group is already made. Contact the administrator.'; end if;

    loop
        v_s1 := 'S1-' || upper(bm.rand_hex(8));
        exit when not exists (select 1 from bm.trucks where sample1_barcode_id = v_s1);
    end loop;
    v_bt := 'BS-' || o.truck_id;
    v_group := bm.group_for('BOTTOM:' || o.truck_id, v_date, o.lot);
    insert into bm.trucks(truck_id, company_name, driver_name, truck_reg_number, invoice_no, po_number, lot, bottom_of,
                          entry_date, entry_time, sample1_barcode_id, daily_group_code, created_by, acceptance_status)
    values (v_bt, o.company_name, o.driver_name, o.truck_reg_number, o.invoice_no, o.po_number, o.lot, o.truck_id,
            v_date, o.entry_time, v_s1, v_group, bm.uname(), 'ACCEPTED');
    update bm.trucks set excluded_from_mix = true where truck_id = o.truck_id;
    delete from bm.mixing_scans where sample1_barcode_id = o.sample1_barcode_id;      -- the original is out of the mix now
    update bm.bottom_requests set status = 'GENERATED', generated_by = bm.uname(), generated_at = now(), bottom_truck_id = v_bt where truck_id = o.truck_id;
    perform bm.copy_lab_to_bottoms(o.sample1_barcode_id);      -- moisture / fineness of the original go onto the bottom sample
    perform bm.log('BOTTOM_SAMPLE_CREATED', format('Bottom sample created for truck %s; original sample excluded from its composite', o.truck_id));

    return jsonb_build_object('success', true, 'sample1_barcode_id', v_s1, 'entry_date', v_date, 'truck_id', o.truck_id,
                              'truck_reg_number', o.truck_reg_number, 'company_name', o.company_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.bm_entry_bottom_list(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_role text := bm.require(array['entry', 'admin']);
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'truck_id', r.truck_id, 'truck_reg_number', t.truck_reg_number, 'company_name', t.company_name, 'driver_name', t.driver_name, 'entry_date', t.entry_date,
                   'status', r.status, 'requested_date', r.requested_date, 'requested_time', r.requested_time,
                   'generated', r.status = 'GENERATED')
                   || case when v_role = 'admin' then jsonb_build_object('reason', r.reason, 'requested_by', r.requested_by) else '{}'::jsonb end
                   order by (r.status = 'REQUESTED') desc, r.requested_at desc)
          from bm.bottom_requests r join bm.trucks t on t.truck_id = r.truck_id
         where r.status = 'REQUESTED' or r.generated_at > now() - interval '3 days'
    ), '[]'::jsonb);
end $function$
;

set check_function_bodies = on;
