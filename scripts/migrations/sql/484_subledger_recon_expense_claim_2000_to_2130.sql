-- Migration 484: Reclassify expense-claim reimbursement-due credits from
--                 parent account 2000 → leaf account 2130 (Accrued Expenses).
--
-- 2026-04-29 | Phase 5 follow-up | sub-ledger recon for ISAFlow Demo (prod)
--
-- == Diagnosis (from mig 480 Q3 run against prod 'isaflow' DB) ==
-- The Phase 8 reports-health audit reported a Balance Sheet imbalance of
-- R694.64 on the live tenant app (https://app.isaflow.co.za) for the
-- ISAFlow Demo company. mig 480's Q3 diagnostic identified the source as
-- two journal lines posted DIRECTLY to parent account 2000 (Liabilities
-- header, level=1) instead of to a leaf liability account:
--
--   JE-2026-00878  2026-04-21  CR 232.32  src=auto_expense_claim  CL-2026-0002
--   JE-2026-00879  2026-04-21  CR 462.32  src=auto_expense_claim  CL-2026-0003
--   ─────────────────────────────────────
--   Total                       694.64
--
-- The Balance Sheet calculation excludes parent accounts (level<3 with
-- children), so these credits never made it into the BS Liabilities total.
-- Trial balance still balances because the offsetting DR sides landed on
-- valid leaf accounts. Result: BS shows Assets > (Liab + Equity) by R694.64.
--
-- == Root cause ==
-- The expense-claim post handler (POST /api/accounting/expense-claims/[id]/post)
-- accepts reimbursementAccountId from the request body without validating
-- that it points to a LEAF account of type 'liability'. The UI account
-- selector evidently included parent header 2000 as a selectable option,
-- and CL-2026-0002 / CL-2026-0003 were posted with that as the target.
-- A defensive validation (reject parents and non-liability types) lands
-- separately in the same fixup branch as this migration.
--
-- == Correction ==
-- Reclassify the two offending journal lines from gl_accounts(code=2000)
-- to gl_accounts(code=2130, "Accrued Expenses", subtype=other_current_liability) —
-- the closest semantic match for an employee reimbursement liability that
-- exists in the seeded chart of accounts.
--
-- Idempotent: only acts on JE entry_numbers where the line still points
-- at account 2000. Re-running after correction does nothing.
--
-- Cross-environment: on databases where these JE numbers don't exist
-- (e.g. dev `isaflow_dev`), the count is 0 and the migration is a no-op.

DO $$
DECLARE
  v_company_id   UUID := '00000000-0000-0000-0000-000000000001';
  v_acct_2000_id UUID;
  v_acct_2130_id UUID;
  v_target_count INT;
  v_updated_count INT;
BEGIN
  SELECT id INTO v_acct_2000_id
    FROM gl_accounts
    WHERE company_id = v_company_id AND account_code = '2000';

  SELECT id INTO v_acct_2130_id
    FROM gl_accounts
    WHERE company_id = v_company_id AND account_code = '2130';

  IF v_acct_2000_id IS NULL THEN
    RAISE NOTICE 'Migration 484: account 2000 not found for company % — skipping (likely a non-prod DB without the demo seed).', v_company_id;
    RETURN;
  END IF;

  IF v_acct_2130_id IS NULL THEN
    RAISE EXCEPTION 'Migration 484: leaf account 2130 not found for company % — cannot reclassify safely.', v_company_id;
  END IF;

  -- Count lines to fix (idempotency guard).
  SELECT COUNT(*) INTO v_target_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
   WHERE jl.company_id = v_company_id
     AND jl.gl_account_id = v_acct_2000_id
     AND je.entry_number IN ('JE-2026-00878', 'JE-2026-00879')
     AND je.source = 'auto_expense_claim'
     AND je.status = 'posted';

  IF v_target_count = 0 THEN
    RAISE NOTICE 'Migration 484: no journal lines match the reclassification target — skipping (already fixed, or DB does not contain these JEs).';
    RETURN;
  END IF;

  IF v_target_count <> 2 THEN
    RAISE EXCEPTION 'Migration 484: expected 2 lines to reclassify, found % — refusing to proceed (data may have changed).', v_target_count;
  END IF;

  -- Reclassify the two lines.
  WITH updated AS (
    UPDATE gl_journal_lines jl
       SET gl_account_id = v_acct_2130_id
      FROM gl_journal_entries je
     WHERE je.id = jl.journal_entry_id
       AND jl.company_id = v_company_id
       AND jl.gl_account_id = v_acct_2000_id
       AND je.entry_number IN ('JE-2026-00878', 'JE-2026-00879')
       AND je.source = 'auto_expense_claim'
       AND je.status = 'posted'
    RETURNING jl.id
  )
  SELECT COUNT(*) INTO v_updated_count FROM updated;

  RAISE NOTICE 'Migration 484: reclassified % journal lines from account 2000 to account 2130 (R694.64 total).', v_updated_count;
END $$;
