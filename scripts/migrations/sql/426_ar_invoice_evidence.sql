-- PRD-06 Phase 1: Invoice-as-Evidence
--
-- Snapshot the rendered PDF at approve/send time so the document an auditor
-- sees three years later is byte-identical to the one the customer received.
-- Companion to PRD-05's captured_documents pipeline on the AP side — AR
-- snapshots are also captured_documents rows, just with document_type =
-- 'sent_invoice' and bucket 'customer-invoices'.
--
-- The bucket itself is created out-of-band via the Supabase Storage admin API
-- (see src/lib/supabaseStorage.ts — CUSTOMER_INVOICES_BUCKET). Creation is
-- idempotent at the SDK layer; this migration only touches SQL schema.

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS rendered_pdf_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS rendered_pdf_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS rendered_pdf_rendered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_document_id UUID;

-- Retrofit the FK on source_document_id → captured_documents(id) with the
-- same pattern supplier_invoices uses (mig 409). Guard with DO $$ so reruns
-- are safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_customer_inv_source_document'
      AND table_name = 'customer_invoices'
  ) THEN
    ALTER TABLE customer_invoices
      ADD CONSTRAINT fk_customer_inv_source_document
      FOREIGN KEY (source_document_id) REFERENCES captured_documents(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_cust_inv_source_doc
  ON customer_invoices(source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Fast lookup for the sealed-PDF endpoint: "does this invoice already have a
-- snapshot?" without scanning the whole row.
CREATE INDEX IF NOT EXISTS idx_cust_inv_rendered_pdf
  ON customer_invoices(company_id, id)
  WHERE rendered_pdf_storage_path IS NOT NULL;
