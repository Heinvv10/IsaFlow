-- Migration 392: Loan compliance — NCA in-duplum + IFRS 9 ECL staging
-- Tracks compliance assessments per loan over time.

CREATE TABLE IF NOT EXISTS loan_compliance_assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  loan_id          uuid NOT NULL REFERENCES loans(id),
  assessment_date  date NOT NULL,
  nca_flagged      boolean DEFAULT false,
  nca_period       integer,
  ifrs9_stage      integer CHECK (ifrs9_stage IN (1, 2, 3)),
  days_past_due    integer DEFAULT 0,
  ecl_amount       numeric(18,2) DEFAULT 0,
  ecl_method       text,                         -- '12m' | 'lifetime' | 'full'
  outstanding      numeric(18,2),
  notes            text,
  assessed_by      uuid,
  assessed_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_compliance_company_loan_idx
  ON loan_compliance_assessments (company_id, loan_id, assessed_at DESC);

CREATE INDEX IF NOT EXISTS loan_compliance_stage_idx
  ON loan_compliance_assessments (company_id, ifrs9_stage);
