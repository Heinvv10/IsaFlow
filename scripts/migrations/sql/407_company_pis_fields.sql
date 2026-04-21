-- 407_company_pis_fields.sql
-- Add Public Interest Score input fields to companies table
-- These enable full PIS calculation per Regulation 26(2) of Companies Act 71 of 2008

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS employee_count_beginning INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employee_count_end       INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shareholder_count         INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS all_shareholders_are_directors BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS nature_of_business        TEXT,
  ADD COLUMN IF NOT EXISTS registered_address        TEXT,
  ADD COLUMN IF NOT EXISTS entity_type               VARCHAR(10) DEFAULT 'pty'
    CHECK (entity_type IN ('pty', 'cc', 'trust'));

COMMENT ON COLUMN companies.employee_count_beginning IS 'Headcount at start of financial year — PIS component';
COMMENT ON COLUMN companies.employee_count_end       IS 'Headcount at end of financial year — PIS component';
COMMENT ON COLUMN companies.shareholder_count         IS 'Number of shareholders/members — PIS component';
COMMENT ON COLUMN companies.all_shareholders_are_directors IS 'If true and PIS < 100, no review/audit required';
COMMENT ON COLUMN companies.entity_type               IS 'pty = Private Company, cc = Close Corporation, trust = Trust';
