-- Migration 856: code the VAT leg of posted customer-invoice journals.
-- 2026-10-05 | fix/vat201-blockers-20261005
--
-- postCustomerInvoiceToGL (ar/customerInvoiceGlPosting) posted the invoice's
-- VAT Output leg with vat_type NULL. The pre-filing VAT exceptions (query 1,
-- "uncoded GL VAT lines") list every such line and evaluateEfilingGate refuses
-- the period — Velocity Fibre Jan–Aug 2026: 179 lines, the last blocking
-- category. New invoices post the leg as 'standard'; this backfills the ones
-- already posted. Twin of migration 703 (credit notes).
--
-- VAT201-NEUTRAL, proven in tests/integration/customer-invoice-vat-code-backfill.int.test.ts:
-- the VAT201 classifies a tax leg by `vatType ?? 'standard'` (reports/vatBoxBasis),
-- the legacy getVATReturn puts an uncoded output leg in box 1 — the 'standard'
-- box — and journal membership keys on the account subtype, not the code. Every
-- VAT201 field, the lock snapshot figures and the membership are identical
-- before and after; only exception 1 changes. It also writes inside VAT
-- periods that are already locked (filed): the filed figures do not move, for
-- the same reason. NOT neutral everywhere: the VAT reconciliation's
-- other_output bucket (vatReconciliationService query 4, `vat_type <>
-- 'capital_goods'`) dropped NULL lines and now counts them, which corrects it;
-- a custom report grouped by vat_type moves these lines from NULL to standard.
--
-- Scope: ONLY lines on a `vat_output` account, still vat_type NULL, in the
-- reversal family of a customer invoice's journal. The roots are
--   (a) the journal an invoice links (customer_invoices.gl_journal_entry_id), and
--   (b) an auto_invoice journal named 'Customer invoice <number>' for an
--       invoice of the same company — cancelling an invoice reverses its
--       journal and then NULLs the link (customerInvoiceCancelService), so a
--       cancelled invoice's pair is reachable only by that name (the match
--       scripts/fixes/reverse-cancelled-invoice-journals.ts uses).
-- The family is every journal that reverses a member, recursively, so a
-- reversal of a reversal is coded too. receiptToJournalService also posts as
-- auto_invoice ('Receipt: …'); the vat_output filter and the name keep it out.
-- The name match also reaches a cancelled invoice's journal that was never
-- reversed (scripts/fixes/reverse-cancelled-invoice-journals.ts lists those
-- for review): its leg is coded too, so it leaves the uncoded-line exception
-- while still standing in the ledger. Return figures do not change; isaflow_dev
-- has 0 such journals. Check a database before applying with the SELECT in
-- that script (cancelled invoice, name-matched posted journal, reversed_at NULL).
-- Every join is company-scoped. No trigger forbids the UPDATE:
-- trg_gl_jl_balance_update recomputes balances from debit/credit/account, none
-- of which change. updated_at is stamped.
--
-- Re-runnable: the WHERE only matches lines still NULL.

WITH RECURSIVE roots AS (
  SELECT ci.company_id, ci.gl_journal_entry_id AS id
  FROM customer_invoices ci
  WHERE ci.gl_journal_entry_id IS NOT NULL
  UNION
  SELECT je.company_id, je.id
  FROM gl_journal_entries je
  JOIN customer_invoices ci
    ON ci.company_id = je.company_id
   AND je.description = ('Customer invoice ' || ci.invoice_number)
  WHERE je.source = 'auto_invoice'
), family AS (
  SELECT company_id, id FROM roots
  UNION
  SELECT r.company_id, r.id
  FROM gl_journal_entries r
  JOIN family f ON f.id = r.reversal_of_id AND f.company_id = r.company_id
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
