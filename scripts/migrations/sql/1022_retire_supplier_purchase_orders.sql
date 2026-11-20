-- 1022: Retire supplier_purchase_orders (SPO, 247) into the canonical purchase_orders + po_items (design
-- docs/design/items-inventory-po-mcp.md, "Phase B: SPO retirement"; Hein, 18 Nov).
--
-- WHAT.
--   1. supplier_purchase_orders and supplier_purchase_order_items refuse every write (BEFORE INSERT OR UPDATE OR DELETE,
--      SECURITY INVOKER, ENABLE ALWAYS, so session_replication_role = replica does not skip them): "retired: use
--      purchase_orders". One exception, a STATE rule (never a rule on current_user): a DELETE of a row whose canonical copy
--      exists (same id, same company / same order) is allowed, because nothing is lost by it. The Demo reseed's wipe
--      (scripts/lib/demoReseed/wipePlan.ts) deletes the legacy rows before the canonical ones, so it needs nothing more.
--      The triggers are created FIRST: their SHARE ROW EXCLUSIVE lock holds the old colour's writes until this commits,
--      and they are refused after, so nothing it writes during the copy is lost. The tables are NOT dropped.
--   2. Each legacy header is copied into purchase_orders WITH THE SAME id, each line into po_items with the same id, so a
--      bill header (supplier_invoices.purchase_order_id) naming a legacy id now names a canonical PO.
--        header: company, supplier (it must be the company's: suppliers.id is the same table), order date (a missing one
--          takes the created date), delivery date, subtotal / tax / total, reference and created_by exactly as stored;
--          notes + "Internal notes: ..." + the project id (purchase_orders has neither column) + a cost centre that is not
--          a CC1 / CC2 of the company. A CC1 / CC2 cost centre goes onto every line (po_items.cc1_id / cc2_id).
--        status: draft (or none) -> draft, sent -> approved, partially_received, received, cancelled as they are;
--          invoiced -> closed from received. partially_invoiced depends on its bills: a live bill (not cancelled, not
--          deleted; the population purchase_order_bill_links_backfill links) of the same company and supplier whose
--          header names the legacy id -> received when every line is fully received, else partially_received (it stays
--          committing; the backfill links that bill); no such bill -> closed from received / partially_received by the
--          same quantity test (nothing could net the billed part off, so committing the whole order would overstate), with
--          a NOTICE per order (1007's CHECK).
--        number: a (company, po_number) the canonical table already holds is NOT a failure (a failed production migration
--          blocks every release): the copy takes order_number || '-SPO', then '-SPO2', ... until free, its notes say
--          "was SPO <number>", and a NOTICE names it. No copy carries external_ref (it would make the copy eligible for
--          set_purchase_order_status, which is for imported orders).
--        line: quantity to 2 dp (po_items), line_total and tax_amount exactly as stored, unit_price = line_total / quantity
--          to 6 dp (1001's effective ex-VAT unit price: the discount the legacy line_total applied is in it), so
--          round(quantity x unit_price, 2) = line_total. item_id only when it is the company's item, gl_account_id only when
--          it is the company's account (else NULL; the description is kept). quantity_received / quantity_invoiced from
--          qty_received / qty_invoiced. sort_order by the legacy created_at. The legacy line_total is NET: master's SPO writer
--          stored line_total = round(quantity x unit_price, 2) with the VAT in tax_amount (purchaseOrderService.ts:55/74,
--          procurementService.ts:110), subtotal = their sum, total = subtotal + tax; so the copy keeps figures as stored
--          (dev's VAT-inclusive line totals are seed junk, written outside the app on 2026-04-19).
--      SKIPPED, with a WARNING naming the legacy id, and left in the legacy table: a header whose supplier is another
--      company's, or with a line po_items' CHECKs refuse (quantity <= 0 at 2 dp, a negative line_total), or a line id
--      po_items already holds. A header whose id is already in purchase_orders was copied by an earlier run: skipped
--      silently, which keeps a re-run a no-op. A NOTICE gives the skipped count per reason.
--   3. Per company copied: the purchase_order counter moves past the highest copied number of its own form (prefix +
--      1-9 digits, as the PO import does), and purchase_order_bill_links_backfill(company) (1006) links the bills that
--      named a legacy id. NOTICEs: per legacy status, headers and lines copied; skipped; renamed; links written.
--
-- LOCKS. SHARE ROW EXCLUSIVE on both legacy tables (the triggers) and on purchase_orders (LOCK TABLE: no app PO insert
--   can take a number between the free-number check and the copy's insert); ROW EXCLUSIVE on po_items,
--   company_document_numbers and purchase_order_bill_links. All held to commit; lock_timeout bounds each wait. The legacy
--   tables are small (dev: 204 headers).
--
-- OLD COLOUR. Its supplier-purchase-orders pages and route write the legacy tables: every write is refused with the
--   message above (a 500 on that page) until the switch, where those pages become redirects. It reads the legacy tables
--   (unchanged). Its canonical PO code sees the copies as ordinary purchase orders.
--
-- Rollback (down SQL; roll the code back first). The copies stay: they are ordinary purchase orders now, and bills may link
-- them. To make the legacy tables writable again:
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired ON public.supplier_purchase_orders;
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired ON public.supplier_purchase_order_items;
--   DROP FUNCTION IF EXISTS public.supplier_purchase_orders_retired();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ── 1. The legacy tables refuse writes ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.supplier_purchase_orders_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- IF branches, not one expression: OLD has only the fields of ITS table.
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'supplier_purchase_orders' THEN
      IF EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = OLD.id AND p.company_id = OLD.company_id) THEN
        RETURN OLD;
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.po_items i WHERE i.id = OLD.id AND i.purchase_order_id = OLD.purchase_order_id) THEN
      RETURN OLD;
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

LOCK TABLE public.purchase_orders IN SHARE ROW EXCLUSIVE MODE;

-- ── 2 + 3. The copy, the counter and the bill links ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  h RECORD;
  c RECORD;
  v_number TEXT;
  v_try INT;
  v_status TEXT;
  v_from TEXT;
  v_cc_type TEXT;
  v_cc1 UUID;
  v_cc2 UUID;
  v_notes TEXT;
  v_copied UUID[] := '{}';
  v_skipped INT := 0;
  v_skip_supplier INT := 0;
  v_skip_line INT := 0;
  v_skip_item_id INT := 0;
  v_received BOOLEAN;
  v_renamed INT := 0;
  v_links BIGINT := 0;
  v_prefix TEXT;
  v_max INT;
  v_off INT;
BEGIN
  FOR h IN
    SELECT s.*, sup.company_id AS supplier_company
      FROM public.supplier_purchase_orders s
      JOIN public.suppliers sup ON sup.id = s.supplier_id
     WHERE NOT EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = s.id)
     ORDER BY s.company_id, s.created_at, s.id
  LOOP
    IF h.supplier_company IS DISTINCT FROM h.company_id THEN
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%): its supplier is not its company''s', h.id, h.order_number;
      v_skipped := v_skipped + 1;
      v_skip_supplier := v_skip_supplier + 1;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i
                WHERE i.purchase_order_id = h.id AND (round(i.quantity, 2) <= 0 OR i.line_total < 0)) THEN
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%): a line has a quantity of 0 or less at 2 dp, or a negative total',
        h.id, h.order_number;
      v_skipped := v_skipped + 1;
      v_skip_line := v_skip_line + 1;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i JOIN public.po_items x ON x.id = i.id WHERE i.purchase_order_id = h.id) THEN
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%): a line id is already a po_items row', h.id, h.order_number;
      v_skipped := v_skipped + 1;
      v_skip_item_id := v_skip_item_id + 1;
      CONTINUE;
    END IF;

    v_number := h.order_number;
    v_try := 0;
    WHILE EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.company_id = h.company_id AND p.po_number = v_number) LOOP
      v_try := v_try + 1;
      v_number := h.order_number || '-SPO' || CASE WHEN v_try = 1 THEN '' ELSE v_try::TEXT END;
    END LOOP;
    IF v_try > 0 THEN
      RAISE NOTICE '1022: company % supplier_purchase_orders % number % is taken: copied as %', h.company_id, h.id, h.order_number, v_number;
      v_renamed := v_renamed + 1;
    END IF;

    v_received := NOT EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i
                               WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_received, 0) < i.quantity);
    v_status := CASE COALESCE(h.status, 'draft')
      WHEN 'draft' THEN 'draft' WHEN 'sent' THEN 'approved' WHEN 'partially_received' THEN 'partially_received'
      WHEN 'received' THEN 'received' WHEN 'cancelled' THEN 'cancelled' WHEN 'invoiced' THEN 'closed' END;
    v_from := CASE WHEN h.status = 'invoiced' THEN 'received' END;
    IF h.status = 'partially_invoiced' THEN
      IF EXISTS (SELECT 1 FROM public.supplier_invoices si
                  WHERE si.company_id = h.company_id AND si.supplier_id = h.supplier_id AND si.purchase_order_id = h.id
                    AND si.status <> 'cancelled' AND si.deleted_at IS NULL) THEN
        v_status := CASE WHEN v_received THEN 'received' ELSE 'partially_received' END;
      ELSE
        v_status := 'closed';
        v_from := CASE WHEN v_received THEN 'received' ELSE 'partially_received' END;
        RAISE NOTICE '1022: company % supplier_purchase_orders % (%) is partially_invoiced with no bill naming it: copied as closed from %',
          h.company_id, h.id, h.order_number, v_from;
      END IF;
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

    INSERT INTO public.purchase_orders (
      id, company_id, po_number, supplier_id, order_date, expected_delivery_date, status, closed_from_status,
      subtotal, tax_amount, total, notes, reference, created_by, created_at, updated_at
    ) VALUES (
      h.id, h.company_id, v_number, h.supplier_id, COALESCE(h.order_date, (h.created_at AT TIME ZONE 'UTC')::DATE, CURRENT_DATE),
      h.delivery_date, v_status, v_from, h.subtotal, h.tax_amount, h.total_amount, v_notes, h.reference, h.created_by::TEXT,
      h.created_at, h.updated_at
    );

    INSERT INTO public.po_items (
      id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount,
      quantity_received, quantity_invoiced, gl_account_id, item_id, cc1_id, cc2_id, sort_order, created_at
    )
    SELECT i.id, h.id, i.description, round(i.quantity, 2), round(i.line_total / round(i.quantity, 2), 6), i.tax_rate,
           i.line_total, i.tax_amount, round(COALESCE(i.qty_received, 0), 2), round(COALESCE(i.qty_invoiced, 0), 2),
           (SELECT g.id FROM public.gl_accounts g WHERE g.id = i.gl_account_id AND g.company_id = h.company_id),
           (SELECT it.id FROM public.items it WHERE it.id = i.item_id AND it.company_id = h.company_id),
           v_cc1, v_cc2, (row_number() OVER (ORDER BY i.created_at, i.id) - 1)::INT, i.created_at
      FROM public.supplier_purchase_order_items i
     WHERE i.purchase_order_id = h.id;

    v_copied := v_copied || h.id;
  END LOOP;

  FOR c IN
    SELECT s.status, count(DISTINCT s.id) AS heads, count(i.id) AS lines,
           count(i.id) FILTER (WHERE round(x.quantity * x.unit_price, 2) <> x.line_total) AS off
      FROM public.supplier_purchase_orders s
      LEFT JOIN public.supplier_purchase_order_items i ON i.purchase_order_id = s.id
      LEFT JOIN public.po_items x ON x.id = i.id
     WHERE s.id = ANY(v_copied)
     GROUP BY s.status ORDER BY s.status
  LOOP
    RAISE NOTICE '1022: copied % order(s), % line(s) of legacy status %', c.heads, c.lines, COALESCE(c.status, '(none)');
    IF c.off > 0 THEN
      RAISE WARNING '1022: % copied line(s) of status % do not give round(quantity x unit_price) = line_total (a quantity of 10 000 or more)',
        c.off, COALESCE(c.status, '(none)');
    END IF;
  END LOOP;
  RAISE NOTICE '1022: copied % order(s) in all, % skipped, % renamed', cardinality(v_copied), v_skipped, v_renamed;
  RAISE NOTICE '1022: skipped per reason: % supplier of another company, % line refused by po_items (quantity <= 0 at 2 dp or a negative total), % line id already in po_items',
    v_skip_supplier, v_skip_line, v_skip_item_id;

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
END $$;
