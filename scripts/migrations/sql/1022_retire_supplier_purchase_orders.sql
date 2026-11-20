-- 1022: Retire supplier_purchase_orders (SPO, 247) into the canonical purchase_orders + po_items (design
-- docs/design/items-inventory-po-mcp.md, "Phase B: SPO retirement"; Hein, 18 Nov).
--
-- WHAT.
--   1. supplier_purchase_orders and supplier_purchase_order_items refuse every write (BEFORE INSERT OR UPDATE OR DELETE,
--      SECURITY INVOKER, ENABLE ALWAYS, so session_replication_role = replica does not skip them; TRUNCATE is refused by
--      a statement trigger): "retired: use purchase_orders". DELETE has STATE rules (never a rule on current_user):
--        a header goes when its canonical copy exists in its own company, or when this migration recorded it as skipped
--          (supplier_purchase_orders_retired_skips: id, reason; written only here);
--        a line goes when its header could (copy in the header's company, or header skipped), or when its header is
--          already gone (the ON DELETE CASCADE). Not by the line's own copy: the PO PUT deletes and reinserts po_items.
--      So the Demo reseed's wipe (wipePlan.ts, DELETE by company; no TRUNCATE) deletes every legacy row. The triggers are
--      created FIRST: their SHARE ROW EXCLUSIVE lock holds the old colour's writes until this commits, and they are refused
--      after, so nothing it writes during the copy is lost. The tables are NOT dropped.
--   2. Each legacy header is copied into purchase_orders WITH THE SAME id, each line into po_items with the same id, so a
--      bill header (supplier_invoices.purchase_order_id) naming a legacy id now names a canonical PO. A header whose id is
--      already a purchase order of its own company was copied by an earlier run: skipped silently (a re-run is a no-op).
--        header: company, supplier (it must be the company's: suppliers.id is the same table), order date (a missing one
--          takes the created date), delivery date, subtotal / tax / total, reference and created_by exactly as stored;
--          notes + "Internal notes: ..." + the project id (purchase_orders has neither column) + a cost centre that is not
--          a CC1 / CC2 of the company. A CC1 / CC2 cost centre goes onto every line (po_items.cc1_id / cc2_id).
--          approved_by / approved_at stay NULL: no reader or gate reads them (only the Approve action, the MCP update and
--          set_purchase_order_status write them, and the update copies the prior values into its audit row as text).
--        status: draft (or none) -> draft and cancelled -> cancelled, always. Any other order with BILLING EVIDENCE -> closed:
--          a live bill (not cancelled, not deleted, any status, draft included) of the same company and supplier naming it
--          in purchase_order_id, a line with qty_invoiced > 0, or a legacy invoiced / partially_invoiced status. A header
--          link cannot net committed spend (budgets/remainingCommitted nets bill lines by po_item_id only; known limit in
--          mcp-po-bill-links.md), so an open copy would commit what its bills already put in actuals. closed_from_status by
--          quantity: received when every line is fully received, partially_received when some is, else approved; a NOTICE
--          per order. A partly billed order therefore drops its unbilled remainder out of committed (the understatement is
--          the honest limit. NO app path reopens a closed copy today: set_purchase_order_status takes only an order with an
--          external_ref, which no copy carries, and the PUT / update_purchase_order edit only draft / submitted / approved).
--          With no billing evidence: sent -> approved, partially_received and received as they are (committing).
--        number: a (company, po_number) the canonical table already holds is NOT a failure (a failed production migration
--          blocks every release): the copy takes order_number || '-SPO', then '-SPO2', ... until free, its notes say
--          "was SPO <number>", and a NOTICE names it. No copy carries external_system / external_ref /
--          external_document_number (they would make the copy eligible for set_purchase_order_status).
--        line: line_total and tax_amount exactly as stored. The legacy line_total is NET: master's SPO writer stored
--          line_total = round(quantity x unit_price, 2) with the VAT in tax_amount (purchaseOrderService.ts:55/74,
--          procurementService.ts:110), subtotal = their sum, total = subtotal + tax; so the copy keeps figures as stored
--          (dev's VAT-inclusive line totals are seed junk, written outside the app on 2026-04-19). quantity to 2 dp,
--          unit_price = line_total / quantity to 6 dp (1001's effective ex-VAT price: a discount is in it). A line whose
--          quantity is 0 or less at 2 dp, or whose 2-dp quantity cannot give its total back to the cent (a quantity of
--          10 000 or more), is copied as 1 unit at its line total, "(qty <original> @ <price>)" appended to its description,
--          received / invoiced as the fraction of that unit; a NOTICE per order. item_id only when it is the company's item,
--          gl_account_id only when it is the company's account (else NULL). sort_order by the legacy created_at.
--      SKIPPED, with a WARNING, a skips row (reason) and a per-reason NOTICE, the row left in the legacy table: a header whose
--      supplier is another company's, whose id is another company's purchase order, with a negative line total, or with a
--      line id po_items already holds; and, in a sub-transaction per order, any order a constraint refuses (check, not
--      null, unique, foreign key), so one unforeseen row is a WARNING, not an aborted release.
--   3. Per company copied: the purchase_order counter moves past the highest copied number of its own form (prefix +
--      1-9 digits, as the PO import does; never back), purchase_order_bill_links_backfill(company) (1006) links the bills
--      that named a legacy id, and a NOTICE per order-date month gives the committing copies and their ex-VAT line total
--      (what entered committed spend). NOTICEs also give the copied counts per legacy status, renamed, closed, skipped.
--
-- LOCKS. SHARE ROW EXCLUSIVE on both legacy tables (the triggers) and on purchase_orders (LOCK TABLE: no app PO insert
--   can take a number between the free-number check and the copy's insert); ROW EXCLUSIVE on po_items,
--   company_document_numbers, purchase_order_bill_links and the skips table. All held to commit; lock_timeout bounds each
--   wait. The legacy tables are small (dev: 204 headers).
--
-- OLD COLOUR. Its supplier-purchase-orders pages and route write the legacy tables: every write is refused with the
--   message above (a 500 on that page) until the switch, where those pages become redirects. It reads the legacy tables
--   (unchanged). Its canonical PO code sees the copies as ordinary purchase orders.
--
-- Rollback (down SQL; roll the code back first). The copies stay: they are ordinary purchase orders now, and bills may link
-- them. To make the legacy tables writable again:
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired ON public.supplier_purchase_orders;
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired ON public.supplier_purchase_order_items;
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired_truncate ON public.supplier_purchase_orders;
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired_truncate ON public.supplier_purchase_order_items;
--   DROP FUNCTION IF EXISTS public.supplier_purchase_orders_retired();
--   DROP FUNCTION IF EXISTS public.supplier_purchase_orders_retired_truncate();
--   DROP TABLE IF EXISTS public.supplier_purchase_orders_retired_skips;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ── 1. The legacy tables refuse writes ──────────────────────────────────────────────────────────────────────────

-- The headers this migration could not copy, and why (written only here; read by the DELETE rule below). No company_id:
-- the id is the legacy row's own, and the row says nothing a tenant may not see about its own order.
CREATE TABLE IF NOT EXISTS public.supplier_purchase_orders_retired_skips (
  id UUID PRIMARY KEY,
  reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON public.supplier_purchase_orders_retired_skips FROM PUBLIC, app_user;
GRANT SELECT ON public.supplier_purchase_orders_retired_skips TO app_user;

CREATE OR REPLACE FUNCTION public.supplier_purchase_orders_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- IF branches, not one expression: OLD has only the fields of ITS table.
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'supplier_purchase_orders' THEN
      -- A header goes when its canonical copy exists in its own company, or when 1022 recorded it as skipped.
      IF EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = OLD.id AND p.company_id = OLD.company_id)
         OR EXISTS (SELECT 1 FROM public.supplier_purchase_orders_retired_skips k WHERE k.id = OLD.id) THEN
        RETURN OLD;
      END IF;
    ELSE
      -- A line goes with its header's state, not its own copy (the PO PUT deletes and reinserts po_items under new ids):
      -- its header's copy exists in the header's company, or the header was skipped, or the header is already gone (the
      -- ON DELETE CASCADE of a header delete, which the header's own rule allowed).
      IF NOT EXISTS (SELECT 1 FROM public.supplier_purchase_orders h WHERE h.id = OLD.purchase_order_id)
         OR EXISTS (SELECT 1 FROM public.supplier_purchase_orders h
                      JOIN public.purchase_orders p ON p.id = h.id AND p.company_id = h.company_id
                     WHERE h.id = OLD.purchase_order_id)
         OR EXISTS (SELECT 1 FROM public.supplier_purchase_orders_retired_skips k WHERE k.id = OLD.purchase_order_id) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% is retired (migration 1022): use purchase_orders / po_items', TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported',
          HINT = 'Purchase orders live in purchase_orders; /accounting/purchase-orders is the page.';
END $$;
REVOKE ALL ON FUNCTION public.supplier_purchase_orders_retired() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired ON public.supplier_purchase_orders;
CREATE TRIGGER trg_supplier_purchase_orders_retired BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.supplier_purchase_orders_retired();
ALTER TABLE public.supplier_purchase_orders ENABLE ALWAYS TRIGGER trg_supplier_purchase_orders_retired;

DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired ON public.supplier_purchase_order_items;
CREATE TRIGGER trg_supplier_purchase_order_items_retired BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.supplier_purchase_orders_retired();
ALTER TABLE public.supplier_purchase_order_items ENABLE ALWAYS TRIGGER trg_supplier_purchase_order_items_retired;

-- TRUNCATE skips row triggers: refused as a statement (no wipe path truncates; the Demo wipe deletes by company).
CREATE OR REPLACE FUNCTION public.supplier_purchase_orders_retired_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is retired (migration 1022): TRUNCATE is refused', TG_TABLE_NAME USING ERRCODE = 'feature_not_supported';
END $$;
REVOKE ALL ON FUNCTION public.supplier_purchase_orders_retired_truncate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired_truncate ON public.supplier_purchase_orders;
CREATE TRIGGER trg_supplier_purchase_orders_retired_truncate BEFORE TRUNCATE ON public.supplier_purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_purchase_orders_retired_truncate();
ALTER TABLE public.supplier_purchase_orders ENABLE ALWAYS TRIGGER trg_supplier_purchase_orders_retired_truncate;

DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired_truncate ON public.supplier_purchase_order_items;
CREATE TRIGGER trg_supplier_purchase_order_items_retired_truncate BEFORE TRUNCATE ON public.supplier_purchase_order_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_purchase_orders_retired_truncate();
ALTER TABLE public.supplier_purchase_order_items ENABLE ALWAYS TRIGGER trg_supplier_purchase_order_items_retired_truncate;

LOCK TABLE public.purchase_orders IN SHARE ROW EXCLUSIVE MODE;

-- ── 2 + 3. The copy, the counter, the bill links, the committed record ───────────────────────────────────────────

DO $$
DECLARE
  h RECORD;
  c RECORD;
  v_number TEXT;
  v_try INT;
  v_status TEXT;
  v_from TEXT;
  v_any_recv BOOLEAN;
  v_all_recv BOOLEAN;
  v_billed BOOLEAN;
  v_cc_type TEXT;
  v_cc1 UUID;
  v_cc2 UUID;
  v_notes TEXT;
  v_reason TEXT;
  v_unit_lines INT;
  v_copied UUID[] := '{}';
  v_skip_supplier INT := 0;
  v_skip_negative INT := 0;
  v_skip_item_id INT := 0;
  v_skip_id_taken INT := 0;
  v_skip_error INT := 0;
  v_renamed INT := 0;
  v_closed_billed INT := 0;
  v_unit_total INT := 0;
  v_links BIGINT := 0;
  v_prefix TEXT;
  v_max INT;
  v_off INT;
BEGIN
  FOR h IN
    SELECT s.*, sup.company_id AS supplier_company
      FROM public.supplier_purchase_orders s
      JOIN public.suppliers sup ON sup.id = s.supplier_id
     WHERE NOT EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = s.id AND p.company_id = s.company_id)
     ORDER BY s.company_id, s.created_at, s.id
  LOOP
    v_reason := CASE
      WHEN h.supplier_company IS DISTINCT FROM h.company_id THEN 'supplier of another company'
      WHEN EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = h.id) THEN 'id already a purchase order of another company'
      WHEN EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id AND i.line_total < 0)
        THEN 'negative line total'
      WHEN EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i JOIN public.po_items x ON x.id = i.id WHERE i.purchase_order_id = h.id)
        THEN 'line id already in po_items'
      END;
    IF v_reason IS NOT NULL THEN
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%): %', h.id, h.order_number, v_reason;
      INSERT INTO public.supplier_purchase_orders_retired_skips (id, reason) VALUES (h.id, v_reason)
        ON CONFLICT (id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
      CASE v_reason
        WHEN 'supplier of another company' THEN v_skip_supplier := v_skip_supplier + 1;
        WHEN 'negative line total' THEN v_skip_negative := v_skip_negative + 1;
        WHEN 'line id already in po_items' THEN v_skip_item_id := v_skip_item_id + 1;
        ELSE v_skip_id_taken := v_skip_id_taken + 1;
      END CASE;
      CONTINUE;
    END IF;

    v_number := h.order_number;
    v_try := 0;
    WHILE EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.company_id = h.company_id AND p.po_number = v_number) LOOP
      v_try := v_try + 1;
      v_number := h.order_number || '-SPO' || CASE WHEN v_try = 1 THEN '' ELSE v_try::TEXT END;
    END LOOP;

    -- Status. Billing evidence (a live bill of the company and supplier naming the order in its header, whatever its
    -- status; a line invoiced in part; a legacy invoiced / partially_invoiced status) closes a non-draft, non-cancelled
    -- order: a header link cannot net committed spend (mcp-po-bill-links.md, known limits), so an open copy would
    -- commit what its bills already put in actuals. Closed from received / partially_received / approved by quantity.
    v_any_recv := EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_received, 0) > 0);
    v_all_recv := EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i
                       WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_received, 0) < i.quantity);
    v_billed := h.status IN ('invoiced', 'partially_invoiced')
      OR EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_invoiced, 0) > 0)
      OR EXISTS (SELECT 1 FROM public.supplier_invoices si
                  WHERE si.company_id = h.company_id AND si.supplier_id = h.supplier_id AND si.purchase_order_id = h.id
                    AND si.status <> 'cancelled' AND si.deleted_at IS NULL);
    v_status := CASE COALESCE(h.status, 'draft')
      WHEN 'draft' THEN 'draft' WHEN 'cancelled' THEN 'cancelled' WHEN 'sent' THEN 'approved'
      WHEN 'partially_received' THEN 'partially_received' WHEN 'received' THEN 'received' ELSE 'closed' END;
    v_from := NULL;
    IF v_billed AND v_status NOT IN ('draft', 'cancelled') THEN
      v_status := 'closed';
      v_from := CASE WHEN v_all_recv THEN 'received' WHEN v_any_recv THEN 'partially_received' ELSE 'approved' END;
    END IF;

    v_cc_type := NULL;
    IF h.cost_center_id IS NOT NULL THEN
      SELECT cc.cc_type INTO v_cc_type FROM public.cost_centres cc WHERE cc.id = h.cost_center_id AND cc.company_id = h.company_id;
    END IF;
    v_cc1 := CASE WHEN v_cc_type = 'cc1' THEN h.cost_center_id END;
    v_cc2 := CASE WHEN v_cc_type = 'cc2' THEN h.cost_center_id END;
    v_notes := NULLIF(concat_ws(E'\n\n',
      NULLIF(h.notes, ''),
      CASE WHEN v_try > 0 THEN 'was SPO ' || h.order_number END,
      CASE WHEN NULLIF(btrim(h.internal_notes), '') IS NOT NULL THEN 'Internal notes: ' || h.internal_notes END,
      CASE WHEN h.project_id IS NOT NULL THEN 'Project (from the retired supplier purchase order): ' || h.project_id::TEXT END,
      CASE WHEN h.cost_center_id IS NOT NULL AND v_cc1 IS NULL AND v_cc2 IS NULL
        THEN 'Cost centre (from the retired supplier purchase order; not a CC1 / CC2 of this company): ' || h.cost_center_id::TEXT END
    ), '');

    -- One sub-transaction per order: a row an unforeseen constraint refuses becomes a WARNING and a skip, never an aborted
    -- release.
    BEGIN
      INSERT INTO public.purchase_orders (
        id, company_id, po_number, supplier_id, order_date, expected_delivery_date, status, closed_from_status,
        subtotal, tax_amount, total, notes, reference, created_by, created_at, updated_at
      ) VALUES (
        h.id, h.company_id, v_number, h.supplier_id, COALESCE(h.order_date, (h.created_at AT TIME ZONE 'UTC')::DATE, CURRENT_DATE),
        h.delivery_date, v_status, v_from, h.subtotal, h.tax_amount, h.total_amount, v_notes, h.reference, h.created_by::TEXT,
        h.created_at, h.updated_at
      );

      -- A line whose quantity rounds to 0 (or below) at 2 dp, or whose 2-dp quantity cannot give its total back to the cent,
      -- is copied as 1 unit at its line total, its own quantity and price kept in the description.
      INSERT INTO public.po_items (
        id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount,
        quantity_received, quantity_invoiced, gl_account_id, item_id, cc1_id, cc2_id, sort_order, created_at
      )
      SELECT l.id, h.id,
             CASE WHEN l.as_unit THEN l.description || ' (qty ' || trim_scale(l.quantity)::TEXT || ' @ ' || trim_scale(l.unit_price)::TEXT || ')'
                  ELSE l.description END,
             CASE WHEN l.as_unit THEN 1 ELSE l.q2 END,
             CASE WHEN l.as_unit THEN l.line_total ELSE round(l.line_total / l.q2, 6) END,
             l.tax_rate, l.line_total, l.tax_amount,
             CASE WHEN l.as_unit THEN round(LEAST(COALESCE(l.qty_received, 0) / NULLIF(l.quantity, 0), 1), 2) ELSE round(COALESCE(l.qty_received, 0), 2) END,
             CASE WHEN l.as_unit THEN round(LEAST(COALESCE(l.qty_invoiced, 0) / NULLIF(l.quantity, 0), 1), 2) ELSE round(COALESCE(l.qty_invoiced, 0), 2) END,
             (SELECT g.id FROM public.gl_accounts g WHERE g.id = l.gl_account_id AND g.company_id = h.company_id),
             (SELECT it.id FROM public.items it WHERE it.id = l.item_id AND it.company_id = h.company_id),
             v_cc1, v_cc2, (row_number() OVER (ORDER BY l.created_at, l.id) - 1)::INT, l.created_at
        FROM (SELECT i.*, round(i.quantity, 2) AS q2,
                     CASE WHEN round(i.quantity, 2) <= 0 THEN TRUE  -- CASE, not OR: the division below must never see a 0
                          ELSE round(round(i.quantity, 2) * round(i.line_total / round(i.quantity, 2), 6), 2) <> i.line_total END AS as_unit
                FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id) l;

      SELECT count(*) INTO v_unit_lines FROM public.supplier_purchase_order_items i JOIN public.po_items x ON x.id = i.id
       WHERE i.purchase_order_id = h.id AND x.quantity = 1 AND round(i.quantity, 2) <> 1;
      IF v_try > 0 THEN
        RAISE NOTICE '1022: company % supplier_purchase_orders % number % is taken: copied as % (its notes say was SPO %)',
          h.company_id, h.id, h.order_number, v_number, h.order_number;
        v_renamed := v_renamed + 1;
      END IF;
      IF v_from IS NOT NULL THEN
        RAISE NOTICE '1022: company % supplier_purchase_orders % (%, legacy %) has billing evidence: copied as closed from %',
          h.company_id, h.id, h.order_number, COALESCE(h.status, '(none)'), v_from;
        v_closed_billed := v_closed_billed + 1;
      END IF;
      IF v_unit_lines > 0 THEN
        RAISE NOTICE '1022: supplier_purchase_orders % (%): % line(s) copied as 1 unit at the line total (quantity at 2 dp could not give it)',
          h.id, h.order_number, v_unit_lines;
        v_unit_total := v_unit_total + v_unit_lines;
      END IF;
      v_copied := v_copied || h.id;
    EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR foreign_key_violation THEN
      v_reason := 'refused by the database (' || SQLSTATE || '): ' || left(SQLERRM, 200);
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%): %', h.id, h.order_number, v_reason;
      INSERT INTO public.supplier_purchase_orders_retired_skips (id, reason) VALUES (h.id, v_reason)
        ON CONFLICT (id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
      v_skip_error := v_skip_error + 1;
    END;
  END LOOP;

  FOR c IN
    SELECT s.status, count(DISTINCT s.id) AS heads, count(i.id) AS lines
      FROM public.supplier_purchase_orders s
      LEFT JOIN public.supplier_purchase_order_items i ON i.purchase_order_id = s.id
     WHERE s.id = ANY(v_copied)
     GROUP BY s.status ORDER BY s.status
  LOOP
    RAISE NOTICE '1022: copied % order(s), % line(s) of legacy status %', c.heads, c.lines, COALESCE(c.status, '(none)');
  END LOOP;
  RAISE NOTICE '1022: copied % order(s) in all, % skipped, % renamed, % closed for billing evidence, % line(s) as 1 unit',
    cardinality(v_copied), v_skip_supplier + v_skip_negative + v_skip_item_id + v_skip_id_taken + v_skip_error,
    v_renamed, v_closed_billed, v_unit_total;
  RAISE NOTICE '1022: skipped per reason: % supplier of another company, % negative line total, % line id already in po_items, % id already a purchase order of another company, % refused by the database',
    v_skip_supplier, v_skip_negative, v_skip_item_id, v_skip_id_taken, v_skip_error;

  FOR c IN SELECT DISTINCT p.company_id FROM public.purchase_orders p WHERE p.id = ANY(v_copied) ORDER BY p.company_id LOOP
    v_prefix := NULL;
    SELECT n.prefix INTO v_prefix FROM public.company_document_numbers n
     WHERE n.company_id = c.company_id AND n.document_type = 'purchase_order' FOR UPDATE;
    v_off := length(COALESCE(v_prefix, 'PO'));
    SELECT max(substr(p.po_number, v_off + 1)::INT) INTO v_max FROM public.purchase_orders p
     WHERE p.id = ANY(v_copied) AND p.company_id = c.company_id
       AND left(p.po_number, v_off) = COALESCE(v_prefix, 'PO') AND substr(p.po_number, v_off + 1) ~ '^[0-9]{1,9}$';
    IF v_max IS NOT NULL THEN
      IF v_prefix IS NULL THEN
        INSERT INTO public.company_document_numbers (company_id, document_type, prefix, next_number, padding)
        VALUES (c.company_id, 'purchase_order', 'PO', v_max + 1, 7) ON CONFLICT DO NOTHING;
      ELSE
        UPDATE public.company_document_numbers SET next_number = GREATEST(next_number, v_max + 1)
         WHERE company_id = c.company_id AND document_type = 'purchase_order';
      END IF;
    END IF;
    v_links := v_links + public.purchase_order_bill_links_backfill(c.company_id);
  END LOOP;
  RAISE NOTICE '1022: % bill link(s) written for the copied orders (each backfill call above gives its written / skipped)', v_links;

  -- What entered committed spend (budgets/remainingCommitted: approved / partially_received / received POs), per company
  -- and order-date month, ex VAT: the release log's record of the jump.
  FOR c IN
    SELECT p.company_id, to_char(p.order_date, 'YYYY-MM') AS month, count(DISTINCT p.id) AS orders, COALESCE(sum(x.line_total), 0) AS ex_vat
      FROM public.purchase_orders p LEFT JOIN public.po_items x ON x.purchase_order_id = p.id
     WHERE p.id = ANY(v_copied) AND p.status IN ('approved', 'partially_received', 'received')
     GROUP BY p.company_id, to_char(p.order_date, 'YYYY-MM') ORDER BY 1, 2
  LOOP
    RAISE NOTICE '1022: company % committing copies, order month %: % order(s), R % ex VAT', c.company_id, c.month, c.orders, c.ex_vat;
  END LOOP;
END $$;
