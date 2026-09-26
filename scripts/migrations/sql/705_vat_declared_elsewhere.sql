-- 705: mark an issued customer invoice / approved bill "VAT declared outside
-- IsaFlow / historical import".
--
-- vatUnpostedInvoices.ts blocks an issued customer invoice or approved bill
-- carrying VAT with no live journal (no journal, or its journal is not
-- posted or was reversed). That is right for a document IsaFlow should have
-- posted and did not — but an IMPORTED historical document may already carry
-- its VAT in the GL under a different entry, or have declared it under the
-- old system before the migration, and posting it now would double it. This
-- is NOT "post to GL": it never touches the ledger or any VAT201 field — it
-- only takes the document out of the BLOCKING list and puts it in a visible
-- non-blocking "declared elsewhere" list instead.
--
-- Same shape as 695's unlock history: who, when, why — all-or-none, never a
-- blank reason or actor. Columns rather than a side table: this is a flag on
-- the document itself (one row per invoice can be marked/unmarked), not a
-- log of many events against it — unmarking simply clears the columns, and
-- migration 704's vat_gate_overrides is the closest existing "many rows per
-- period" precedent for when that shape is instead the right one.
--
-- BOTH customer_invoices AND supplier_invoices: findUnpostedInvoiceVat unions
-- both populations (issued customer invoices, approved bills), and an
-- imported bill can carry exactly the same historical-VAT problem as an
-- imported invoice.

ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_at     TIMESTAMPTZ;
-- users.id is character varying(255), not uuid — same reason vat_period_locks.locked_by is TEXT.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_by     TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_reason TEXT;

ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_at     TIMESTAMPTZ;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_by     TEXT;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS vat_declared_elsewhere_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_invoices_vat_declared_elsewhere_ck' AND conrelid = 'customer_invoices'::regclass
  ) THEN
    ALTER TABLE customer_invoices ADD CONSTRAINT customer_invoices_vat_declared_elsewhere_ck CHECK (
      (vat_declared_elsewhere_at IS NULL AND vat_declared_elsewhere_by IS NULL AND vat_declared_elsewhere_reason IS NULL)
      OR (vat_declared_elsewhere_at IS NOT NULL
          AND vat_declared_elsewhere_by IS NOT NULL AND btrim(vat_declared_elsewhere_by) <> ''
          AND vat_declared_elsewhere_reason IS NOT NULL AND btrim(vat_declared_elsewhere_reason) <> '')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_invoices_vat_declared_elsewhere_ck' AND conrelid = 'supplier_invoices'::regclass
  ) THEN
    ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_vat_declared_elsewhere_ck CHECK (
      (vat_declared_elsewhere_at IS NULL AND vat_declared_elsewhere_by IS NULL AND vat_declared_elsewhere_reason IS NULL)
      OR (vat_declared_elsewhere_at IS NOT NULL
          AND vat_declared_elsewhere_by IS NOT NULL AND btrim(vat_declared_elsewhere_by) <> ''
          AND vat_declared_elsewhere_reason IS NOT NULL AND btrim(vat_declared_elsewhere_reason) <> '')
    );
  END IF;
END $$;
