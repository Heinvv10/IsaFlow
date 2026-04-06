-- Migration 291: Add company_id to sars_submissions for multi-tenant isolation
-- Without this column, any authenticated user can read/modify all companies' SARS submissions.

ALTER TABLE sars_submissions ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Backfill: assign orphan submissions to default company (safe for existing data)
-- In production, submissions without company_id should be reviewed manually.
UPDATE sars_submissions SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE sars_submissions ALTER COLUMN company_id SET NOT NULL;

-- Index for company-scoped queries
CREATE INDEX IF NOT EXISTS idx_sars_submissions_company ON sars_submissions(company_id);

-- Also add company_id to sars_compliance_events if missing
ALTER TABLE sars_compliance_events ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
UPDATE sars_compliance_events SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE sars_compliance_events ALTER COLUMN company_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sars_compliance_events_company ON sars_compliance_events(company_id);
