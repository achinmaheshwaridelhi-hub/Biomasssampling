-- Action passwords the Super Admin can SEE (recoverable) + the new "Admin edit password".   Run after 01-11.
--
-- * The Unloading actions password and the Admin edit password are still checked through a salted hash (fast, as before).
--   Next to the hash an ENCRYPTED copy is kept (pgcrypto, key in Supabase Vault) so that the Super Admin can reveal it.
--   Revealing needs: the Super Admin login, the login password (checked here), AND an authenticator code typed within the last 2 minutes.
-- * Login passwords are never stored in a readable form and are not part of this.
set check_function_bodies = off;

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

set check_function_bodies = on;

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
