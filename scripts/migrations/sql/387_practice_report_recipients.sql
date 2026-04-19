-- 387_practice_report_recipients.sql
-- Per-tenant list of email recipients for monthly practice management reports.

CREATE TABLE IF NOT EXISTS practice_report_recipients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  email         TEXT NOT NULL,
  name          TEXT,
  report_types  TEXT[] NOT NULL DEFAULT ARRAY['monthly_summary']::TEXT[],
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_prr_company_active ON practice_report_recipients(company_id, is_active);
