-- 899: customer_invoices.amount_paid may not exceed the invoice total.
--
-- Audit 2026-10-18 (ar-receivables). Every over-application guard on an AR
-- invoice (receipt allocation, credit-note application, write-off, portal and
-- Netcash settlement) is a read-then-write in the service layer, so two
-- concurrent applications can each pass their own check and together push
-- amount_paid past total_amount: an over-paid invoice, a negative balance
-- (balance is GENERATED total_amount - amount_paid) and a debtor that no
-- longer foots to the GL. This CHECK is the database barrier underneath them.
--
-- GREATEST(total_amount, 0), not total_amount: one soft-deleted cancelled
-- production invoice carries total_amount = -115.00 at amount_paid = 0 (a
-- pre-692 row; 692's trigger now refuses writing a negative total), which a
-- plain `amount_paid <= total_amount` would reject on any later UPDATE of the
-- row. A negative-total invoice simply cannot carry a payment.
--
-- NaN is refused too: numeric orders NaN above every number, so
-- `NaN <= GREATEST(...)` is false. NULL passes (the column is nullable;
-- every reader COALESCEs it to 0).
--
-- A CHECK, not a trigger (contrast 692): this one SHOULD hold even under
-- session_replication_role = 'replica' — no fixture needs an over-paid row.
--
-- Added NOT VALID here; 900 validates it in its own transaction, so the table
-- scan runs under SHARE UPDATE EXCLUSIVE (reads and writes continue) and a
-- violating row found by the scan rolls back only 900, never this file.
-- NOT VALID is already enforced on every INSERT/UPDATE from the moment this
-- commits. Guarded so re-running the file is a no-op.
--
-- amount_paid >= 0 is deliberately NOT added: credit-note application and
-- cancellation (creditNoteApplicationWrites, creditNoteCancelService)
-- decrement without a clamp, guarded only by their own read, so a floor in
-- the database would turn a race there into a 500 on cancel/unapply of a
-- legitimate document rather than closing an over-application.
--
-- Rollback: ALTER TABLE customer_invoices
--             DROP CONSTRAINT IF EXISTS customer_invoices_amount_paid_within_total;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_invoices_amount_paid_within_total'
      AND conrelid = 'public.customer_invoices'::regclass
  ) THEN
    ALTER TABLE public.customer_invoices
      ADD CONSTRAINT customer_invoices_amount_paid_within_total
      CHECK (amount_paid <= GREATEST(total_amount, 0)) NOT VALID;
  END IF;
END
$$;
