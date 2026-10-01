-- Migration 702: code the VAT Input leg of posted expense-claim journals.
-- 2026-09-25 | fix/vat-support-and-variance-20260925
--
-- expenseClaimService.postClaimToGl posted its VAT Input leg with vat_type
-- NULL. The pre-filing VAT exceptions (query 1, "uncoded GL VAT lines") list
-- every such line, and evaluateEfilingGate refuses a period with any
-- exception, so every period holding a posted expense claim was unfilable.
-- New claims post the leg as 'standard'; this backfills the ones already
-- posted (Hein chose a backfill over a carve-out in the exceptions query).
--
-- FIGURE-NEUTRAL, and proven so in
-- tests/integration/expense-claim-vat-code-backfill.int.test.ts: the VAT201
-- classifies a tax leg by `vatType ?? 'standard'` (reports/vatBoxBasis), the
-- legacy getVATReturn puts an uncoded input leg in box 15 as it does
-- 'standard', and journal membership keys on the account subtype, not the
-- code. So every VAT201 field, the lock snapshot figures and the membership
-- are the same before and after; only exception 1 changes.
--
-- Scope: ONLY lines on a `vat_input` account, still vat_type NULL, of a
-- journal descended from an expense claim's posting — the claim's own journal
-- (expense_claims.posted_je_id), its late-claim companion (late_claim_of_id,
-- whose VAT Input leg copies the original's NULL), and a reversal of either.
-- Every join is company-scoped. No trigger forbids the UPDATE: the only
-- trigger on gl_journal_lines (trg_gl_jl_balance_update) recomputes balances
-- from debit/credit/account, none of which change. updated_at is stamped.
--
-- Re-runnable: the WHERE only matches lines still NULL.

WITH claim_je AS (
  SELECT ec.company_id, ec.posted_je_id AS id
  FROM expense_claims ec
  WHERE ec.posted_je_id IS NOT NULL
), family AS (
  SELECT je.company_id, je.id
  FROM gl_journal_entries je
  JOIN claim_je c ON c.company_id = je.company_id
   AND (je.id = c.id OR je.late_claim_of_id = c.id OR je.reversal_of_id = c.id)
  UNION
  SELECT r.company_id, r.id
  FROM gl_journal_entries r
  JOIN gl_journal_entries lc ON lc.id = r.reversal_of_id AND lc.company_id = r.company_id
  JOIN claim_je c ON c.company_id = lc.company_id AND lc.late_claim_of_id = c.id
)
UPDATE gl_journal_lines jl
SET vat_type = 'standard',
    updated_at = NOW()
FROM family f, gl_accounts ga
WHERE jl.journal_entry_id = f.id
  AND jl.company_id = f.company_id
  AND ga.id = jl.gl_account_id
  AND ga.company_id = jl.company_id
  AND ga.account_subtype = 'vat_input'
  AND jl.vat_type IS NULL;
