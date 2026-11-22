-- 1016: purchase_orders.closed_by_billing: "closed because fully billed" lives on the purchase order (PR #1703, ledger breaker
-- round 4, R4-1). Before this the record was a link's closed_po_from_status (1006), so unlinking the link that held it while
-- another tie still billed the PO in full lost it, and a later unlink or cancel left the PO closed under-billed with nothing
-- to reopen it.
--
-- WHAT.
--   1. purchase_orders.closed_by_billing BOOLEAN NOT NULL DEFAULT false (a constant default: no table rewrite). Set, with
--      closed_from_status, by link_bills_to_purchase_order's close_when_fully_billed and by 1022's close step; a close by hand
--      (close_purchase_order, set_purchase_order_status) leaves it false. ap/purchaseOrderBillingClose reopens a PO closed by
--      billing that the removal of a counted bill tie (an unlink, a bill cancelled or soft-deleted) leaves under-billed.
--   2. A trigger (BEFORE INSERT OR UPDATE, SECURITY INVOKER, ENABLE ALWAYS so session_replication_role = replica does not skip
--      it) clears the flag whenever the status is not closed, whoever writes the row: the flag can only describe a closed PO.
--      ENABLE ALWAYS needs table ownership; the deploy role owns purchase_orders (1006 enabled trg_po_bill_links_supplier_guard
--      on it the same way).
--   Migration 1022 moves the closing records that pre-release link calls left on links onto their POs.
--
-- LOCKS. ADD COLUMN and CREATE TRIGGER take ACCESS EXCLUSIVE on purchase_orders, for this file's own transaction only (the
--   runner applies each file in its own transaction): no row is read or written, so it is held for milliseconds once granted.
--   lock_timeout bounds the wait behind a transaction that holds a PO row; on a timeout the file fails whole and the release
--   retries.
--
-- OLD COLOUR. Neither reads nor writes the column. Its writes that move a PO out of closed clear the flag through the trigger;
--   its link call's close records itself on the link (closed_po_from_status), which the new code does not read (named limit:
--   such a PO, closed in the minutes of the switch, does not reopen by itself).
--
-- Rollback (down SQL; roll the code back first):
--   DROP TRIGGER IF EXISTS trg_purchase_orders_closed_by_billing ON public.purchase_orders;
--   DROP FUNCTION IF EXISTS public.purchase_orders_closed_by_billing_follows_status();
--   ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS closed_by_billing;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS closed_by_billing BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.purchase_orders.closed_by_billing IS
  'Closed because it was fully billed (link_bills_to_purchase_order close_when_fully_billed, or migration 1022): removing a counted bill tie that leaves it under-billed reopens it to closed_from_status (ap/purchaseOrderBillingClose). False for a close by hand; cleared whenever the status is not closed.';

CREATE OR REPLACE FUNCTION public.purchase_orders_closed_by_billing_follows_status() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'closed' THEN NEW.closed_by_billing := false; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.purchase_orders_closed_by_billing_follows_status() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_purchase_orders_closed_by_billing ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_closed_by_billing BEFORE INSERT OR UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.purchase_orders_closed_by_billing_follows_status();
ALTER TABLE public.purchase_orders ENABLE ALWAYS TRIGGER trg_purchase_orders_closed_by_billing;
