-- Migration 299: Add multi-currency fields to customer and supplier invoices
-- All DDL uses ADD COLUMN IF NOT EXISTS guards for idempotency.
-- NOTE: currency_code is VARCHAR(3) without FK (currencies.code has duplicate rows
--       from multi-tenant seeding so a unique constraint cannot be created).
--       Validation is enforced at the application layer.

-- ── customer_invoices ────────────────────────────────────────────────────────

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS currency_code    VARCHAR(3)    DEFAULT 'ZAR',
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC(18,6) DEFAULT 1.000000,
  ADD COLUMN IF NOT EXISTS functional_total NUMERIC(15,2); -- total in ZAR (functional currency)

-- Back-fill functional_total for existing rows (total_amount already in ZAR)
UPDATE customer_invoices
  SET functional_total = total_amount
  WHERE functional_total IS NULL;

-- ── customer_invoice_items ───────────────────────────────────────────────────

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) DEFAULT 'ZAR';

-- ── supplier_invoices ────────────────────────────────────────────────────────

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS currency_code    VARCHAR(3)    DEFAULT 'ZAR',
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC(18,6) DEFAULT 1.000000,
  ADD COLUMN IF NOT EXISTS functional_total NUMERIC(15,2); -- total in ZAR (functional currency)

-- Back-fill functional_total for existing rows
UPDATE supplier_invoices
  SET functional_total = total_amount
  WHERE functional_total IS NULL;
