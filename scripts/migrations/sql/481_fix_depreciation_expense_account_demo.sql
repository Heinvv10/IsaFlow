-- Migration 481: Fix depreciation_expense system account misconfiguration — ISAFlow Demo
-- 2026-04-29 | sub-ledger-audit-2026-04-29 branch
--
-- Root cause:
--   Account 5800 (Insurance Expense) in ISAFlow Demo (Pty) Ltd was configured with
--   account_subtype = 'depreciation_expense' and is_system_account = true.
--   This caused the asset FAR module to post monthly depreciation charges to
--   Insurance Expense (5800) rather than a proper Depreciation Expense account.
--   As a result, the income statement shows R229 724.99 in "Insurance Expense" that
--   is actually depreciation. The underlying depreciation journal entries (DR 5800,
--   CR 1230) are structurally correct (trial balance stays balanced) but are
--   misclassified on the income statement.
--
-- Correction:
--   1. Create a new "Depreciation Expense" account (5820) with the correct subtype.
--   2. Clear the incorrect subtype from 5800 (restore it as a plain insurance expense).
--   3. Do NOT reclassify historical journal entries — they are correct entries to 5800
--      for demo purposes. For production, a separate reclassification is needed.
--
-- NOTE: Production application requires Hein's explicit approval.
--       This migration is idempotent (safe to re-run).

DO $$
DECLARE
  v_company_id    UUID := '00000000-0000-0000-0000-000000000001';
  v_user_id       UUID;
  v_acct_5820_id  UUID;
  v_parent_5000   UUID;
BEGIN
  -- Get admin user
  SELECT id INTO v_user_id FROM users
    WHERE email LIKE '%admin%' OR email LIKE '%hein%'
    LIMIT 1;
  IF v_user_id IS NULL THEN
    v_user_id := '31f472f1-eb80-49a4-bb5e-58ece44a4fa3';
  END IF;

  -- Resolve parent account 5000 (Expenses root) for CoA hierarchy
  SELECT id INTO v_parent_5000
    FROM gl_accounts
    WHERE company_id = v_company_id AND account_code = '5000';

  IF v_parent_5000 IS NULL THEN
    RAISE EXCEPTION 'Migration 481: parent account 5000 not found for demo company — cannot insert orphan account 5820';
  END IF;

  -- Step 1: Clear wrong subtype from 5800 (Insurance Expense)
  -- Only clear if it still has the wrong subtype
  UPDATE gl_accounts
     SET account_subtype   = 'insurance_expense',
         is_system_account = false,
         updated_at        = now()
   WHERE company_id     = v_company_id
     AND account_code   = '5800'
     AND account_subtype = 'depreciation_expense';

  IF FOUND THEN
    RAISE NOTICE 'Fixed: 5800 Insurance Expense subtype cleared (was depreciation_expense).';
  ELSE
    RAISE NOTICE 'Skip: 5800 already has correct subtype.';
  END IF;

  -- Step 2: Create 5820 Depreciation Expense with correct subtype
  IF NOT EXISTS (
    SELECT 1 FROM gl_accounts
     WHERE company_id = v_company_id AND account_code = '5820'
  ) THEN
    INSERT INTO gl_accounts (
      id, company_id,
      account_code, account_name, account_type, account_subtype,
      normal_balance, level, display_order, is_active, is_system_account,
      parent_account_id,
      created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_company_id,
      '5820', 'Depreciation Expense', 'expense', 'depreciation_expense',
      'debit', 3, 582, true, true,
      v_parent_5000,
      now(), now()
    ) RETURNING id INTO v_acct_5820_id;

    RAISE NOTICE 'Created: 5820 Depreciation Expense (id=%).', v_acct_5820_id;
  ELSE
    -- Ensure existing 5820 has the correct subtype, level, and parent if it exists
    UPDATE gl_accounts
       SET account_subtype   = 'depreciation_expense',
           is_system_account = true,
           level             = 3,
           parent_account_id = v_parent_5000,
           updated_at        = now()
     WHERE company_id = v_company_id
       AND account_code = '5820'
       AND (account_subtype IS DISTINCT FROM 'depreciation_expense'
            OR is_system_account IS DISTINCT FROM true
            OR level IS DISTINCT FROM 3
            OR parent_account_id IS DISTINCT FROM v_parent_5000);

    IF FOUND THEN
      RAISE NOTICE 'Migration 481: patched stale 5820 record.';
    ELSE
      RAISE NOTICE 'Migration 481: 5820 already up-to-date — no changes.';
    END IF;
  END IF;

  RAISE NOTICE 'Migration 481 complete: depreciation_expense system account now points to 5820 for ISAFlow Demo.';
END $$;
