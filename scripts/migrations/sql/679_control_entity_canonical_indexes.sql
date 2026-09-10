-- Retained control rows are matched by one canonical spelling of entity_id, which the exact-text
-- primary key and entity indexes cannot serve. control_entity_versions is the hot one: every
-- controlled operation reads it, often several times per transaction.
-- These are plain CREATE INDEX statements because the migration runner wraps each file in one
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Each build takes a
-- SHARE lock and blocks writes to that table until it finishes, so run this migration out of hours,
-- or build the same indexes by hand with CONCURRENTLY first and let these become no-ops.
CREATE INDEX IF NOT EXISTS control_entity_versions_canonical_idx
 ON control_entity_versions(company_id,entity_type,lower(entity_id));
CREATE INDEX IF NOT EXISTS control_change_events_canonical_idx
 ON control_change_events(company_id,entity_type,lower(entity_id),occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS control_protected_evidence_canonical_idx
 ON control_protected_evidence(company_id,entity_type,lower(entity_id));
CREATE INDEX IF NOT EXISTS control_operation_approvals_canonical_idx
 ON control_operation_approvals(company_id,entity_type,lower(entity_id),operation);
