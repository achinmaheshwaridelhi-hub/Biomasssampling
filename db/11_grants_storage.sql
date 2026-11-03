-- Permissions and Storage, from the live project. Run LAST (after 01-10).
--
-- Model: the browser only ever calls public.bm_* functions (SECURITY DEFINER). Schema bm and its tables
-- are not granted to anon/authenticated at all (RLS is on, with no policies).

-- Schema bm: owner only (no usage for anon / authenticated / service_role)
revoke all on schema bm from public, anon, authenticated, service_role;

-- Functions: no access for PUBLIC / anon; signed-in users (authenticated) and service_role may execute.
do $$
declare f record;
begin
    for f in select p.oid::regprocedure as sig
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'bm\_%'
    loop
        execute format('revoke all on function %s from public, anon', f.sig);
        execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end loop;
end $$;

-- Storage: private bucket for photo evidence (3 MB, jpeg / png / webp)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 3145728, '{image/jpeg,image/png,image/webp}')
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = '{image/jpeg,image/png,image/webp}';

create policy bm_evidence_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'evidence' and public.bm_storage_role() = any (array['admin','entry','lab1','lab1m','lab1f']));
create policy bm_evidence_select on storage.objects for select to authenticated
    using (bucket_id = 'evidence' and public.bm_storage_role() = 'admin');
create policy bm_evidence_delete on storage.objects for delete to authenticated
    using (bucket_id = 'evidence' and public.bm_storage_role() = 'admin');
