-- 422_je_source_expense_claim.sql
-- PRD-05 Phase 10: Allow expense-claim-sourced journal entries.
--
-- gl_journal_entries.source has a CHECK constraint enumerating auto-* sources.
-- Expense claim posting needs its own tag so TB / drill-through can attribute
-- entries back to the claim that produced them (via .reference which already
-- carries the claim number).

ALTER TABLE gl_journal_entries
  DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;

ALTER TABLE gl_journal_entries
  ADD CONSTRAINT gl_journal_entries_source_check
  CHECK (source IN (
    'manual', 'auto_invoice', 'auto_payment', 'auto_grn', 'auto_credit_note',
    'auto_bank_recon', 'auto_supplier_invoice', 'auto_supplier_payment',
    'auto_write_off', 'auto_adjustment', 'auto_vat_adjustment',
    'auto_batch_payment', 'auto_recurring', 'auto_purchase_order',
    'auto_depreciation', 'auto_payroll', 'auto_migration',
    'auto_vat_submission', 'auto_loan_payment',
    'auto_expense_claim'
  ));
