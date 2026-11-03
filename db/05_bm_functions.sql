-- Helper functions in schema bm (live project jarfhyraxjvtimradvbp), exactly as dumped.
-- Run AFTER 01_bm_tables.sql. Function bodies reference each other in alphabetical dump order,
-- so body checking is switched off while loading.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION bm.accept(m numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case when m is null then 'PENDING' when m >= 14 then 'REJECTED' else 'ACCEPTED' end $function$
;

CREATE OR REPLACE FUNCTION bm.accept(m numeric, p_lot text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select case when m is null then 'PENDING' when bm.is_lot4(p_lot) then 'ACCEPTED' when m >= 14 then 'REJECTED' else 'ACCEPTED' end $function$
;

CREATE OR REPLACE FUNCTION bm.agent_brief(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(case when p ilike '%edg/%' then 'Edge' when p ilike '%firefox%' then 'Firefox' when p ilike '%chrome%' or p ilike '%crios%' then 'Chrome' when p ilike '%safari%' then 'Safari' end, 'Browser')
          || ' on ' || coalesce(case when p ilike '%windows%' then 'Windows' when p ilike '%android%' then 'Android' when p ilike '%iphone%' then 'iPhone' when p ilike '%ipad%' then 'iPad'
                                     when p ilike '%mac os%' then 'Mac' when p ilike '%linux%' then 'Linux' end, 'an unknown system') $function$
;

CREATE OR REPLACE FUNCTION bm.append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    if current_setting('bm.allow_override', true) = 'on' then
        if tg_op = 'DELETE' then return old; else return new; end if;
    end if;
    raise exception 'The audit log is append-only';
end $function$
;

CREATE OR REPLACE FUNCTION bm.bottom_pw_hash(p_salt text, p_pw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select encode(sha256(convert_to(p_salt || ':' || p_pw, 'UTF8')), 'hex') $function$
;

CREATE OR REPLACE FUNCTION bm.calc_composite(p_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare b bm.composite_batches; c jsonb;
begin
    select * into b from bm.composite_batches where composite_ref_id = p_ref for update;
    c := bm.calc_values(b, b.ad_moisture, b.ad_gcv, b.ad_ash, b.ad_sulphur, b.ad_vm);
    update bm.composite_batches set tm_value = (c->>'tm')::numeric, x_factor = (c->>'x')::numeric,
           gcv_value = (c->>'arb_gcv')::numeric, ash_pct = (c->>'arb_ash')::numeric,
           arb_sulphur = (c->>'arb_sulphur')::numeric, arb_vm = (c->>'arb_vm')::numeric
     where composite_ref_id = p_ref;
    return c;
end $function$
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

CREATE OR REPLACE FUNCTION bm.check_action_password(p_pw text, p_what text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_user text := bm.uname(); v_fails int; v_salt text; v_hash text;
begin
    select count(*) into v_fails from bm.bottom_pw_fails where username = v_user and at > now() - interval '10 minutes';
    if v_fails >= 5 then return 'Too many wrong passwords. Wait 10 minutes or ask the administrator.'; end if;
    select value into v_salt from bm.settings where key = 'bottom_pw_salt';
    select value into v_hash from bm.settings where key = 'bottom_pw_hash';
    if v_hash is null then return 'The action password has not been set yet. Ask the administrator.'; end if;
    if bm.bottom_pw_hash(v_salt, coalesce(p_pw, '')) <> v_hash then
        insert into bm.bottom_pw_fails(username) values (v_user);
        perform bm.log('BOTTOM_PASSWORD_WRONG', format('Wrong action password entered (%s)', p_what));
        return 'Wrong password. Nothing was changed.';
    end if;
    return null;
end $function$
;

CREATE OR REPLACE FUNCTION bm.client_device()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare h json;
begin
    begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then return null; end;
    return left(nullif(btrim(coalesce(h->>'user-agent', '')), ''), 200);
end $function$
;

CREATE OR REPLACE FUNCTION bm.client_ip()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare h json; v text;
begin
    begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then return 'unknown'; end;
    if h is null then return 'unknown'; end if;
    v := coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''), nullif(btrim(h->>'x-real-ip'), ''),
                  nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''), 'unknown');
    return bm.ip_key(left(v, 64));
end $function$
;

CREATE OR REPLACE FUNCTION bm.company_initials(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
    select coalesce(
        nullif(left((select string_agg(upper(left(w, 1)), '' order by n)
                       from regexp_split_to_table(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9 ]', ' ', 'g'), '\s+')
                            with ordinality as t(w, n)
                      where w <> '' and lower(w) not in ('pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'corp',
                                                         'corporation', 'inc', 'the', 'and', 'of', 'm', 's')), 5), ''),
        upper(left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]', '', 'g'), 3)));
$function$
;

CREATE OR REPLACE FUNCTION bm.composite_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    if current_setting('bm.allow_override', true) = 'on' then return new; end if;
    if old.gcv_value is not null and new.gcv_value is distinct from old.gcv_value then
        raise exception 'GCV result is locked and cannot be changed'; end if;
    if old.ash_pct is not null and new.ash_pct is distinct from old.ash_pct then
        raise exception 'Ash result is locked and cannot be changed'; end if;
    if old.ad_gcv is not null and (new.ad_gcv is distinct from old.ad_gcv or new.ad_ash is distinct from old.ad_ash or new.ad_moisture is distinct from old.ad_moisture
                                   or new.ad_sulphur is distinct from old.ad_sulphur or new.ad_vm is distinct from old.ad_vm
                                   or new.tm_value is distinct from old.tm_value or new.x_factor is distinct from old.x_factor
                                   or new.arb_sulphur is distinct from old.arb_sulphur or new.arb_vm is distinct from old.arb_vm) then
        raise exception 'The air-dried values and the calculated ARB values are locked and cannot be changed'; end if;
    if old.vendor_gcv is not null and new.vendor_gcv is distinct from old.vendor_gcv then
        raise exception 'Vendor GCV is locked and cannot be changed'; end if;
    if old.referee_gcv is not null and new.referee_gcv is distinct from old.referee_gcv then
        raise exception 'Referee GCV is locked and cannot be changed'; end if;
    return new;
end $function$
;

CREATE OR REPLACE FUNCTION bm.composite_tm(b bm.composite_batches)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare n int; m int; v numeric;
begin
    select count(*), count(l.moisture_pct), avg(l.moisture_pct) into n, m, v
      from bm.trucks t left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
     where t.truck_id in (select jsonb_array_elements_text(b.parent_truck_ids));
    if n = 0 or n <> m or n <> jsonb_array_length(b.parent_truck_ids) then return null; end if;
    return v;
end $function$
;

CREATE OR REPLACE FUNCTION bm.copy_lab_to_bottoms(p_sample text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare l bm.lab1_results; b record; v_prev text;
begin
    select * into l from bm.lab1_results where sample1_barcode_id = p_sample;
    if not found then return; end if;
    v_prev := current_setting('bm.allow_override', true);
    for b in select bt.sample1_barcode_id as bar from bm.trucks bt join bm.trucks o on o.truck_id = bt.bottom_of where o.sample1_barcode_id = p_sample loop
        perform set_config('bm.allow_override', 'on', true);
        insert into bm.lab1_results(sample1_barcode_id, moisture_pct, fineness_value, fineness_initial_weight, fineness_final_weight, tested_by, tested_at)
        values (b.bar, l.moisture_pct, l.fineness_value, l.fineness_initial_weight, l.fineness_final_weight, 'Copied from the original truck', l.tested_at)
        on conflict (sample1_barcode_id) do update set moisture_pct = excluded.moisture_pct, fineness_value = excluded.fineness_value,
            fineness_initial_weight = excluded.fineness_initial_weight, fineness_final_weight = excluded.fineness_final_weight, tested_at = excluded.tested_at;
    end loop;
    perform set_config('bm.allow_override', coalesce(v_prev, ''), true);
end $function$
;

CREATE OR REPLACE FUNCTION bm.device_lock_on(p_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select case when p.role = 'superadmin' then coalesce((select value from bm.settings where key = 'super_lock'), 'off') = 'on'
               else p.device_lock and not p.mfa_exempt end
     from bm.profiles p where p.id = p_uid and p.active $function$
;

CREATE OR REPLACE FUNCTION bm.gate()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare rr text := bm.real_role();
begin
    if rr is null then return; end if;
    if rr in ('admin', 'superadmin') and coalesce((select value from bm.settings where key = 'mfa_required'), 'off') = 'on' and coalesce(bm.jwt_claim('aal'), 'aal1') <> 'aal2'
       and not (rr = 'admin' and exists (select 1 from bm.profiles x where x.id = auth.uid() and x.mfa_exempt)) then
        raise exception 'Second step required: sign in again and type the 6-digit code from your authenticator app.' using errcode = '42501';
    end if;
    if coalesce(bm.device_lock_on(auth.uid()), false)
       and not exists (select 1 from bm.verified_sessions v where v.session_id = bm.jwt_claim('session_id') and v.user_id = auth.uid()) then
        raise exception '%', case when rr = 'superadmin' then 'This device is not trusted for the Super Admin login.'
                                  else 'This device is not registered for this login. Ask the Super Admin to approve it.' end using errcode = '42501';
    end if;
end $function$
;

CREATE OR REPLACE FUNCTION bm.group_for(p_company text, p_date date, p_lot text DEFAULT 'LOT2/3'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    v text; i int := 0;
    alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   -- 32 chars, no 0/O/1/I
begin
    select group_code into v from bm.mixing_groups where entry_date = p_date and company_name = p_company and lot = p_lot;
    if v is not null then return v; end if;
    loop
        i := i + 1;
        select string_agg(substr(alphabet, 1 + (get_byte(x.b, n) % 32), 1), '' order by n) into v
          from (select uuid_send(gen_random_uuid()) as b) x, generate_series(0, 2) n;
        if i <= 400 and exists (select 1 from bm.mixing_groups where group_code = v) then continue; end if;   -- already used on some date
        begin
            insert into bm.mixing_groups(entry_date, company_name, group_code, lot) values (p_date, p_company, v, p_lot);
            return v;
        exception when unique_violation then
            select group_code into v from bm.mixing_groups where entry_date = p_date and company_name = p_company and lot = p_lot;
            if v is not null then return v; end if;      -- same supplier registered concurrently
            if i > 600 then raise exception 'Could not allocate a mixing group code'; end if;
        end;
    end loop;
end $function$
;

CREATE OR REPLACE FUNCTION bm.guard_status_flip(p_truck_id text, p_old numeric, p_new numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare t bm.trucks; v_comp text;
begin
    select * into t from bm.trucks where truck_id = p_truck_id;
    if not found or p_old is null or p_new is null then return; end if;
    if bm.accept(p_old, t.lot) = bm.accept(p_new, t.lot) then return; end if;
    select b.composite_ref_id into v_comp from bm.composite_batches b where b.parent_truck_ids ? t.truck_id limit 1;
    if v_comp is not null then
        raise exception 'Moisture % -> % moves this truck across the accept / reject limit, but it is already inside composite %. Void that composite first (Super Admin > Toolbox), correct the moisture, then create the composite again.', p_old, p_new, v_comp; end if;
    if exists (select 1 from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id) then
        delete from bm.mixing_scans where sample1_barcode_id = t.sample1_barcode_id;
        perform bm.log('MIXING_SCAN_CLEARED', format('Truck %s: moisture corrected %s -> %s changes accepted / rejected, so its mixing scan was cleared (scan the container again)', t.truck_id, p_old, p_new));
    end if;
end $function$
;

CREATE OR REPLACE FUNCTION bm.ip_in_range(p_ip text, p_range text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    return p_ip::inet <<= p_range::inet;
exception when others then return false;
end $function$
;

CREATE OR REPLACE FUNCTION bm.ip_key(p text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare i inet;
begin
    if p is null or position(':' in p) = 0 or p like '%/%' then return p; end if;
    begin i := p::inet; exception when others then return p; end;
    if family(i) <> 6 then return p; end if;
    if host(i) ~* '^::ffff:[0-9.]+$' then return regexp_replace(host(i), '^::ffff:', '', 'i'); end if;
    return host(network(set_masklen(i, 64))) || '/64';
end $function$
;

CREATE OR REPLACE FUNCTION bm.ip_label(p_ip text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_key text := bm.ip_key(p_ip); v text;
begin
    if p_ip is null then return null; end if;
    select k.label into v from bm.known_ips k
     where k.label is not null and (k.ip = v_key or k.ip = p_ip or (position('/' in k.ip) > 0 and bm.ip_in_range(p_ip, k.ip)))
     order by (k.ip = v_key or k.ip = p_ip) desc, masklen(case when position('/' in k.ip) > 0 then k.ip::inet else '0.0.0.0/0'::inet end) desc limit 1;
    return v;
end $function$
;

CREATE OR REPLACE FUNCTION bm.is_enrolled(p_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select exists (select 1 from auth.mfa_factors f where f.user_id = p_uid and f.status::text = 'verified' and f.factor_type::text = 'totp') $function$
;

CREATE OR REPLACE FUNCTION bm.is_exception_log(p_action text, p_details text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select lower(coalesce(p_action, '')) like '%exception%' or lower(coalesce(p_action, '')) like '%reissue%' or lower(coalesce(p_action, '')) like '%lockout%'
          or coalesce(p_action, '') like 'SUPERADMIN%' or coalesce(p_action, '') in ('BOTTOM_PASSWORD_WRONG', 'QR_CANCELLED')
          or lower(coalesce(p_details, '')) like '%fail%' or lower(coalesce(p_details, '')) like '%expired%' or lower(coalesce(p_details, '')) like '%tampered%' $function$
;

-- Lot 4 and Lot 4A follow the same rules (no moisture rejection, sulphur + VM recorded)
CREATE OR REPLACE FUNCTION bm.is_lot4(p_lot text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(p_lot in ('LOT4', 'LOT4A'), false) $function$
;

CREATE OR REPLACE FUNCTION bm.is_safe_text(s text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select s is null or (s !~ '[<>"`\\]' and s !~ '\$\{' and s !~ '[[:cntrl:]]') $function$
;

CREATE OR REPLACE FUNCTION bm.ist_date()
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$ select bm.ist_ts()::date $function$
;

CREATE OR REPLACE FUNCTION bm.ist_now()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select to_char(bm.ist_ts(), 'YYYY-MM-DD HH24:MI') $function$
;

CREATE OR REPLACE FUNCTION bm.ist_time()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select to_char(bm.ist_ts(), 'HH24:MI') $function$
;

CREATE OR REPLACE FUNCTION bm.ist_ts()
 RETURNS timestamp without time zone
 LANGUAGE sql
 STABLE
AS $function$ select (now() at time zone 'UTC') + interval '5 hours 30 minutes' $function$
;

CREATE OR REPLACE FUNCTION bm.jwt_claim(k text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> k, '') $function$
;

CREATE OR REPLACE FUNCTION bm.lab1_admin_json(l bm.lab1_results)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
    select (to_jsonb(l) - 'moisture_photo' - 'fineness_initial_photo' - 'fineness_final_photo')
        || jsonb_build_object(
            'has_moisture_photo',          coalesce(l.moisture_photo, '') <> '',
            'has_fineness_initial_photo',  coalesce(l.fineness_initial_photo, '') <> '',
            'has_fineness_final_photo',    coalesce(l.fineness_final_photo, '') <> '')
$function$
;

CREATE OR REPLACE FUNCTION bm.lab1_copy_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.copy_lab_to_bottoms(new.sample1_barcode_id);
    return null;
end $function$
;

CREATE OR REPLACE FUNCTION bm.lab1_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    if current_setting('bm.allow_override', true) = 'on' then return new; end if;
    if old.moisture_pct is not null and new.moisture_pct is distinct from old.moisture_pct then
        raise exception 'Moisture result is locked and cannot be changed'; end if;
    if old.fineness_value is not null and new.fineness_value is distinct from old.fineness_value then
        raise exception 'Fineness result is locked and cannot be changed'; end if;
    if old.fineness_initial_weight is not null and new.fineness_initial_weight is distinct from old.fineness_initial_weight then
        raise exception 'Fineness weights are locked and cannot be changed'; end if;
    if old.fineness_final_weight is not null and new.fineness_final_weight is distinct from old.fineness_final_weight then
        raise exception 'Fineness weights are locked and cannot be changed'; end if;
    return new;
end $function$
;

CREATE OR REPLACE FUNCTION bm.log(p_action text, p_details text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_ip text := bm.client_ip(); v_dev text := bm.client_device(); v_user text := coalesce(bm.uname(), 'system'); n int; v_range text; v_dn text; v_did bigint;
begin
    -- the registered computer this session was verified on (set when the person signed in on an approved computer)
    if auth.uid() is not null and to_regclass('bm.verified_sessions') is not null and to_regclass('bm.trusted_devices') is not null then
        select d.id, d.name into v_did, v_dn from bm.verified_sessions s join bm.trusted_devices d on d.id = s.device_id
         where s.session_id = bm.jwt_claim('session_id') and s.user_id = auth.uid();
    end if;
    insert into bm.activity_logs(timestamp, username, action, details, ip, device, device_name, device_id)
    values (bm.ist_now(), v_user, left(p_action, 100), left(coalesce(p_details, ''), 1000), v_ip, v_dev, v_dn, v_did);
    if coalesce(v_ip, 'unknown') <> 'unknown' then
        select k.ip into v_range from bm.known_ips k where k.label is not null and position('/' in k.ip) > 0 and k.ip <> v_ip and bm.ip_in_range(v_ip, k.ip)
         order by masklen(k.ip::inet) desc limit 1;
        if v_range is not null then       -- inside a range the Super Admin has already named: not a new place
            update bm.known_ips set last_seen = now(), seen_count = seen_count + 1, last_user = v_user, last_action = left(p_action, 100), device = v_dev where ip = v_range;
            return;
        end if;
        insert into bm.known_ips(ip, last_user, last_action, device) values (v_ip, v_user, left(p_action, 100), v_dev) on conflict (ip) do nothing;
        get diagnostics n = row_count;
        if n = 1 then       -- a never-seen-before address: flag it (shown in red in Exceptions & Security Violations until it is named)
            insert into bm.activity_logs(timestamp, username, action, details, ip, device, device_name, device_id)
            values (bm.ist_now(), v_user, 'NEW_IP_DETECTED', format('A NEW IP address %s was seen for the first time (login %s, action %s). Name it in Super Admin > IP addresses.', v_ip, v_user, left(p_action, 60)), v_ip, v_dev, v_dn, v_did);
        else
            update bm.known_ips set last_seen = now(), seen_count = seen_count + 1, last_user = v_user, last_action = left(p_action, 100), device = v_dev where ip = v_ip;
        end if;
    end if;
end $function$
;

CREATE OR REPLACE FUNCTION bm.mix_status(t bm.trucks, m numeric)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select case when t.cancel_status is not null then 'CANCELLED' when t.bottom_of is not null then 'ACCEPTED' when t.excluded_from_mix then 'REJECTED' else bm.truck_status(t, m) end $function$
;

CREATE OR REPLACE FUNCTION bm.mixing_progress(p_date date, p_group text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
    select jsonb_build_object(
        'accepted_total',   count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED'),
        'accepted_scanned', count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'ACCEPTED' and m.sample1_barcode_id is not null),
        'rejected_total',   count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'REJECTED'),
        'rejected_scanned', count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'REJECTED' and m.sample1_barcode_id is not null),
        'pending_total',    count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'PENDING'),
        'cancelled_total',  count(*) filter (where bm.mix_status(t, l.moisture_pct) = 'CANCELLED'))
      from bm.trucks t
      left join bm.lab1_results l on l.sample1_barcode_id = t.sample1_barcode_id
      left join bm.mixing_scans m on m.sample1_barcode_id = t.sample1_barcode_id
     where t.entry_date = p_date and t.daily_group_code = p_group
$function$
;

CREATE OR REPLACE FUNCTION bm.next_counter(p_name text, p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v integer;
begin
    insert into bm.counters(name, day, n) values (p_name, p_day, 1)
    on conflict (name, day) do update set n = bm.counters.n + 1
    returning n into v;
    return v;
end $function$
;

CREATE OR REPLACE FUNCTION bm.no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    if current_setting('bm.allow_override', true) = 'on' then return old; end if;
    raise exception 'Deleting % records is not permitted', tg_table_name;
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

CREATE OR REPLACE FUNCTION bm.norm_reg(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select regexp_replace(upper(coalesce(s,'')), '[^A-Z0-9]', '', 'g') $function$
;

CREATE OR REPLACE FUNCTION bm.norm_vendor(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select lower(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g'))) $function$
;

CREATE OR REPLACE FUNCTION bm.photo_ok(p text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    if p like 'data:image/%' then return true; end if;
    if p ~ '^ev/[A-Za-z0-9_./-]{8,200}$' and p !~ '\.\.' then
        return exists (select 1 from storage.objects o where o.bucket_id = 'evidence' and o.name = substr(p, 4));
    end if;
    return false;
end $function$
;

CREATE OR REPLACE FUNCTION bm.rand_hex(n integer)
 RETURNS text
 LANGUAGE sql
AS $function$ select substr(encode(uuid_send(gen_random_uuid()), 'hex'), 1, n) $function$
;

CREATE OR REPLACE FUNCTION bm.real_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select p.role from bm.profiles p where p.id = auth.uid() and p.active $function$
;

CREATE OR REPLACE FUNCTION bm.recent_log(p_action text, p_user text, p_ip text, p_minutes integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select exists (select 1 from bm.activity_logs a
                   where a.id > coalesce((select max(id) from bm.activity_logs), 0) - 3000 and a.action = p_action and a.username = p_user and a.ip is not distinct from p_ip
                     and a.timestamp >= to_char(bm.ist_ts() - make_interval(mins => p_minutes), 'YYYY-MM-DD HH24:MI')) $function$
;

CREATE OR REPLACE FUNCTION bm.recompute_for_truck(p_truck_id text, p_why text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare r record;
begin
    for r in select composite_ref_id from bm.composite_batches where ad_gcv is not null and parent_truck_ids ? p_truck_id loop
        perform set_config('bm.allow_override', 'on', true);
        perform bm.calc_composite(r.composite_ref_id);
        perform bm.log('COMPOSITE_RECALCULATED', format('Composite %s recalculated (%s)', r.composite_ref_id, p_why));
    end loop;
end $function$
;

CREATE OR REPLACE FUNCTION bm.require(roles text[])
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare r text := bm.role();
begin
    if r is null then
        raise exception 'Not signed in, or this account has not been provisioned' using errcode = '42501';
    end if;
    if not (r = any(roles)) then
        raise exception 'Unauthorized: the % login cannot perform this action', r using errcode = '42501';
    end if;
    perform bm.gate();
    return r;
end $function$
;

CREATE OR REPLACE FUNCTION bm.require_super()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    if bm.real_role() is distinct from 'superadmin' then
        raise exception 'Unauthorized: only the Super Admin login can do this' using errcode = '42501';
    end if;
    perform bm.gate();
end $function$
;

CREATE OR REPLACE FUNCTION bm.role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select case when p.role = 'superadmin' then 'admin' else p.role end from bm.profiles p where p.id = auth.uid() and p.active $function$
;

CREATE OR REPLACE FUNCTION bm.super_log(p_action text, p_details text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.log('SUPERADMIN_' || p_action, left(coalesce(p_details, ''), 800) || ' | IP ' || bm.client_ip());
end $function$
;

CREATE OR REPLACE FUNCTION bm.super_reason(p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
declare v text := btrim(coalesce(p->>'reason', ''));
begin
    if length(v) < 5 or length(v) > 300 or not bm.is_safe_text(v) then
        raise exception 'A reason of 5 to 300 characters is required for every Super Admin change'; end if;
    return v;
end $function$
;

CREATE OR REPLACE FUNCTION bm.sync_exit_weight(p_truck_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare t bm.trucks; m numeric; st text;
begin
    select * into t from bm.trucks where truck_id = p_truck_id and bottom_of is null;
    if not found or t.cancel_status = 'VOIDED' then return; end if;
    select moisture_pct into m from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    st := bm.truck_status(t, m);
    if st in ('REJECTED', 'CANCELLED') then
        if t.gross_weight > 0 and (t.tare_weight = 0 or (t.tare_auto and t.tare_weight <> t.gross_weight)) then
            update bm.trucks set tare_weight = gross_weight, net_weight = 0, tare_auto = true where truck_id = t.truck_id;
        end if;
    elsif t.tare_auto then
        update bm.trucks set tare_weight = 0, net_weight = 0, tare_auto = false where truck_id = t.truck_id;
    end if;
end $function$
;

CREATE OR REPLACE FUNCTION bm.token_hash(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $function$
;

CREATE OR REPLACE FUNCTION bm.trg_exit_weight_lab()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare v_tid text;
begin
    select truck_id into v_tid from bm.trucks where sample1_barcode_id = new.sample1_barcode_id and bottom_of is null;
    if v_tid is not null then perform bm.sync_exit_weight(v_tid); end if;
    return null;
end $function$
;

CREATE OR REPLACE FUNCTION bm.trg_exit_weight_trucks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
    perform bm.sync_exit_weight(new.truck_id);
    return null;
end $function$
;

CREATE OR REPLACE FUNCTION bm.truck_composite(t bm.trucks, p_status text)
 RETURNS bm.composite_batches
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare bt bm.trucks; c bm.composite_batches;
begin
    select * into bt from bm.trucks where bottom_of = t.truck_id limit 1;
    if found then
        select * into c from bm.composite_batches where date = bt.entry_date and daily_group_code = bt.daily_group_code;
        return c;
    end if;
    if p_status = 'ACCEPTED' and not t.excluded_from_mix then
        select * into c from bm.composite_batches where date = t.entry_date and daily_group_code = t.daily_group_code;
    end if;
    return c;
end $function$
;

CREATE OR REPLACE FUNCTION bm.truck_status(t bm.trucks, m numeric)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select case when t.cancel_status = 'CANCELLED' then 'CANCELLED' when t.acceptance_override is not null then t.acceptance_override when t.bottom_of is not null then 'ACCEPTED' else bm.accept(m, t.lot) end $function$
;

CREATE OR REPLACE FUNCTION bm.truck_view(t bm.trucks)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
    r text := bm.role();
    l bm.lab1_results;
    base jsonb;
begin
    select * into l from bm.lab1_results where sample1_barcode_id = t.sample1_barcode_id;
    base := jsonb_build_object(
        'truck_id', t.truck_id, 'entry_date', t.entry_date, 'entry_time', t.entry_time,
        'company_name', t.company_name, 'driver_name', t.driver_name,
        'truck_reg_number', t.truck_reg_number,
        'invoice_no', coalesce(t.invoice_no, ''), 'challan_no', coalesce(t.invoice_no, ''),
        'po_number', t.po_number, 'lot', t.lot,
        'gross_weight', t.gross_weight, 'tare_weight', t.tare_weight, 'net_weight', t.net_weight,
        'has_photo', coalesce(t.photo_url, '') <> '');
    if r = 'admin' then
        return base || jsonb_build_object(
            'sample1_barcode_id', t.sample1_barcode_id, 'composite_barcode_id', coalesce(t.composite_barcode_id, ''),
            'daily_group_code', t.daily_group_code, 'created_by', t.created_by, 'created_at', t.created_at,
            'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value,
            'acceptance_status', bm.truck_status(t, l.moisture_pct),
            'is_bottom_sample', t.bottom_of is not null, 'bottom_of', t.bottom_of, 'excluded_from_mix', t.excluded_from_mix,
            'cancel_status', t.cancel_status, 'cancel_code', t.cancel_code, 'cancel_reason', t.cancel_reason, 'cancelled_by', t.cancelled_by, 'cancelled_at', t.cancelled_at,
            'acceptance_override', t.acceptance_override, 'override_reason', t.override_reason,
            'bottom_request', (select br.status from bm.bottom_requests br where br.truck_id = t.truck_id));
    elsif r in ('weighment', 'unloading') then
        -- NOTE: deliberately NO sample barcode, NO group code, NO composite code.
        -- The Unloading login additionally gets NO supplier name and NO PO number (a PO number identifies the supplier).
        if r = 'unloading' then base := base - 'company_name' - 'po_number' - 'lot'; end if;
        return base || jsonb_build_object(
            'moisture_pct', l.moisture_pct, 'fineness_value', l.fineness_value,
            'acceptance_status', bm.truck_status(t, l.moisture_pct),
            'cancel_status', t.cancel_status, 'cancel_code', t.cancel_code, 'cancel_reason', t.cancel_reason)
            || case when r = 'unloading' then jsonb_build_object('bottom_request', (select br.status from bm.bottom_requests br where br.truck_id = t.truck_id)) else '{}'::jsonb end;
    else
        return base;      -- entry: registration data only (no lab data, no codes)
    end if;
end $function$
;

CREATE OR REPLACE FUNCTION bm.uname()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select p.username from bm.profiles p where p.id = auth.uid() and p.active $function$
;

CREATE OR REPLACE FUNCTION bm.valid_examples(p jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$ select jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 400
          and not exists (select 1 from jsonb_array_elements_text(p) e where e !~ '^[0-9]{161}$') $function$
;

CREATE OR REPLACE FUNCTION bm.vkey(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select lower(regexp_replace(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')), '^(m\s*/\s*s\.?\s+)+', '', 'i')) $function$
;

set check_function_bodies = on;
