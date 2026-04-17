-- 347_auto_posting_foundation.sql
-- Foundation for automatic double-entry posting from invoices, bills, payroll,
-- and bank allocations.
--
-- Does three things:
--   1. Adds payroll control accounts (PAYE / UIF / SDL Payable, Salary Clearing) per company.
--   2. Backfills fiscal_period_id on orphan journal entries (previously posted with NULL)
--      by matching entry_date against the company's fiscal_periods range.
--   3. Adds a supporting index + a report notice for any entries that still cannot be
--      matched (entry_date outside any defined fiscal period).
--
-- The gl_accounts (company_id, account_code) unique index is on a nullable column,
-- so ON CONFLICT inference does not work. We use WHERE NOT EXISTS guards instead.

-- ── 1. Payroll control accounts (per company) ──────────────────────────────

INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2140', 'PAYE Payable', 'liability', 'payroll_liability',
  'credit', 3, 214, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2140'
);

INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2150', 'UIF Payable', 'liability', 'payroll_liability',
  'credit', 3, 215, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2150'
);

INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2160', 'SDL Payable', 'liability', 'payroll_liability',
  'credit', 3, 216, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2160'
);

INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2170', 'Net Salaries Payable', 'liability', 'payroll_liability',
  'credit', 3, 217, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2170'
);

-- ── 2. Backfill fiscal_period_id on orphan journal entries ─────────────────

UPDATE gl_journal_entries je
SET fiscal_period_id = fp.id,
    updated_at = NOW()
FROM fiscal_periods fp
WHERE je.fiscal_period_id IS NULL
  AND fp.company_id = je.company_id
  AND je.entry_date BETWEEN fp.start_date AND fp.end_date;

-- ── 3. Supporting index ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_gl_je_company_date
  ON gl_journal_entries(company_id, entry_date);

-- ── 4. Safety report: surface any JEs that still have NULL period ──────────

DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM gl_journal_entries
  WHERE fiscal_period_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE NOTICE '347_auto_posting_foundation: % journal entries still have NULL fiscal_period_id (entry_date outside any defined fiscal period).', orphan_count;
  END IF;
END $$;
