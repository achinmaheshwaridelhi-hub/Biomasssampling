-- Indexes NOT created implicitly by the PK/UNIQUE constraints in 02_bm_constraints.sql.
-- (bm_companies_vid_uq and trusted_devices_user_token_uq are standalone unique indexes, not constraints.)
create unique index bm_companies_vid_uq on bm.companies using btree (vid);
create unique index trusted_devices_user_token_uq on bm.trusted_devices using btree (user_id, token_hash);
create index bm_mixing_scans_grp_idx on bm.mixing_scans using btree (entry_date, group_code);
create index bm_trucks_date_idx on bm.trucks using btree (entry_date);
create index bm_trucks_group_idx on bm.trucks using btree (entry_date, daily_group_code);
