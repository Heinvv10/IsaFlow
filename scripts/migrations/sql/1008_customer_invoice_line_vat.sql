-- 1008_customer_invoice_line_vat.sql
-- Per-line VAT on customer invoices, the COLUMNS (per-line VAT programme, 2026-11-19). A line may carry its own VAT
-- TYPE and the VAT it charges, so one invoice can mix standard, zero-rated and exempt supplies and each posts to its
-- own VAT201 field. This PR adds the columns and teaches the readers (GL posting, credit-note legs, PDF, detail GET,
-- VAT reports) to read them; NOTHING WRITES THEM YET. Writers come in the next PR.
--
-- WHAT.
--   customer_invoice_items.vat_type    TEXT NULL: the line's VAT type, in the ledger's spelling (VatType, gl.types).
--   customer_invoice_items.tax_amount  NUMERIC(15,2) NULL: the VAT the line charges, rounded on the line
--                                      (shared/vatLineAmounts). Both NULL or both set (CHECK below).
--   customer_invoices.amounts_are      TEXT NULL: 'exclusive' | 'inclusive', how the lines' UNIT PRICES were entered.
--                                      NULL reads as exclusive. A line's amount is its NET on every invoice.
-- A line is TYPED when vat_type and tax_amount are set; an invoice is typed when every line is. NULL is a legacy
-- document-rate invoice, which reads, prints and posts exactly as before. Nothing is backfilled.
-- The vat_type CHECK is the ledger's full list (gl.types VatType; tests/unit/services/ar/customerInvoiceLineVatCheck.test.ts
-- pins the two together). What a customer invoice line may POST is narrower (ar/invoiceVatLegs POSTABLE_LINE_VAT_TYPES).
--
-- TWO FILES (PR #1648 review M1). This file only adds the columns; 1009 makes them approval content (the digest
-- replace, its snapshot and the re-bind across every company). Together they held ACCESS EXCLUSIVE on both invoice
-- tables for the whole digest work, so every read of an invoice by the live app waited for it. The runner applies each
-- file in its own transaction (scripts/lib/migrationFiles.applyOne: BEGIN, the file, its schema_migrations row,
-- COMMIT), so this one's locks end at its COMMIT and 1009 takes only 923's SHARE locks. Code deployed between the two
-- (the old colour, or a stop after this file) is safe: old and new code both leave the columns NULL.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on customer_invoice_items and customer_invoices for a catalogue-only change
-- (nullable, no default), held to this file's COMMIT; each CHECK is added NOT VALID, then VALIDATEd (the 999a / 999o
-- convention) over all-NULL columns. A column that already exists with data breaking a CHECK fails the VALIDATE and
-- the file rolls back whole. Bounded below.
--
-- Rollback (code first, and 1009's first, only while no line is typed): drop the three CHECKs and the three columns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS vat_type TEXT NULL;
ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NULL;
ALTER TABLE public.customer_invoices ADD COLUMN IF NOT EXISTS amounts_are TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_invoice_items_vat_type_check'
                    AND conrelid = 'public.customer_invoice_items'::regclass) THEN
    ALTER TABLE public.customer_invoice_items ADD CONSTRAINT customer_invoice_items_vat_type_check
      CHECK (vat_type IS NULL OR vat_type IN ('standard', 'zero_rated', 'exempt', 'capital_goods', 'export', 'imported',
                                              'reverse_charge', 'bad_debt', 'no_vat')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_invoice_items_vat_type_tax_amount_pair'
                    AND conrelid = 'public.customer_invoice_items'::regclass) THEN
    ALTER TABLE public.customer_invoice_items ADD CONSTRAINT customer_invoice_items_vat_type_tax_amount_pair
      CHECK ((vat_type IS NULL) = (tax_amount IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_invoices_amounts_are_check'
                    AND conrelid = 'public.customer_invoices'::regclass) THEN
    ALTER TABLE public.customer_invoices ADD CONSTRAINT customer_invoices_amounts_are_check
      CHECK (amounts_are IS NULL OR amounts_are IN ('exclusive', 'inclusive')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.customer_invoice_items VALIDATE CONSTRAINT customer_invoice_items_vat_type_check;
ALTER TABLE public.customer_invoice_items VALIDATE CONSTRAINT customer_invoice_items_vat_type_tax_amount_pair;
ALTER TABLE public.customer_invoices VALIDATE CONSTRAINT customer_invoices_amounts_are_check;

COMMENT ON COLUMN public.customer_invoice_items.vat_type IS
  'The line''s VAT type (ledger spelling, gl.types VatType). Set with tax_amount or not at all. NULL: a legacy document-rate line (migration 1008). Approval content (1009).';
COMMENT ON COLUMN public.customer_invoice_items.tax_amount IS
  'The VAT the line charges, rounded on the line (shared/vatLineAmounts). Set with vat_type or not at all (migration 1008). Approval content (1009).';
COMMENT ON COLUMN public.customer_invoices.amounts_are IS
  'exclusive | inclusive: how the lines'' unit prices were entered; a line''s amount is its net either way. NULL reads as exclusive (migration 1008). Approval content (1009).';
