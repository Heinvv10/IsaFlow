-- 901: a SARS directive paid in a payroll run (audit 2026-10-18 P3).
--
-- Severance (3901) is now paid in the pay run at its directive's figures, and
-- the run records the directive as consumed in the directive's one
-- tax_directive_payments row (UNIQUE (company_id, tax_directive_id), 403), so
-- the stand-alone payment (taxDirectivePaymentService) and any other run are
-- refused it. Such a row carries payroll_run_id and NO journal of its own: the
-- gross and PAYE are in the run's journal, through its header totals.
-- Writer: src/modules/accounting/services/payroll/payrollRunDirectiveClaim.ts,
-- at run approval, inside the approval's locks.
--
-- Additive only: one nullable column, its FK, one CHECK, one index. Existing
-- rows are stand-alone payments (payroll_run_id NULL) and satisfy the CHECK.
-- The FK and CHECK are added NOT VALID and validated here: the column is new,
-- so there is nothing to scan but a table of directive payments.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_tax_directive_payments_run;
--   ALTER TABLE tax_directive_payments DROP CONSTRAINT IF EXISTS tax_directive_payments_run_has_no_journal;
--   ALTER TABLE tax_directive_payments DROP CONSTRAINT IF EXISTS tax_directive_payments_payroll_run_id_fkey;
--   ALTER TABLE tax_directive_payments DROP COLUMN IF EXISTS payroll_run_id;
SET LOCAL lock_timeout = '5s';

ALTER TABLE tax_directive_payments ADD COLUMN IF NOT EXISTS payroll_run_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_directive_payments_payroll_run_id_fkey') THEN
    ALTER TABLE tax_directive_payments
      ADD CONSTRAINT tax_directive_payments_payroll_run_id_fkey
      FOREIGN KEY (payroll_run_id) REFERENCES payroll_run_headers(id) NOT VALID;
  END IF;
  -- A run's claim is booked by the run's journal; a second journal on the row would book it twice.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_directive_payments_run_has_no_journal') THEN
    ALTER TABLE tax_directive_payments
      ADD CONSTRAINT tax_directive_payments_run_has_no_journal
      CHECK (payroll_run_id IS NULL OR journal_entry_id IS NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE tax_directive_payments VALIDATE CONSTRAINT tax_directive_payments_payroll_run_id_fkey;
ALTER TABLE tax_directive_payments VALIDATE CONSTRAINT tax_directive_payments_run_has_no_journal;

CREATE INDEX IF NOT EXISTS idx_tax_directive_payments_run
  ON tax_directive_payments (company_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;
