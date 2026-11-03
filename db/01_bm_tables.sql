-- Schema bm tables, reconstructed from live project jarfhyraxjvtimradvbp (columns, types, nulls, defaults).
-- Primary keys / foreign keys / checks / indexes: see 02_bm_constraints.sql (pending Block C2/D2).
-- Identity columns (confirmed on the live DB): activity_logs.id, recovery_fails.id, reader_templates.version, reader_training.id, trusted_devices.id (all GENERATED ALWAYS).
create schema if not exists bm;

create table bm.activity_logs (
  id bigint generated always as identity,
  "timestamp" text not null,
  username text not null, action text not null,
  details text not null default ''::text,
  created_at timestamptz not null default now(),
  ip text, device text, device_name text, device_id bigint
);
create sequence if not exists bm.bottom_pw_fails_id_seq;
create table bm.bottom_pw_fails (
  id bigint not null default nextval('bm.bottom_pw_fails_id_seq'::regclass),
  username text not null, at timestamptz not null default now()
);
create table bm.bottom_requests (
  truck_id text not null, requested_by text not null,
  requested_at timestamptz not null default now(),
  requested_date date not null, requested_time text not null,
  reason text, status text not null default 'REQUESTED'::text,
  generated_by text, generated_at timestamptz, bottom_truck_id text
);
create sequence if not exists bm.companies_vid_seq;
create table bm.companies (
  name text not null, po_number text,
  created_at timestamptz not null default now(),
  lot text not null default 'LOT2/3'::text,
  active boolean not null default true,
  retired_at timestamptz, retired_by text,
  vid bigint not null default nextval('bm.companies_vid_seq'::regclass)
);
create table bm.composite_batches (
  composite_ref_id text not null, composite_barcode_id text not null,
  company_name text, date date not null, daily_group_code text not null,
  parent_truck_ids jsonb not null default '[]'::jsonb,
  gcv_value numeric(8,2), ash_pct numeric(6,2),
  tested_by text, tested_at text,
  test_lot text not null, referee_lot text not null, vendor_lot text not null,
  system_samples_count integer, mixed_samples_count integer,
  vendor_gcv numeric(8,2), referee_gcv numeric(8,2),
  referee_status text, referee_updated_at text,
  created_at timestamptz not null default now(),
  lot text,
  ad_moisture numeric(10,4), ad_gcv numeric(10,4), ad_ash numeric(10,4),
  ad_sulphur numeric(10,4), ad_vm numeric(10,4),
  tm_value numeric, x_factor numeric,
  arb_sulphur numeric(10,2), arb_vm numeric(10,2)
);
create table bm.counters (
  name text not null, day date not null, n integer not null default 0
);
create table bm.known_ips (
  ip text not null, label text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  seen_count bigint not null default 1,
  last_user text, last_action text, device text,
  labelled_by text, labelled_at timestamptz
);
create table bm.lab1_results (
  sample1_barcode_id text not null,
  moisture_pct numeric(6,3), fineness_value numeric(6,2),
  tested_by text, tested_at text,
  moisture_by text, moisture_at text, moisture_photo text,
  fineness_by text, fineness_at text,
  fineness_initial_weight numeric(8,3), fineness_final_weight numeric(8,3),
  fineness_initial_photo text, fineness_final_photo text,
  created_at timestamptz not null default now()
);
create table bm.log_acks (
  log_id bigint not null, acked_by text not null,
  acked_at timestamptz not null default now()
);
create table bm.mixing_groups (
  entry_date date not null, company_name text not null,
  group_code text not null, lot text not null default 'LOT2/3'::text
);
create table bm.mixing_scans (
  sample1_barcode_id text not null, entry_date date not null,
  group_code text not null, scanned_by text not null,
  scanned_at timestamptz not null default now(), scanned_time text not null
);
create table bm.profiles (
  id uuid not null,              -- = auth.users.id
  username text not null, role text not null, name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  mfa_exempt boolean not null default false,
  device_lock boolean not null default false
);
create sequence if not exists bm.qr_history_id_seq;
create table bm.qr_history (
  id bigint not null default nextval('bm.qr_history_id_seq'::regclass),
  truck_id text not null, old_barcode text not null, new_barcode text not null,
  changed_by text not null, changed_at timestamptz not null default now(), reason text
);
create table bm.reader_templates (
  version integer generated always as identity, created_at timestamptz not null default now(),
  created_by text, note text, sample_count integer not null default 0,
  examples jsonb not null, active boolean not null default false
);
create table bm.reader_training (
  id bigint generated always as identity,
  created_at timestamptz not null default now(),
  kind text not null, value numeric not null, conf numeric, photo text not null,
  sample1_barcode_id text, submitted_by text,
  status text not null default 'PENDING'::text,
  used_version integer, examples jsonb
);
create table bm.recovery_fails (
  id bigint generated always as identity,
  uid uuid not null, at timestamptz not null default now()
);
create table bm.settings (
  key text not null, value text not null, updated_at timestamptz not null default now()
);
create table bm.trucks (
  truck_id text not null, company_name text not null, driver_name text,
  truck_reg_number text not null, invoice_no text, po_number text,
  entry_date date not null, entry_time text,
  gross_weight numeric(12,3) not null default 0,
  tare_weight numeric(12,3) not null default 0,
  net_weight numeric(12,3) not null default 0,
  sample1_barcode_id text not null, composite_barcode_id text,
  daily_group_code text not null,
  acceptance_status text not null default 'PENDING'::text,
  photo_url text, created_by text,
  created_at timestamptz not null default now(),
  lot text not null default 'LOT2/3'::text,
  bottom_of text, excluded_from_mix boolean not null default false,
  cancel_status text, cancel_code text, cancel_reason text,
  cancelled_by text, cancelled_at timestamptz,
  acceptance_override text, override_reason text,
  tare_auto boolean not null default false
);
create table bm.trusted_devices (
  id bigint generated always as identity,
  user_id uuid not null, name text not null, token_hash text not null,
  status text not null default 'PENDING'::text,
  requested_at timestamptz not null default now(),
  approved_by text, approved_at timestamptz, last_seen timestamptz,
  last_ip text, agent text, site text
);
create table bm.verified_sessions (
  session_id text not null, user_id uuid not null, device_id bigint,
  verified_at timestamptz not null default now()
);
create sequence if not exists bm.voided_composites_id_seq;
create table bm.voided_composites (
  id bigint not null default nextval('bm.voided_composites_id_seq'::regclass),
  composite_ref_id text not null, snapshot jsonb not null,
  voided_by text not null, voided_at timestamptz not null default now(), reason text
);
