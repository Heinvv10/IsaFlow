-- 694: sage_customer_invoices gets the link column its importer and reset use,
-- and neither Sage staging link can block archiving the document it points at.
--
-- R-101. Migration 205 gave sage_supplier_invoices a gl_supplier_invoice_id
-- but created sage_customer_invoices without the customer twin. Both
-- importCustomerInvoices (which records the invoice a staged row became) and
-- resetMigration('customer_invoices') (which clears it) name
-- gl_customer_invoice_id, so each died on 42703. Nullable, no backfill: no
-- row of this table has ever been imported.
--
-- ON DELETE SET NULL on both links: executeArchive moves old paid invoices
-- to the archive tables and DELETEs the originals, and a NO ACTION reference
-- from a staging row failed the whole archive run (R-101 review, REPRO4). The
-- supplier link from 205 carried the same latent defect; it is re-created
-- here with the same rule. A staging row whose document was archived keeps
-- migration_status 'imported' with a NULL link.

ALTER TABLE sage_customer_invoices
  ADD COLUMN IF NOT EXISTS gl_customer_invoice_id UUID;

ALTER TABLE sage_customer_invoices
  DROP CONSTRAINT IF EXISTS sage_customer_invoices_gl_customer_invoice_id_fkey;
ALTER TABLE sage_customer_invoices
  ADD CONSTRAINT sage_customer_invoices_gl_customer_invoice_id_fkey
  FOREIGN KEY (gl_customer_invoice_id) REFERENCES customer_invoices(id) ON DELETE SET NULL;

ALTER TABLE sage_supplier_invoices
  DROP CONSTRAINT IF EXISTS sage_supplier_invoices_gl_supplier_invoice_id_fkey;
ALTER TABLE sage_supplier_invoices
  ADD CONSTRAINT sage_supplier_invoices_gl_supplier_invoice_id_fkey
  FOREIGN KEY (gl_supplier_invoice_id) REFERENCES supplier_invoices(id) ON DELETE SET NULL;
