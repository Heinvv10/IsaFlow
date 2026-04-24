-- 442_bank_import_batches.sql
-- Restore bank_import_batches lost in the Supabase cutover. Used by:
--   /api/accounting/bank-import-batches (Statement Balance Widget feed)
--   /api/accounting/bank-reconciliation-report (opening/closing balance)
-- Both readers; no live writer today. Restoring the table means the widget
-- renders an empty state instead of the current silent swallow-to-500.
-- Writers will appear when the batch-ingest flow is rebuilt; the schema
-- matches what the readers SELECT.

CREATE TABLE IF NOT EXISTS bank_import_batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id    UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  statement_date     DATE NOT NULL,
  bank_format        TEXT,
  opening_balance    NUMERIC(18, 2),
  closing_balance    NUMERIC(18, 2),
  transaction_count  INT NOT NULL DEFAULT 0,
  source_filename    TEXT,
  imported_by        TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_import_batches_company_acct_created
  ON bank_import_batches(company_id, bank_account_id, created_at DESC);

CREATE OR REPLACE FUNCTION bank_import_batches_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bank_import_batches_touch ON bank_import_batches;
CREATE TRIGGER trg_bank_import_batches_touch
  BEFORE UPDATE ON bank_import_batches
  FOR EACH ROW EXECUTE FUNCTION bank_import_batches_touch_updated_at();

ALTER TABLE bank_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_import_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_import_batches;
CREATE POLICY tenant_isolation ON bank_import_batches
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_import_batches TO app_user;
