-- Migration 853: code the VAT leg of posted customer-invoice journals.
-- 2026-10-05 | fix/vat201-blockers-20261005
--
-- postCustomerInvoiceToGL (ar/customerPaymentAllocationService) posted the
-- invoice's VAT Output leg with vat_type NULL. The pre-filing VAT exceptions
-- (query 1, "uncoded GL VAT lines") list every such line and
-- evaluateEfilingGate refuses the period — Velocity Fibre Jan–Aug 2026: 179
-- lines, the last blocking category. New invoices post the leg as 'standard';
-- this backfills the ones already posted. Twin of migration 703 (credit notes).
--
-- FIGURE-NEUTRAL, proven in tests/integration/customer-invoice-vat-code-backfill.int.test.ts:
-- the VAT201 classifies a tax leg by `vatType ?? 'standard'` (reports/vatBoxBasis),
-- the legacy getVATReturn puts an uncoded output leg in box 1 — the 'standard'
-- box — and journal membership keys on the account subtype, not the code. Every
-- VAT201 field, the lock snapshot figures and the membership are identical
-- before and after; only exception 1 changes.
--
-- Scope: ONLY lines on a `vat_output` account, still vat_type NULL, of a
-- customer invoice's journal (customer_invoices.gl_journal_entry_id) or a
-- reversal of it. Every join is company-scoped. No trigger forbids the UPDATE:
-- trg_gl_jl_balance_update recomputes balances from debit/credit/account, none
-- of which change. updated_at is stamped.
--
-- Re-runnable: the WHERE only matches lines still NULL.

WITH family AS (
  SELECT je.company_id, je.id
  FROM gl_journal_entries je
  JOIN customer_invoices ci ON ci.company_id = je.company_id
   AND ci.gl_journal_entry_id IS NOT NULL
   AND (je.id = ci.gl_journal_entry_id OR je.reversal_of_id = ci.gl_journal_entry_id)
)
UPDATE gl_journal_lines jl
SET vat_type = 'standard',
    updated_at = NOW()
FROM family f, gl_accounts ga
WHERE jl.journal_entry_id = f.id
  AND jl.company_id = f.company_id
  AND ga.id = jl.gl_account_id
  AND ga.company_id = jl.company_id
  AND ga.account_subtype = 'vat_output'
  AND jl.vat_type IS NULL;
