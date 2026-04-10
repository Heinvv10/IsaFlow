-- 285_cc_bu_dimensions.sql
-- Cost Centre & Business Unit dimension system

-- 1. Add cc_type column to cost_centres (cc1 = client-level, cc2 = project-level)
ALTER TABLE cost_centres ADD COLUMN IF NOT EXISTS cc_type VARCHAR(10) DEFAULT 'cc1';
ALTER TABLE cost_centres ADD COLUMN IF NOT EXISTS department VARCHAR(100);

-- Update unique constraint to be per company+cc_type+code
DROP INDEX IF EXISTS uq_cost_centres_company_code;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_type_code
  ON cost_centres(company_id, cc_type, code);

-- 2. Add cc1_id, cc2_id, bu_id to gl_journal_lines
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS cc1_id UUID;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS cc2_id UUID;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS bu_id UUID;

-- Backfill: copy existing cost_center_id to cc1_id
UPDATE gl_journal_lines SET cc1_id = cost_center_id
  WHERE cost_center_id IS NOT NULL AND cc1_id IS NULL;

-- Indexes for dimension filtering
CREATE INDEX IF NOT EXISTS idx_jl_cc1 ON gl_journal_lines(cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jl_cc2 ON gl_journal_lines(cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jl_bu ON gl_journal_lines(bu_id) WHERE bu_id IS NOT NULL;

-- 3. Create business_units table
CREATE TABLE IF NOT EXISTS business_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_business_units_company ON business_units(company_id);
