-- 375_invoice_items_time_entry_fk.sql
-- Link invoice line items back to the source time entry for billing traceability.
-- Nullable: grouped WIP invoices (by_work_item / by_category) collapse many entries into one line and cannot reference a single source.

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS time_entry_id UUID REFERENCES time_entries(id);

CREATE INDEX IF NOT EXISTS idx_cii_time_entry ON customer_invoice_items(time_entry_id)
  WHERE time_entry_id IS NOT NULL;
