-- 969: tax_return_versions (master plan wave 5, L1a).
--
-- WHAT. One row per finalised VAT201 or EMP201 for a period: the figures as they
-- stood when somebody finalised the return, and the version chain an amendment
-- builds. A VAT201 version points at the vat_period_locks row it created (the
-- lock stays the thing that stops the period moving); an EMP201 version records
-- the pay runs it summed and their approved_plan_hash. Filing, amending and
-- superseding are L1b: this migration only creates the table and lets the app
-- insert finalised rows.
--
-- RULES IN THE DATABASE.
--   - version_no = 1 exactly when amends_version_id IS NULL.
--   - At most one non-superseded version per company, form and period.
--   - The amend stamps (amended_by, amend_reason, amended_at) are written on the
--     SUPERSEDED row at amend time; all three or none, a reason never blank, and
--     only a superseded row carries them.
--   - A VAT201 version names its lock; an EMP201 version names none.
--   - users.id is character varying: the actor columns are TEXT, never UUID.
--
-- WRITES. app_user may SELECT and INSERT named columns only: id and the stamps
-- take their defaults (a writable stamp gets forged). No UPDATE or DELETE: L1b
-- grants the columns an amend or a filing writes. History is never deleted.
--
-- Rollback: DROP TABLE tax_return_versions (nothing references it).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS tax_return_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  form_type TEXT NOT NULL CHECK (form_type IN ('VAT201', 'EMP201')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  status TEXT NOT NULL DEFAULT 'finalised' CHECK (status IN ('finalised', 'filed', 'superseded')),
  -- VAT201: output, input, net (from the lock row) and sarsFields (the report boxes).
  -- EMP201: generateEMP201's figures plus runs [{id, approvedPlanHash}].
  figures JSONB NOT NULL,
  -- VAT201: the lock's posted_through. EMP201: the latest approved_at among the runs.
  posted_through TIMESTAMPTZ NOT NULL,
  vat_period_lock_id UUID REFERENCES vat_period_locks(id),
  sars_submission_id UUID REFERENCES sars_submissions(id),
  filed_reference TEXT,
  amends_version_id UUID REFERENCES tax_return_versions(id),
  finalised_by TEXT NOT NULL,
  finalised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  filed_by TEXT,
  filed_at TIMESTAMPTZ,
  amended_by TEXT,
  amend_reason TEXT,
  amended_at TIMESTAMPTZ,
  CONSTRAINT tax_return_versions_period_ck CHECK (period_end >= period_start),
  CONSTRAINT tax_return_versions_chain_ck CHECK ((version_no = 1) = (amends_version_id IS NULL)),
  CONSTRAINT tax_return_versions_lock_ck CHECK ((form_type = 'VAT201') = (vat_period_lock_id IS NOT NULL)),
  CONSTRAINT tax_return_versions_amend_ck CHECK (
    (amended_at IS NULL AND amended_by IS NULL AND amend_reason IS NULL)
    OR (status = 'superseded' AND amended_at IS NOT NULL AND amended_by IS NOT NULL
        AND amend_reason IS NOT NULL AND btrim(amend_reason) <> '')
  ),
  CONSTRAINT tax_return_versions_filed_ck CHECK (
    (filed_at IS NULL AND filed_by IS NULL) OR (filed_at IS NOT NULL AND filed_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_version
  ON tax_return_versions (company_id, form_type, period_start, period_end, version_no);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_one_current
  ON tax_return_versions (company_id, form_type, period_start, period_end)
  WHERE status <> 'superseded';

CREATE INDEX IF NOT EXISTS idx_tax_return_versions_lock
  ON tax_return_versions (vat_period_lock_id) WHERE vat_period_lock_id IS NOT NULL;

ALTER TABLE tax_return_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_return_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tax_return_versions;
CREATE POLICY tenant_isolation ON tax_return_versions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

GRANT SELECT ON tax_return_versions TO app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tax_return_versions FROM app_user;
GRANT INSERT (company_id, form_type, period_start, period_end, version_no, status, figures, posted_through,
  vat_period_lock_id, amends_version_id, finalised_by) ON tax_return_versions TO app_user;
