-- Migration 320: Account Reporting Groups
-- Allows custom grouping of GL accounts for financial report subtotals (Sage parity)

CREATE TABLE IF NOT EXISTS account_reporting_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  report_type VARCHAR(20) NOT NULL CHECK (report_type IN ('balance_sheet','income_statement','both')),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS account_reporting_group_members (
  group_id UUID NOT NULL REFERENCES account_reporting_groups(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, gl_account_id)
);

CREATE INDEX IF NOT EXISTS idx_arg_company ON account_reporting_groups(company_id);
CREATE INDEX IF NOT EXISTS idx_arg_company_active ON account_reporting_groups(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_argm_group ON account_reporting_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_argm_account ON account_reporting_group_members(gl_account_id);
