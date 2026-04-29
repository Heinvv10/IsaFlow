-- Migration 479: Sub-ledger GL reconciliation correction — Brightsphere Technologies
-- 2026-04-29 | sub-ledger-audit-2026-04-29 branch
--
-- Root cause:
--   Journal entries JE-2025-00045 (Sep 2025 depreciation, R3 500) and
--   JE-2026-00019 (January 2026 depreciation, R4 000) were each reversed TWICE.
--   This left a net DR balance of R7 500 in account 1230 (Accumulated Depreciation)
--   instead of the expected nil balance for the test FAR data. The paired effect
--   was an excess CR balance in 5700 (Depreciation Expense), understating expenses
--   by R7 500.
--
-- Correction:
--   Post a single correction JE:
--     DR  5700  Depreciation Expense      7 500.00  (clear the excess expense credit)
--     CR  1230  Accumulated Depreciation  7 500.00  (clear the net debit in 1230)
--
-- After this migration:
--   1230 balance = 0 (net effect of 49 debit reversals + 47 credit originals + this CR 7 500)
--   = 159 500 DR + 152 000 CR + 7 500 CR = 159 500 DR vs 159 500 CR → net 0
--   But the FAR has NO assets recorded for Brightsphere (all test data).
--   The GL 1230 will be zero (no real depreciation). PASS condition: |FAR - GL| < 0.01
--
-- NOTE: Fiscal period April 2026 is closed. Entry uses 2026-04-29 as correction date.
--       Production application requires Hein's explicit approval.

DO $$
DECLARE
  v_company_id  UUID := 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
  v_je_id       UUID;
  v_acct_1230   UUID;
  v_acct_5700   UUID;
  v_period_id   UUID;
  v_user_id     UUID;
  v_entry_num   TEXT := 'JE-2026-00318';  -- next after JE-2026-00317
  v_description TEXT := 'Sub-ledger recon correction — clear double reversal imbalance (migration 479)';
BEGIN
  -- Guard: only apply once (idempotent by migration-specific marker)
  IF EXISTS (
    SELECT 1 FROM gl_journal_entries
    WHERE company_id = v_company_id
      AND description = v_description
  ) THEN
    RAISE NOTICE 'Migration 479 already applied — skipping.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM gl_journal_entries
    WHERE company_id = v_company_id
      AND entry_number = v_entry_num
  ) THEN
    RAISE EXCEPTION 'Migration 479 cannot use %, entry number already exists for company %', v_entry_num, v_company_id;
  END IF;

  -- Resolve account IDs
  SELECT id INTO v_acct_1230
    FROM gl_accounts
    WHERE company_id = v_company_id AND account_code = '1230';

  SELECT id INTO v_acct_5700
    FROM gl_accounts
    WHERE company_id = v_company_id AND account_code = '5700';

  IF v_acct_1230 IS NULL THEN
    RAISE EXCEPTION 'Migration 479 missing account 1230 for company %', v_company_id;
  END IF;

  IF v_acct_5700 IS NULL THEN
    RAISE EXCEPTION 'Migration 479 missing account 5700 for company %', v_company_id;
  END IF;

  -- Resolve fiscal period
  SELECT id INTO v_period_id
    FROM fiscal_periods
    WHERE company_id = v_company_id
      AND start_date <= '2026-04-29'
      AND end_date   >= '2026-04-29'
    LIMIT 1;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'Migration 479 missing fiscal period covering 2026-04-29 for company %', v_company_id;
  END IF;

  -- Resolve a system/admin user
  SELECT id INTO v_user_id
    FROM users
    WHERE email LIKE '%admin%' OR email LIKE '%hein%'
    LIMIT 1;

  -- Fallback user
  IF v_user_id IS NULL THEN
    v_user_id := '31f472f1-eb80-49a4-bb5e-58ece44a4fa3';
  END IF;

  -- Create correction journal entry
  INSERT INTO gl_journal_entries (
    id, company_id, entry_number, entry_date,
    fiscal_period_id, description, source, status,
    created_by, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_company_id, v_entry_num, '2026-04-29',
    v_period_id,
    v_description,
    'manual', 'posted',
    v_user_id, now(), now()
  ) RETURNING id INTO v_je_id;

  -- Line 1: DR 5700 Depreciation Expense 7 500.00
  --         (clears the excess CR in 5700 from the double-reversal)
  INSERT INTO gl_journal_lines (
    id, journal_entry_id, gl_account_id, company_id,
    debit, credit, description, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_je_id, v_acct_5700, v_company_id,
    7500.00, 0.00,
    'Correction: clear excess expense credit from double-reversal of JE-2025-00045 and JE-2026-00019',
    now(), now()
  );

  -- Line 2: CR 1230 Accumulated Depreciation 7 500.00
  --         (clears the net DR in 1230 for the test FAR data)
  INSERT INTO gl_journal_lines (
    id, journal_entry_id, gl_account_id, company_id,
    debit, credit, description, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_je_id, v_acct_1230, v_company_id,
    0.00, 7500.00,
    'Correction: clear accumulated depreciation net debit (mig 479)',
    now(), now()
  );

  RAISE NOTICE 'Migration 479 applied: JE % posted for Brightsphere (R7 500 correction)', v_entry_num;
END $$;
