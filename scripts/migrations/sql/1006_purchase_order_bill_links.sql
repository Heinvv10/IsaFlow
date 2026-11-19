-- 1006: Purchase order <-> bill links (MCP link_bills_to_purchase_order / unlink_bill_from_purchase_order).
-- Design: docs/design/mcp-po-bill-links.md (decisions 1, 3, 11).
--
-- WHAT. purchase_order_bill_links: one row per (company, purchase order, bill) saying "this bill was billed against
-- this PO, for this ex-VAT amount". A bill may name several POs (Sage does), which supplier_invoices.purchase_order_id
-- (one PO per bill) cannot say. The row stores the amount so a bill's split across POs never changes later;
-- `source` is who wrote it (mcp tool, the app's bill create, or this migration's backfill); external_system +
-- external_ref make a link idempotent for a migration load; closed_po_from_status records the status the PO was in
-- when THIS link's call closed it (close_when_fully_billed), so an unlink can reopen it.
-- A link posts nothing: no gl_journal_* row, no change to a bill's status, totals or amount_paid.
--
-- BACKFILL. A `backfill` link for every non-cancelled, non-deleted bill whose purchase_order_id names a purchase_orders
-- row of the same company AND supplier (a stale or foreign id, or an older supplier_purchase_orders id, gets none).
-- Amount: the stored ex-VAT of the bill's lines that name a line of that PO, else the bill's subtotal; never above the
-- subtotal; a bill with nothing above zero gets no link. It runs BEFORE row security and the guard exist, so it
-- needs neither a session nor a bypass. Re-running adds nothing (ON CONFLICT DO NOTHING on the pair).
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy, verbatim. app_user reads, INSERTs the payload columns and DELETEs (an
--     unlink); it never UPDATEs (a link's amount is fixed for life; the closing status is set at insert).
--   - One link per (company, PO, bill); one link per (company, external_system, external_ref) where a ref is given
--     (the system is stored lower case). amount > 0.
--   - purchase_order_bill_links_guard (BEFORE INSERT, SECURITY INVOKER, so RLS applies to its reads): the PO and the
--     bill must both be the row's company's, and of the same supplier. No composite FK exists to say it (the two
--     tables' ids are not unique with company_id).
--
-- LOCKS. A new table; the file's only lock on an existing one is a share lock for the backfill's reads. The
-- OLD COLOUR never reads or writes it: the old code keeps working, and the bills it creates between this migration
-- and the new colour's first request get no `app` link (a later backfill or a manual link covers them).
--
-- Rollback (code first; links are metadata, no ledger row depends on them):
--   DROP TRIGGER IF EXISTS trg_purchase_order_bill_links_guard ON public.purchase_order_bill_links;
--   DROP FUNCTION IF EXISTS public.purchase_order_bill_links_guard();
--   DROP TABLE IF EXISTS public.purchase_order_bill_links;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS purchase_order_bill_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  -- Ex-VAT billed against this PO by this bill.
  amount NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  source TEXT NOT NULL CHECK (source IN ('mcp', 'app', 'backfill')),
  external_system TEXT CHECK (external_system IS NULL OR external_system = lower(external_system)),
  external_ref TEXT,
  closed_po_from_status TEXT CHECK (closed_po_from_status IS NULL
    OR closed_po_from_status IN ('approved', 'partially_received', 'received')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_bill_links_pair_uq UNIQUE (company_id, purchase_order_id, supplier_invoice_id),
  CONSTRAINT purchase_order_bill_links_ref_pair CHECK ((external_system IS NULL) = (external_ref IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_bill_links_ref_uq
  ON purchase_order_bill_links (company_id, external_system, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_order_bill_links_bill
  ON purchase_order_bill_links (company_id, supplier_invoice_id);

-- ── Backfill ────────────────────────────────────────────────────────────────

INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source)
SELECT x.company_id, x.po_id, x.bill_id, x.amount, 'backfill'
  FROM (
    SELECT si.company_id, po.id AS po_id, si.id AS bill_id,
           LEAST(si.subtotal, COALESCE((
             SELECT SUM(sii.line_total) FROM supplier_invoice_items sii
               JOIN po_items pi ON pi.id = sii.po_item_id AND pi.purchase_order_id = po.id
              WHERE sii.supplier_invoice_id = si.id
           ), si.subtotal)) AS amount
      FROM supplier_invoices si
      JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.company_id = si.company_id
                             AND po.supplier_id = si.supplier_id
     WHERE si.status <> 'cancelled' AND si.deleted_at IS NULL
  ) x
 WHERE x.amount > 0
ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING;

-- ── The guard: both documents are the row's company's, of one supplier ──────

CREATE OR REPLACE FUNCTION public.purchase_order_bill_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM purchase_orders po
      JOIN supplier_invoices si ON si.supplier_id = po.supplier_id AND si.company_id = po.company_id
     WHERE po.id = NEW.purchase_order_id AND si.id = NEW.supplier_invoice_id AND po.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'a purchase order link joins a purchase order and a bill of one company and one supplier'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_purchase_order_bill_links_guard ON purchase_order_bill_links;
CREATE TRIGGER trg_purchase_order_bill_links_guard BEFORE INSERT ON purchase_order_bill_links
  FOR EACH ROW EXECUTE FUNCTION public.purchase_order_bill_links_guard();
ALTER TABLE purchase_order_bill_links ENABLE ALWAYS TRIGGER trg_purchase_order_bill_links_guard;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE purchase_order_bill_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_bill_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order_bill_links;
CREATE POLICY tenant_isolation ON purchase_order_bill_links FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- 348's default privileges gave app_user every command: take back UPDATE, grant INSERT per column.
REVOKE INSERT, UPDATE, DELETE ON purchase_order_bill_links FROM app_user;
GRANT SELECT, DELETE ON purchase_order_bill_links TO app_user;
GRANT INSERT (company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref,
              closed_po_from_status, created_by) ON purchase_order_bill_links TO app_user;

REVOKE ALL ON FUNCTION public.purchase_order_bill_links_guard() FROM PUBLIC;

-- The service pool reaches the table through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
