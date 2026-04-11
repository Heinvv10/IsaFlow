-- Migration 298: Add invoiced_at and invoice_id to customer_sales_orders
-- Supports the convert-to-invoice workflow for Sales Orders

ALTER TABLE customer_sales_orders
  ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES customer_invoices(id);

CREATE INDEX IF NOT EXISTS idx_cso_invoice_id ON customer_sales_orders(invoice_id);
