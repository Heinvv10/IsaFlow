-- 443_schema_drift_cleanup.sql
-- Reconcile Supabase-cutover drift surfaced by the schema-drift audit:
--   * Retire dunning_communications — replaced by dunning_templates /
--     dunning_sends stack shipped in PRD-06 Phase 5.
--   * Add is_active flag on customer_categories / supplier_categories —
--     old schema had it, the restored tables in 441 omitted it. Clients
--     may reference it for soft-delete rows.
--   * Add bank_import_batches.filename — legacy callers referenced this
--     name; the restored 442 schema called it source_filename. Keep both
--     so neither caller shape has to change.

-- Drop the dead legacy table if any stub remains
DROP TABLE IF EXISTS dunning_communications CASCADE;

-- Soft-delete flags on the category tables
ALTER TABLE customer_categories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE supplier_categories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Legacy filename field on bank_import_batches
ALTER TABLE bank_import_batches
  ADD COLUMN IF NOT EXISTS filename TEXT;

-- Keep source_filename in sync via a generated default for new rows —
-- callers may populate either name.
COMMENT ON COLUMN bank_import_batches.filename
  IS 'Legacy alias for source_filename — kept because older callers reference this name.';
