-- Migration 703: code the VAT leg of posted credit-note journals.
-- 2026-09-25 | fix/vat-support-and-variance-20260925
--
-- approveCreditNote (ar/creditNoteApproveService) posted its VAT leg — DR VAT
-- Output on a customer credit note, CR VAT Input on a supplier one — with
-- vat_type NULL. The pre-filing VAT exceptions (query 1, "uncoded GL VAT
-- lines") list every such line and evaluateEfilingGate refuses the period.
-- New credit notes post the leg as 'standard'; this backfills the ones already
-- posted (Hein, 2026-09-25: same treatment as expense claims, migration 702).
--
-- FIGURE-NEUTRAL, proven in tests/integration/credit-note-vat-code-backfill.int.test.ts:
-- the VAT201 classifies a tax leg by `vatType ?? 'standard'` on BOTH sides
-- (reports/vatBoxBasis), the legacy getVATReturn puts an uncoded output leg in
-- box 1 and an uncoded input leg in box 15 — the 'standard' boxes — and
-- journal membership keys on the account subtype, not the code. Every VAT201
-- field, the lock snapshot figures and the membership are identical before
-- and after; only exception 1 changes.
--
-- Scope: ONLY lines on a `vat_input` / `vat_output` account, still vat_type
-- NULL, of a credit note's journal (credit_notes.gl_journal_entry_id) or a
-- reversal of it. Every join is company-scoped. No trigger forbids the UPDATE:
-- trg_gl_jl_balance_update recomputes balances from debit/credit/account,
-- none of which change. updated_at is stamped.
--
-- Re-runnable: the WHERE only matches lines still NULL.

WITH family AS (
  SELECT je.company_id, je.id
  FROM gl_journal_entries je
  JOIN credit_notes cn ON cn.company_id = je.company_id
   AND cn.gl_journal_entry_id IS NOT NULL
   AND (je.id = cn.gl_journal_entry_id OR je.reversal_of_id = cn.gl_journal_entry_id)
)
UPDATE gl_journal_lines jl
SET vat_type = 'standard',
    updated_at = NOW()
FROM family f, gl_accounts ga
WHERE jl.journal_entry_id = f.id
  AND jl.company_id = f.company_id
  AND ga.id = jl.gl_account_id
  AND ga.company_id = jl.company_id
  AND ga.account_subtype IN ('vat_input', 'vat_output')
  AND jl.vat_type IS NULL;
