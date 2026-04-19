-- 378_practice_jobs.sql
-- Client-linked work packages with status workflow.

CREATE TABLE IF NOT EXISTS practice_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  practice_client_id   UUID NOT NULL REFERENCES practice_clients(id),
  job_category_id      UUID REFERENCES practice_job_categories(id),
  title                TEXT NOT NULL,
  description          TEXT,
  partner_id           UUID,
  preparer_id          UUID,
  due_date             DATE,
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','in_progress','review','approved','billed','complete','cancelled')),
  financial_year       TEXT,
  billing_type         TEXT CHECK (billing_type IN ('hourly','fixed','retainer')),
  budgeted_hours       NUMERIC(8,2),
  fixed_fee_amount     NUMERIC(18,2),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pj_company_client ON practice_jobs(company_id, practice_client_id);
CREATE INDEX IF NOT EXISTS idx_pj_company_status ON practice_jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pj_company_partner ON practice_jobs(company_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_pj_company_due ON practice_jobs(company_id, due_date);
