-- Migration 309: Sales order pipeline — confirm, convert to invoice, quote-to-SO
-- Adds missing columns and links across the quote → SO → invoice chain

-- Add confirmed_by / confirmed_at to customer_sales_orders
ALTER TABLE customer_sales_orders
  ADD COLUMN IF NOT EXISTS confirmed_by UUID,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Add line_number to customer_sales_order_items (service inserts/reads it)
ALTER TABLE customer_sales_order_items
  ADD COLUMN IF NOT EXISTS line_number INT DEFAULT 1;

-- Allow quotes to be linked to a sales order (quote → SO conversion)
ALTER TABLE customer_quotes
  ADD COLUMN IF NOT EXISTS converted_order_id UUID REFERENCES customer_sales_orders(id);

-- Allow 'converted_to_order' status on quotes without breaking existing CHECK
-- We use ALTER to drop and recreate the constraint
ALTER TABLE customer_quotes
  DROP CONSTRAINT IF EXISTS customer_quotes_status_check;

ALTER TABLE customer_quotes
  ADD CONSTRAINT customer_quotes_status_check
  CHECK (status IN ('draft','sent','accepted','rejected','declined','expired','converted','converted_to_order'));

CREATE INDEX IF NOT EXISTS idx_cq_converted_order ON customer_quotes(converted_order_id);
