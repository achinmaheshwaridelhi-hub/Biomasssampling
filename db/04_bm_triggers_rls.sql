-- Triggers and RLS on schema bm (live project). Trigger functions live in bm.* (bodies pending: Block F2/F3).
-- Create the bm.* functions BEFORE running the triggers.

-- Row level security: enabled on every bm table with NO policies, so direct table access is denied
-- for anon/authenticated; all access goes through the SECURITY DEFINER public.bm_* functions.
alter table bm.activity_logs enable row level security;
alter table bm.bottom_pw_fails enable row level security;
alter table bm.bottom_requests enable row level security;
alter table bm.companies enable row level security;
alter table bm.composite_batches enable row level security;
alter table bm.counters enable row level security;
alter table bm.known_ips enable row level security;
alter table bm.lab1_results enable row level security;
alter table bm.log_acks enable row level security;
alter table bm.mixing_groups enable row level security;
alter table bm.mixing_scans enable row level security;
alter table bm.profiles enable row level security;
alter table bm.qr_history enable row level security;
alter table bm.reader_templates enable row level security;
alter table bm.reader_training enable row level security;
alter table bm.recovery_fails enable row level security;
alter table bm.settings enable row level security;
alter table bm.trucks enable row level security;
alter table bm.trusted_devices enable row level security;
alter table bm.verified_sessions enable row level security;
alter table bm.voided_composites enable row level security;

-- Triggers
CREATE TRIGGER bm_logs_ro BEFORE DELETE OR UPDATE ON bm.activity_logs FOR EACH ROW EXECUTE FUNCTION bm.append_only();
CREATE TRIGGER bm_comp_nodel BEFORE DELETE ON bm.composite_batches FOR EACH ROW EXECUTE FUNCTION bm.no_delete();
CREATE TRIGGER bm_composite_guard BEFORE UPDATE ON bm.composite_batches FOR EACH ROW EXECUTE FUNCTION bm.composite_guard();
CREATE TRIGGER bm_lab1_copy AFTER INSERT OR UPDATE ON bm.lab1_results FOR EACH ROW EXECUTE FUNCTION bm.lab1_copy_trg();
CREATE TRIGGER bm_lab1_exit_weight AFTER INSERT OR UPDATE OF moisture_pct ON bm.lab1_results FOR EACH ROW EXECUTE FUNCTION bm.trg_exit_weight_lab();
CREATE TRIGGER bm_lab1_guard BEFORE UPDATE ON bm.lab1_results FOR EACH ROW EXECUTE FUNCTION bm.lab1_guard();
CREATE TRIGGER bm_lab1_nodel BEFORE DELETE ON bm.lab1_results FOR EACH ROW EXECUTE FUNCTION bm.no_delete();
CREATE TRIGGER bm_trucks_exit_weight AFTER UPDATE OF gross_weight, acceptance_override, cancel_status, lot ON bm.trucks FOR EACH ROW WHEN ((new.bottom_of IS NULL)) EXECUTE FUNCTION bm.trg_exit_weight_trucks();
CREATE TRIGGER bm_trucks_nodel BEFORE DELETE ON bm.trucks FOR EACH ROW EXECUTE FUNCTION bm.no_delete();
