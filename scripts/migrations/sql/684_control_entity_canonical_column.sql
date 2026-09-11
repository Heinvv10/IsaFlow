-- Retained control rows are matched by one canonical spelling of entity_id. Migrations 678/679 indexed that as
-- lower(entity_id), but lower() is not leakproof and these tables FORCE ROW LEVEL SECURITY: as app_user the planner
-- may not evaluate lower(entity_id)=... ahead of the tenant policy, so the expression indexes are never an index
-- condition and every lookup filters the whole company's rows (825 ms a journal on the risk population at 1M change
-- events). A stored generated column compared with plain text equality (leakproof) against a parameter, or against an
-- outer row's value inside a LATERAL/correlated subquery, stays an index condition under RLS. Compared in a plain join
-- with another relation's `uuid::text`, it does not (the cast is not leakproof either), so readers reach it through a
-- Param. It is lower(entity_id) by construction: every reader's semantics are unchanged.
--
-- Deploy cost: 678/679 are not on master, so the first production deploy builds their five expression indexes and
-- then drops them here. Each ADD COLUMN ... STORED rewrites its table and rebuilds that table's indexes under an ACCESS
-- EXCLUSIVE lock on all five hot control tables, held until the runner's single transaction commits: 3 min 36 s at
-- 33M change events and 3M entity versions (rewrite 166 s + index 39 s on control_change_events alone). OUT OF HOURS
-- ONLY. The 678/679 indexes are dropped FIRST so the rewrite does not rebuild them: after this migration no query
-- compares lower(entity_id) on these tables, so nothing can use them.
DROP INDEX IF EXISTS control_entity_versions_canonical_idx;
DROP INDEX IF EXISTS control_change_events_canonical_idx;
DROP INDEX IF EXISTS control_operation_effects_canonical_entity_idx;
DROP INDEX IF EXISTS control_operation_approvals_canonical_idx;
DROP INDEX IF EXISTS control_protected_evidence_canonical_idx;

ALTER TABLE control_entity_versions ADD COLUMN IF NOT EXISTS entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id)) STORED;
ALTER TABLE control_change_events ADD COLUMN IF NOT EXISTS entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id)) STORED;
ALTER TABLE control_operation_effects ADD COLUMN IF NOT EXISTS entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id)) STORED;
ALTER TABLE control_operation_approvals ADD COLUMN IF NOT EXISTS entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id)) STORED;
ALTER TABLE control_protected_evidence ADD COLUMN IF NOT EXISTS entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id)) STORED;

-- Same column order as the 678/679 indexes they replace. Plain CREATE INDEX: the runner wraps the file in one
-- transaction, where CONCURRENTLY cannot run.
CREATE INDEX IF NOT EXISTS control_entity_versions_entity_canonical_idx
 ON control_entity_versions(company_id,entity_type,entity_id_canonical);
-- The journal risk population reads each journal's retained changes, and its period's latest event, by the canonical
-- id ordered by occurred_at,id; the trailing columns let both be read in index order.
CREATE INDEX IF NOT EXISTS control_change_events_entity_canonical_idx
 ON control_change_events(company_id,entity_type,entity_id_canonical,occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS control_operation_effects_entity_canonical_idx
 ON control_operation_effects(company_id,operation,entity_type,entity_id_canonical);
CREATE INDEX IF NOT EXISTS control_operation_approvals_entity_canonical_idx
 ON control_operation_approvals(company_id,entity_type,entity_id_canonical,operation);
CREATE INDEX IF NOT EXISTS control_protected_evidence_entity_canonical_idx
 ON control_protected_evidence(company_id,entity_type,entity_id_canonical);
