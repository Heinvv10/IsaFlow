-- 614 — Auto-allocation strategy for supplier payments and customer receipts.
--
-- WHAT WAS WRONG. `suppliers.auto_allocate_payments` and
-- `customers.auto_allocate_receipts` (migration 246) are written by the forms,
-- the REST routes and the MCP contact tools, and are READ BY NOTHING. The
-- supplier toggle is labelled "Auto Allocate Payments to Oldest Invoice" while
-- the only code that ever picked an invoice for a bank allocation ordered by
-- `created_at DESC` — the NEWEST bill — and then set a `payment_matched`
-- boolean on it without moving `amount_paid`. The setting the user could see
-- said oldest, the code did newest, and neither actually applied any cash.
--
-- A boolean cannot express that choice, so it becomes a strategy:
--   'off'    — never apply automatically. The payment is created and left
--              unapplied, where list_unapplied_payments can find it.
--   'oldest' — apply oldest bill first (FIFO), partially settling the last one.
--   'newest' — apply newest bill first.
--
-- BACKFILL. Every contact whose old boolean was true takes 'oldest', which is
-- what the UI told them they had switched on. The boolean columns are left in
-- place and are no longer read by anything; dropping them belongs to its own
-- migration once no deployed build writes them.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS auto_allocate_strategy TEXT NOT NULL DEFAULT 'off';

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS auto_allocate_strategy TEXT NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_auto_allocate_strategy_check'
  ) THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_auto_allocate_strategy_check
      CHECK (auto_allocate_strategy IN ('off', 'oldest', 'newest'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_auto_allocate_strategy_check'
  ) THEN
    ALTER TABLE customers ADD CONSTRAINT customers_auto_allocate_strategy_check
      CHECK (auto_allocate_strategy IN ('off', 'oldest', 'newest'));
  END IF;
END $$;

-- Row-local: each contact takes the strategy its own flag already claimed.
-- Deliberately NOT company-scoped — this initialises a new column from a
-- column on the same row for every tenant, not a correction to one tenant's
-- data.
UPDATE suppliers SET auto_allocate_strategy = 'oldest'
 WHERE auto_allocate_payments = TRUE AND auto_allocate_strategy = 'off';

UPDATE customers SET auto_allocate_strategy = 'oldest'
 WHERE auto_allocate_receipts = TRUE AND auto_allocate_strategy = 'off';
