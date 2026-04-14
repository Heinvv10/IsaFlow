-- Migration 325: Create supplier_payment_allocations table
--
-- Root cause (BL-08 / F-006): The supplier-allocations API handler references
-- supplier_payment_allocations.amount_allocated but the table did not exist.
-- Migration 201 created payment_allocations (no supplier_ prefix) with the correct
-- amount_allocated column. Migration 253 attempted to create supplier_payment_allocations
-- but used the wrong column name (amount) and was never applied to production.
--
-- This migration creates the table with the correct column name so the GET/POST
-- handler in pages/api/accounting/supplier-allocations.ts works correctly.

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       UUID          NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  invoice_id       UUID          NOT NULL REFERENCES supplier_invoices(id),
  amount_allocated NUMERIC(15,2) NOT NULL CHECK (amount_allocated > 0),
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_spa_payment_id
  ON supplier_payment_allocations(payment_id);

CREATE INDEX IF NOT EXISTS idx_spa_invoice_id
  ON supplier_payment_allocations(invoice_id);
