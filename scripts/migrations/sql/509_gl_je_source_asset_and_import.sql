-- Migration 509: admit four `source` values the code actually emits but
-- gl_journal_entries_source_check has always rejected.
--
-- These four are the ones being fixed here; they are NOT the complete set of
-- rejected literals. 'opening_balance' (pages/api/accounting/opening-balances),
-- 'bank_transfer' (pages/api/accounting/bank-transfers) and 'year_end'
-- (yearEndService.ts:228) are also rejected, so those three features are dead
-- too. They are deliberately NOT added here: each still writes its header
-- straight to status='posted' without validateJournalEntry, and
-- trg_gl_je_balanced is BEFORE UPDATE only — admitting the source would
-- un-gate an unvalidated path. Route them through createJournalEntry first,
-- then widen this constraint. ('auto_expense_receipt' below is included
-- precisely because receipt-to-journal.ts was converted in the same change.)
--
-- The four fixed here, each failing with 23514:
--
--   glCrossModuleHooks.postAssetDisposalToGL          -> 'asset_disposal'
--   glCrossModuleHooks.postCapitalizationExpenseToGL  -> 'asset_expense'
--   glImportExecuteService.importJournalEntries       -> 'import'
--   receipt-to-journal.ts / capture/[id]/post-expense -> 'auto_expense_receipt'
--
-- The two asset paths wrap the INSERT in a try/catch that logs and returns
-- null, so the failure was invisible: pages/api/accounting/assets/[assetId]/
-- dispose.ts still answered 200 with journalEntryId: null. Production carried
-- one disposed asset whose asset_disposals row has journal_entry_id IS NULL —
-- the asset left the register with no GL effect at all. The GL-import and
-- receipt-to-journal paths throw instead, so those two features were simply
-- broken.
--
-- The first three are renamed to the `auto_*` convention every other automated
-- source already follows (the services are updated in the same change);
-- 'auto_expense_receipt' already matches and keeps its spelling. This makes
-- GLEntrySource in src/modules/accounting/types/gl.types.ts a true mirror of
-- this constraint, which is what let the drift go unnoticed. No existing row
-- uses any of the four — none could ever have been written — so there is no
-- data to backfill.
--
-- The list below was built by reading the LIVE constraint (pg_get_constraintdef
-- on both dev and prod), not by extending migration 422's list, because the two
-- have drifted: 422 is the last migration in this repo that defines the
-- constraint and it omits 'auto_bank_transfer', yet both live databases accept
-- that value — it was added out-of-band at some point. bankAllocationService.ts
-- emits it for inter-account transfers, so had this migration extended 422's
-- text instead, it would have SILENTLY REVOKED a source that is in active use
-- and broken bank transfers. Restating the full live list makes a
-- migrations-only rebuild converge on what production actually enforces.
-- 'auto_loan_payment' is likewise already live and restated for the same reason.
--
-- Idempotent: the constraint is dropped IF EXISTS before being re-added.

ALTER TABLE gl_journal_entries
  DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;

ALTER TABLE gl_journal_entries
  ADD CONSTRAINT gl_journal_entries_source_check CHECK (
    source::text = ANY (ARRAY[
      'manual',
      'auto_invoice',
      'auto_payment',
      'auto_grn',
      'auto_credit_note',
      'auto_bank_recon',
      'auto_supplier_invoice',
      'auto_supplier_payment',
      'auto_write_off',
      'auto_adjustment',
      'auto_vat_adjustment',
      'auto_batch_payment',
      'auto_recurring',
      'auto_purchase_order',
      'auto_depreciation',
      'auto_payroll',
      'auto_migration',
      'auto_vat_submission',
      'auto_loan_payment',
      'auto_expense_claim',
      'auto_bank_transfer',
      'auto_asset_disposal',
      'auto_asset_expense',
      'auto_gl_import',
      'auto_expense_receipt'
    ]::text[])
  );
