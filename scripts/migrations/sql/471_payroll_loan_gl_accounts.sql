-- Migration 471: Add 2175 (Other Employee Deductions Payable),
-- 2215 (Current Portion of LT Debt), and 5810 (Interest Expense) for every tenant.
--
-- Background:
--   - 2175 is required by payrollJournalPostingService.ts (added in same PR)
--     so that voluntary employee deductions (medical aid, pension, RA) get
--     credited to a payable instead of leaving the journal unbalanced. The
--     service treats 2175 as optional and only requires it when residual
--     deductions > 0.005, so tenants where this migration hasn't run yet
--     can still post statutory-only payroll runs without 2175.
--   - 2215 + 5810 are required by the loan amortisation engine — without them
--     loan period close + loan payments cannot post journals.
--
-- Pattern follows 347_auto_posting_foundation.sql: per-tenant insert with
-- NOT EXISTS guard so re-runs are safe and the tenant's existing accounts
-- are not duplicated.
--
-- Tenants without parent codes 2100 (current liabilities) or 5000 (expenses)
-- are skipped — `parent_account_id` is nullable in the schema, so without a
-- guard the migration would silently insert orphan accounts that don't
-- appear under their group on the trial balance / balance sheet.

-- ── 2175 Other Employee Deductions Payable ───────────────────────────────────
-- Subtype matches siblings 2140/2150/2160/2170 (added in mig 347).
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, parent_account_id, is_active
)
SELECT
  c.id, '2175', 'Other Employee Deductions Payable', 'liability', 'payroll_liability',
  'credit', 3, 218, true,
  (SELECT id FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'),
  true
FROM companies c
WHERE NOT EXISTS (
        SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2175'
      )
  AND EXISTS (
        SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'
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
      )
  AND EXISTS (
        SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2100'
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
      )
  AND EXISTS (
        SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '5000'
      );

-- ── Diagnostic: log skipped tenants (missing parent codes) ──────────────────
-- This block runs after the inserts so the log shows the tenants that need
-- their parent CoA seeded before mig 471 takes effect for them.
DO $$
DECLARE
  missing_2100 INT;
  missing_5000 INT;
BEGIN
  SELECT COUNT(*) INTO missing_2100
  FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '2100');

  SELECT COUNT(*) INTO missing_5000
  FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE company_id = c.id AND account_code = '5000');

  IF missing_2100 > 0 OR missing_5000 > 0 THEN
    RAISE NOTICE 'mig 471: % tenant(s) missing CoA parent 2100, % missing 5000 — skipped 2175/2215 (and 5810 for the 5000-missing set). These tenants need their CoA seeded before mig 471 takes effect.', missing_2100, missing_5000;
  END IF;
END $$;
