-- LEGACY v1 tables in schema public (old version, not used by the bm_* functions). Kept for reference only.
create table public.activity_logs (
  id uuid not null default gen_random_uuid(),
  "timestamp" text not null,
  username text, action text, details text,
  created_at timestamptz default now()
);
create table public.companies (
  id uuid not null default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now(),
  po_number text, po_description text
);
create table public.composite_batches (
  id uuid not null default gen_random_uuid(),
  composite_ref_id text not null,
  composite_barcode_id text, company_name text, date date,
  parent_truck_ids jsonb default '[]'::jsonb,
  gcv_value numeric, ash_pct numeric,
  tested_by text, tested_at text, test_lot text, referee_lot text, vendor_lot text,
  system_samples_count integer, mixed_samples_count integer,
  daily_group_code text, vendor_gcv numeric, referee_gcv numeric,
  referee_status text, referee_updated_at text,
  created_at timestamptz default now()
);
create table public.lab1_results (
  id uuid not null default gen_random_uuid(),
  sample1_barcode_id text not null,
  moisture_pct numeric, fineness_value numeric,
  tested_by text, tested_at text,
  moisture_by text, moisture_at text, fineness_by text, fineness_at text,
  fineness_initial_weight numeric, fineness_final_weight numeric,
  fineness_initial_photo text, fineness_final_photo text,
  created_at timestamptz default now()
);
create table public.trucks (
  id uuid not null default gen_random_uuid(),
  truck_id text not null, company_name text not null,
  driver_name text, truck_reg_number text, invoice_no text, challan_no text,
  entry_date date, entry_time text, photo_url text,
  gross_weight numeric default 0, tare_weight numeric default 0, net_weight numeric default 0,
  sample1_barcode_id text, composite_barcode_id text, created_by text,
  daily_group_code text, acceptance_status text default 'PENDING',
  created_at timestamptz default now(),
  weighment_photo_url text
);
create table public.users (
  id uuid not null default gen_random_uuid(),
  username text not null, password text not null, role text not null, name text not null,
  created_at timestamptz default now()
);
