-- Migration 471: Add 2175 (Other Employee Deductions Payable),
-- 2215 (Current Portion of LT Debt), and 5810 (Interest Expense) for every tenant.
--
-- Background:
--   - 2175 is required by payrollJournalPostingService.ts (added in same change)
--     so that voluntary employee deductions (medical aid, pension, RA) get
--     credited to a payable instead of leaving the journal unbalanced.
--   - 2215 + 5810 are required by the loan amortisation engine — without them
--     loan period close + loan payments cannot post journals.
--
-- Pattern follows 347_auto_posting_foundation.sql: per-tenant insert with
-- NOT EXISTS guard so re-runs are safe and the tenant's existing accounts
-- are not duplicated.

-- ── 2175 Other Employee Deductions Payable ───────────────────────────────────
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2175', 'Other Employee Deductions Payable', 'liability', 'payroll_liability',
  'credit', 3, 218, true,
  -- Subtype matches siblings 2140/2150/2160/2170 (added in mig 347).
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2175'
);

-- ── 2215 Current Portion of Long-term Debt ──────────────────────────────────
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2215', 'Current Portion of LT Debt', 'liability', 'current_liability',
  'credit', 3, 219, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2215'
);

-- ── 5810 Interest Expense ───────────────────────────────────────────────────
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '5810', 'Interest Expense', 'expense', 'finance_cost',
  'debit', 3, 581, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '5000'),
  true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '5810'
);
