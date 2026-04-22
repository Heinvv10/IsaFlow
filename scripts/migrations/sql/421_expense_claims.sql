-- 421_expense_claims.sql
-- PRD-05 Phase 10: Employee expense claims + mileage.
--
-- Claims flow: draft → submitted → approved/rejected → posted. Approval
-- reuses the existing approval_requests engine. Posting creates a GL
-- journal entry plus (optionally) a payroll earning line for reimbursement.
-- Every line carries a source_document_id pointing at the captured slip —
-- preserving the evidence-first ledger contract.

CREATE TABLE IF NOT EXISTS expense_claims (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES payroll_employees(id),
  claim_number        TEXT NOT NULL,                   -- per-company sequential (CL-2026-0001)
  claim_date          DATE NOT NULL,
  title               TEXT,                            -- "April 2026 travel"
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','approved','rejected','posted','paid','cancelled')),
  total_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_vat           NUMERIC(18,2) NOT NULL DEFAULT 0,
  approved_by         TEXT,                            -- users.id is TEXT
  approved_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  approval_request_id UUID REFERENCES approval_requests(id),
  posted_je_id        UUID REFERENCES gl_journal_entries(id),
  posted_at           TIMESTAMPTZ,
  payment_payroll_run_id UUID,                         -- FK added if/when payroll_runs is linked
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at        TIMESTAMPTZ,
  UNIQUE (company_id, claim_number)
);

CREATE INDEX IF NOT EXISTS idx_expense_claims_company_status
  ON expense_claims(company_id, status);
CREATE INDEX IF NOT EXISTS idx_expense_claims_employee
  ON expense_claims(company_id, employee_id, claim_date DESC);

CREATE TABLE IF NOT EXISTS expense_claim_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  company_id              UUID NOT NULL REFERENCES companies(id),
  line_date               DATE NOT NULL,
  description             TEXT,
  merchant                TEXT,
  amount                  NUMERIC(18,2) NOT NULL DEFAULT 0,  -- incl VAT
  vat_amount              NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat_code                TEXT,
  gl_account_id           UUID REFERENCES gl_accounts(id),
  cost_centre_id          UUID,
  project_id              UUID,
  source_document_id      UUID REFERENCES captured_documents(id) ON DELETE SET NULL,
  -- Mileage
  km_travelled            NUMERIC(10,2),
  km_rate                 NUMERIC(8,4),                 -- SARS 2026 prescribed rate = 4.84/km
  mileage_from            TEXT,
  mileage_to              TEXT,
  mileage_route           JSONB,                        -- optional GPS trace from PWA
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_lines_claim
  ON expense_claim_lines(claim_id);
CREATE INDEX IF NOT EXISTS idx_expense_lines_source_doc
  ON expense_claim_lines(source_document_id) WHERE source_document_id IS NOT NULL;

-- Trigger: keep claims' updated_at + aggregates fresh
CREATE OR REPLACE FUNCTION expense_claims_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_claims_touch ON expense_claims;
CREATE TRIGGER trg_expense_claims_touch
  BEFORE UPDATE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION expense_claims_touch_updated_at();

-- Seed the SARS-prescribed rate on the companies table so the UI can default it
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sars_km_rate NUMERIC(8,4) NOT NULL DEFAULT 4.84;
