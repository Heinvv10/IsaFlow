-- 1024_customer_quote_line_vat.sql
-- Per-line VAT on customer quotes (per-line VAT programme, 2026-11-19), the columns migration 1008 gave customer
-- invoices: a quote line carries its own VAT TYPE and the VAT it charges, so one quote can mix standard, zero-rated and
-- exempt supplies and converts to an invoice whose lines carry the same types and figures.
--
-- WHAT.
--   customer_quote_lines.vat_type    TEXT NULL: the line's VAT type, in the ledger's spelling (VatType, gl.types).
--   customer_quote_lines.tax_amount  NUMERIC(15,2) NULL: the VAT the line charges, rounded on the line
--                                    (shared/vatLineAmounts). Both NULL or both set (CHECK below).
--   customer_quotes.amounts_are      TEXT NULL: 'exclusive' | 'inclusive', how the lines' UNIT PRICES were entered.
--                                    NULL reads as exclusive. A line's amount is its NET on every quote.
-- A line is TYPED when vat_type and tax_amount are set. NULL is a legacy document-rate quote (or one written for a
-- company not registered for VAT), which reads, prints and converts exactly as before: nothing is backfilled, so no
-- stored quote is re-priced. The vat_type CHECK is the ledger's full list, as 1008's
-- (tests/unit/services/ar/customerQuoteLineVatCheck.test.ts pins it to VatType); what a quote line may be WRITTEN with
-- is narrower (shared/vatTypes DOCUMENT_LINE_VAT_TYPES).
--
-- Backwards compatible: nullable columns with no default, so the colour still serving old code keeps writing NULL.
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on customer_quote_lines and customer_quotes for a catalogue-only change,
-- held to this file's COMMIT; each CHECK is added NOT VALID, then VALIDATEd over all-NULL columns (the 1008 convention).
--
-- Rollback (code first, only while no line is typed): drop the three CHECKs and the three columns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.customer_quote_lines ADD COLUMN IF NOT EXISTS vat_type TEXT NULL;
ALTER TABLE public.customer_quote_lines ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NULL;
ALTER TABLE public.customer_quotes ADD COLUMN IF NOT EXISTS amounts_are TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_quote_lines_vat_type_check'
                    AND conrelid = 'public.customer_quote_lines'::regclass) THEN
    ALTER TABLE public.customer_quote_lines ADD CONSTRAINT customer_quote_lines_vat_type_check
      CHECK (vat_type IS NULL OR vat_type IN ('standard', 'zero_rated', 'exempt', 'capital_goods', 'export', 'imported',
                                              'reverse_charge', 'bad_debt', 'no_vat')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_quote_lines_vat_type_tax_amount_pair'
                    AND conrelid = 'public.customer_quote_lines'::regclass) THEN
    ALTER TABLE public.customer_quote_lines ADD CONSTRAINT customer_quote_lines_vat_type_tax_amount_pair
      CHECK ((vat_type IS NULL) = (tax_amount IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_quotes_amounts_are_check'
                    AND conrelid = 'public.customer_quotes'::regclass) THEN
    ALTER TABLE public.customer_quotes ADD CONSTRAINT customer_quotes_amounts_are_check
      CHECK (amounts_are IS NULL OR amounts_are IN ('exclusive', 'inclusive')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.customer_quote_lines VALIDATE CONSTRAINT customer_quote_lines_vat_type_check;
ALTER TABLE public.customer_quote_lines VALIDATE CONSTRAINT customer_quote_lines_vat_type_tax_amount_pair;
ALTER TABLE public.customer_quotes VALIDATE CONSTRAINT customer_quotes_amounts_are_check;

COMMENT ON COLUMN public.customer_quote_lines.vat_type IS
  'The line''s VAT type (ledger spelling, gl.types VatType). Set with tax_amount or not at all. NULL: a legacy document-rate line (migration 1024).';
COMMENT ON COLUMN public.customer_quote_lines.tax_amount IS
  'The VAT the line charges, rounded on the line (shared/vatLineAmounts). Set with vat_type or not at all (migration 1024).';
COMMENT ON COLUMN public.customer_quotes.amounts_are IS
  'exclusive | inclusive: how the lines'' unit prices were entered; a line''s amount is its net either way. NULL reads as exclusive (migration 1024).';
