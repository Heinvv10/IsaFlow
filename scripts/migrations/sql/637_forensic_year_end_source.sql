-- The controlled year-close writer creates a draft and uses shared posting.
-- This source label grants no authority; the live parent permit and final closed
-- period relationship are required for the narrow year-close posting exception.
-- Preserve the complete source population from migration509.
ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;
ALTER TABLE gl_journal_entries ADD CONSTRAINT gl_journal_entries_source_check CHECK (
 source::text = ANY (ARRAY[
  'manual', 'auto_invoice', 'auto_payment', 'auto_grn', 'auto_credit_note',
  'auto_bank_recon', 'auto_supplier_invoice', 'auto_supplier_payment',
  'auto_write_off', 'auto_adjustment', 'auto_vat_adjustment', 'auto_batch_payment',
  'auto_recurring', 'auto_purchase_order', 'auto_depreciation', 'auto_payroll',
  'auto_migration', 'auto_vat_submission', 'auto_loan_payment', 'auto_expense_claim',
  'auto_bank_transfer', 'auto_asset_disposal', 'auto_asset_expense',
  'auto_gl_import', 'auto_expense_receipt', 'year_end'
 ]::text[])
);
