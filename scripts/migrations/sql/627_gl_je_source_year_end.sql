-- Migration 627: admit `source = 'year_end'` on gl_journal_entries.
--
-- yearEndCloseService.postClosingJournal has always written 'year_end', which
-- gl_journal_entries_source_check has never accepted, so EVERY year-end close
-- of EVERY company aborted with 23514 at the header INSERT before a single
-- line was attempted. The whole close runs inside withTransaction, so nothing
-- partial was ever written — the damage is the ABSENCE of closing journals:
-- retained earnings is a computed residual and fiscal periods that should be
-- locked are not.
--
-- Migration 509 deliberately left this value out, and said why: the close
-- INSERTs its header straight at status='posted' without validateJournalEntry,
-- and trg_gl_je_balanced is BEFORE UPDATE only, so the constraint was the only
-- thing standing between an unvalidated writer and the ledger. That condition
-- is now met from the other side rather than by keeping the feature dead:
-- postClosingJournal runs validateJournalEntry over the preview lines before
-- the transaction opens (same check createJournalEntry runs), and refuses an
-- unbalanced or negative-sided journal. Conversion to
-- createJournalEntry/postJournalEntry is not available here — the close
-- requires every period CLOSED and postJournalEntry refuses any period that is
-- not OPEN.
--
-- 'opening_balance' and 'bank_transfer' remain deliberately excluded on the
-- original 509 grounds; their writers are still unconverted and unvalidated.
--
-- The list below restates the LIVE constraint (pg_get_constraintdef, verified
-- against the production-schema fixture) plus 'year_end', for the reason 509
-- gives: this constraint has drifted from the migrations before and extending
-- an older migration's text would silently revoke a source in active use.
--
-- No existing row can carry 'year_end' — none could ever have been written —
-- so there is nothing to backfill.
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
      'auto_expense_receipt',
      'year_end'
    ]::text[])
  );
