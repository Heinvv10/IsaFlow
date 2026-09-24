-- 694: sage_customer_invoices gets the link column its importer and reset use.
--
-- R-101. Migration 205 gave sage_supplier_invoices a gl_supplier_invoice_id
-- but created sage_customer_invoices without the customer twin. Both
-- importCustomerInvoices (which records the invoice a staged row became) and
-- resetMigration('customer_invoices') (which clears it) name
-- gl_customer_invoice_id, so each died on 42703. Nullable, no backfill: no
-- row of this table has ever been imported.

ALTER TABLE sage_customer_invoices
  ADD COLUMN IF NOT EXISTS gl_customer_invoice_id UUID REFERENCES customer_invoices(id);
