-- 1007: purchase_orders.closed_from_status: the status a PO was closed from by hand (MCP close_purchase_order /
-- set_purchase_order_status, docs/design/mcp-po-maintenance.md): a record for the person (and a future reopen tool) to read.
-- NOTHING restores a status from it today.
--
-- WHAT. A nullable TEXT column. close_purchase_order records approved / partially_received / received; set_purchase_order_status
-- (-> closed) records approved (the only status it closes from). It holds a value ONLY while the PO is closed (the CHECK below):
-- every writer that moves a PO out of closed clears it in the same UPDATE (set_purchase_order_status, the unlink's reopen). A close
-- made by link_bills_to_purchase_order (close_when_fully_billed) does NOT set it: that closing is recorded on the link (1006's
-- closed_po_from_status). No existing column fits: the link record belongs to a link, and a PO closed by hand may have none.
--
-- LOCKS. One ADD COLUMN (no default: no rewrite) and one CHECK over a small table; lock_timeout bounds the wait.
--
-- OLD COLOUR. The old code never writes or reads the column; its `SELECT po.*` readers pass it through. Nothing it does is refused.
--
-- Rollback (down SQL; roll the code back first, and only while no row uses it):
--   ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_closed_from_status_check;
--   ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS closed_from_status;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS closed_from_status TEXT;

ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_closed_from_status_check;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_closed_from_status_check CHECK (closed_from_status IS NULL
  OR (status = 'closed' AND closed_from_status IN ('approved', 'partially_received', 'received')));
