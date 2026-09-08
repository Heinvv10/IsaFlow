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
-- NO BACKFILL, DELIBERATELY. The obvious move is to carry every ticked box
-- over as 'oldest' — the order its own label claimed. It is the wrong move.
-- The box was INERT for its entire life: nothing read either column, so
-- ticking it never applied a cent. Nobody who ticked it consented to automatic
-- cash application, because ticking it did nothing to consent to. Carrying it
-- over would switch real cash application on, unattended, for every one of
-- those contacts on the first bank allocation after this deploys.
--
-- So every contact starts at 'off' and the setting turns on only when somebody
-- sets it deliberately, through a control that now says what it actually does.
-- At the time of writing production carries 2 such customers (one with 43 open
-- invoices) and 0 such suppliers, so this costs two re-ticks.
--
-- The boolean columns are left in place and are no longer read by anything;
-- dropping them belongs to its own migration once no deployed build writes
-- them.

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
