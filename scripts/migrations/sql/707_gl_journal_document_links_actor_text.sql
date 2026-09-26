-- 707: gl_journal_document_links.linked_by / unlinked_by are UUID, but
-- users.id is character varying(255) (000_users_and_auth.sql) — the same
-- mismatch 704 (vat_gate_overrides) and 705 (vat_declared_elsewhere) were
-- written as TEXT to avoid. 706 already shipped with `::UUID` binds and is
-- APPLIED on isaflow_dev, so this migration corrects it in place rather than
-- editing 706 (never edit an applied migration).
--
-- Guarded on the column's CURRENT type so re-running this file, or running it
-- after a fresh 706 that already used TEXT, is a no-op either way. No index
-- or RLS policy references either column (the unique/lookup indexes are on
-- company_id/captured_document_id/journal_entry_id; the tenant_isolation
-- policy filters on company_id only), so neither survives changing type by
-- accident — there is nothing to rebuild.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gl_journal_document_links'
      AND column_name = 'linked_by' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE gl_journal_document_links ALTER COLUMN linked_by TYPE TEXT USING linked_by::TEXT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gl_journal_document_links'
      AND column_name = 'unlinked_by' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE gl_journal_document_links ALTER COLUMN unlinked_by TYPE TEXT USING unlinked_by::TEXT;
  END IF;
END $$;
