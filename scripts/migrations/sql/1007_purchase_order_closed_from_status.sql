-- 1007: purchase_orders.closed_from_status: the status a PO was closed from (MCP close_purchase_order /
-- set_purchase_order_status, docs/design/mcp-po-maintenance.md), so a later reopen can restore it.
--
-- WHAT. A nullable TEXT column. close_purchase_order records approved / partially_received / received; set_purchase_order_status
-- (-> closed) records whatever the PO was. It is cleared when the PO leaves closed. No existing column fits: the link table's
-- closed_po_from_status (1006) belongs to a link, and a PO closed by hand may have none.
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
  OR closed_from_status IN ('draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'));
