# Database (Supabase) - Biomass Procurement

Reconstructed from the live project `jarfhyraxjvtimradvbp` (schema only, no records, no secrets).

## Run order (SQL Editor, one file at a time)
1. `00_extensions.sql`
2. `01_bm_tables.sql`            - schema `bm`: tables
3. `02_bm_constraints.sql`       - keys, foreign keys, checks
4. `03_bm_indexes.sql`
5. `05_bm_functions.sql`         - helper functions in `bm` (needed before the triggers)
6. `04_bm_triggers_rls.sql`      - row level security + triggers
7. `06` ... `10_public_functions_*.sql` - the `public.bm_*` functions the website calls
8. `11_grants_storage.sql`       - who may call what, plus the private `evidence` bucket
9. `12_passwords.sql`           - recoverable action passwords (Vault key), the Admin edit password, viewing passwords

## Migrations (changes made after the first export)
`migrations/` holds one SQL file per change, named by date. Files 00-11 above already include every migration, so a **new** project needs only 00-11.
An **existing** project (the live one) runs just the migration files it has not run yet, in date order, each in the Supabase SQL Editor:
* `migrations/2026-11-03_lot4a.sql` - adds the lot **Lot 4A** (same rules as Lot 4). Run it BEFORE publishing the website files that offer Lot 4A.
* `migrations/2026-11-04_admin_edit_password.sql` - Lot 4 <-> Lot 4A vendor switch with history, the **Admin edit password** for lab-value corrections, and password viewing for the Super Admin. Run it AFTER the Lot 4A migration.

`90_legacy_public_tables.sql` is the old v1 schema in `public` (kept for reference; the site does not use it).

## Not included (must be done by hand on a fresh project)
- Logins: create users in Supabase Auth, then a row for each in `bm.profiles` (id = auth user id, username, role, name).
  Roles: superadmin, admin, entry, weighment, unloading, lab1, lab1m, lab1f, lab2.
- Secrets/settings in `bm.settings` (action password hash/salt, recovery code, mfa_required, super_lock ...): set from the
  Super Admin screens, never from this repo.
- Data: use Supabase backups; this folder is structure only.
- Auth settings (MFA/TOTP, email provider), and the front-end `SUPABASE_URL` / anon key in `api.js`.

## Note
Files were exported with `pg_get_functiondef` / catalog queries and have not been executed on a blank project yet;
test the run order on a new empty Supabase project before relying on it for disaster recovery.
