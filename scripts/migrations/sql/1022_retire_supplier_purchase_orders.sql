-- 1022: Retire supplier_purchase_orders (SPO, 247) into the canonical purchase_orders + po_items (design
-- docs/design/items-inventory-po-mcp.md, "Phase B: SPO retirement"; Hein, 18 Nov; review rounds of PR #1703, 20 Nov).
--
-- WHAT.
--   0. The role must bypass row security (rolsuper or rolbypassrls), or the migration refuses before it changes anything: the
--      legacy tables, purchase_orders and supplier_invoices are FORCE RLS with policies only for app_user / app_service, so a
--      role that did not bypass would read no rows, "copy 0" and retire the tables with their orders behind them. Production's
--      deploy role `postgres` is NOSUPERUSER BYPASSRLS (the integration runner creates it so: pg-cluster.sh pg_create_roles), and
--      that is how 1005's and 1006's backfills read every company's rows: no policy exemption, the role attribute.
--   1. supplier_purchase_orders and supplier_purchase_order_items refuse INSERT and UPDATE (BEFORE INSERT OR UPDATE, SECURITY
--      INVOKER, ENABLE ALWAYS, so session_replication_role = replica does not skip them): "retired: use purchase_orders".
--      DELETE is allowed: the copies are independent purchase orders the app edits and deletes, so no rule tied to them could
--      hold, and the Demo reseed's wipe (wipePlan.ts) deletes the legacy rows. TRUNCATE is not trapped. ENABLE ALWAYS needs table
--      ownership; the deploy role owns these tables, as it owned po_items (954: ENABLE ALWAYS TRIGGER trg_po_items_dimensions_check)
--      and purchase_orders (1006: trg_po_bill_links_supplier_guard), tables earlier migrations created. The triggers are created
--      FIRST: their SHARE ROW EXCLUSIVE lock holds the old colour's writes until this commits, and they are refused after, so
--      nothing it writes during the copy is lost. The tables are NOT dropped.
--   2. Each legacy header is copied into purchase_orders WITH THE SAME id, each line into po_items with the same id, so a
--      bill header (supplier_invoices.purchase_order_id) naming a legacy id now names a canonical PO. A header whose id is
--      already a purchase order of its own company was copied by an earlier run: skipped silently (a re-run is a no-op).
--        header: company, supplier (it must be the company's: suppliers.id is the same table), order date (a missing one
--          takes the created date in SAST), delivery date, subtotal / tax / total, reference and created_by exactly as stored;
--          notes + "Internal notes: ..." + the project id (purchase_orders has neither column) + a cost centre that is not
--          a CC1 / CC2 of the company (it survives only there: the cost-centre usage guard no longer counts it). A CC1 / CC2
--          cost centre goes onto every line (po_items.cc1_id / cc2_id). approved_by / approved_at stay NULL: no reader or
--          gate reads them (only the Approve action, the MCP update and set_purchase_order_status write them).
--        status: draft (or none) -> draft, cancelled -> cancelled, sent -> approved, partially_received and received as they
--          are; invoiced / partially_invoiced -> by quantity (received when every line is fully received, partially_received
--          when some is, else approved). The open copies KEEP their unbilled remainder in committed (Hein): committed spend
--          nets their bills, by lines or, for every legacy bill, by header (budgets/remainingHeaderBilled, this PR). A copy is
--          CLOSED, from the status it would have had, only when (a) it is fully billed: the same billing committed nets (bills
--          approved / paid / partially_paid of its company and supplier: by lines first, else the link amount, else the
--          subtotal less what the bill attributes elsewhere) reaches its subtotal less 1 cent; or (b) its legacy status was
--          invoiced and no live bill (not cancelled, not deleted, any status) of its company and supplier names it. A NOTICE
--          per closed copy. No app path reopens a closed copy today (set_purchase_order_status takes only an order with an
--          external_ref, which no copy carries; the PUT / update_purchase_order edit draft / submitted / approved only).
--        number: a (company, po_number) the canonical table already holds is NOT a failure (a failed production migration
--          blocks every release): the copy takes order_number || '-SPO', then '-SPO2', ... until free, its notes say
--          "was SPO <number>", and a NOTICE names it. No copy carries external_system / external_ref /
--          external_document_number (they would make the copy eligible for set_purchase_order_status).
--        line: line_total exactly as stored. The legacy line_total is NET: master's SPO writer stored line_total =
--          round(quantity x unit_price, 2) with the VAT in tax_amount (purchaseOrderService.ts:55/74, procurementService.ts:110),
--          subtotal = their sum, total = subtotal + tax; so the copy keeps figures as stored (dev's VAT-inclusive line totals
--          are seed junk, written outside the app on 2026-04-19). tax_rate = the line's, else the header's, else 15; tax_amount
--          = the line's, else round(line_total x rate / 100, 2). quantity to 2 dp, unit_price = line_total / quantity to 6 dp
--          (1001's effective ex-VAT price: a discount is in it). A line whose quantity is 0 or less at 2 dp, or whose 2-dp
--          quantity cannot give its total back to the cent (a quantity of 10 000 or more), is copied as 1 unit at its line
--          total, "(qty <original> @ <price>)" appended to its description, received / invoiced as the fraction of that unit;
--          a NOTICE per order. item_id only when it is the company's item, gl_account_id only when it is the company's account
--          (else NULL). sort_order by the legacy created_at.
--      SKIPPED, with a WARNING and a per-reason NOTICE (no table records them), the row left in the legacy table: a header
--      whose supplier is another company's, whose id is another company's purchase order, with a negative line total, or with
--      a line id po_items already holds; and, in a sub-transaction per order, any order a constraint or a numeric overflow
--      refuses (check, not null, unique, foreign key, numeric_value_out_of_range), so one unforeseen row is a WARNING, not an
--      aborted release. Then the migration RAISES unless copied + skipped = the legacy headers it set out to copy.
--   3. Per company copied: the purchase_order counter moves past the highest copied number of the counter's own form (prefix +
--      1-9 digits, as the PO import does; never back). The SPO writer issued "<prefix>-<padded>" (PO-0000005) from this same
--      counter (document_type 'purchase_order'), so its numbers are already behind the counter and are not of the canonical
--      form "<prefix><padded>": the step fires only for a hand-numbered or prefix-"-" order. purchase_order_bill_links_backfill
--      (company) (1006) links the bills that named a legacy id; then the close step above; then a NOTICE per order-date month
--      gives the committing copies, their ex-VAT line total and the billing that nets it (what entered committed spend).
--
-- LOCKS. SHARE ROW EXCLUSIVE on both legacy tables (the triggers) and on purchase_orders (LOCK TABLE: no app PO insert
--   can take a number between the free-number check and the copy's insert); ROW EXCLUSIVE on po_items,
--   company_document_numbers and purchase_order_bill_links. All held to commit; lock_timeout bounds each wait. The legacy
--   tables are small (dev: 204 headers).
--
-- OLD COLOUR. During the switch (a few minutes) the old code writes the legacy tables and is refused with the message above, a 500:
--   its supplier-purchase-orders pages and route, its supplier merge (route and duplicate merge, which re-parented
--   supplier_purchase_orders) and its item merge (supplier_purchase_order_items.item_id). A retry after the switch runs the new
--   code. It reads the legacy tables (unchanged); its canonical PO code sees the copies as ordinary purchase orders.
--
-- RUNBOOK. A data-only restore (pg_restore --data-only) into a schema that has 1022 is refused by these ENABLE ALWAYS triggers
--   (--disable-triggers needs a superuser): restore the legacy tables' data with the triggers dropped (rollback below), then
--   re-run this file to recreate them.
--
-- Rollback (down SQL; roll the code back first). The copies stay: they are ordinary purchase orders now, and bills may link
-- them. To make the legacy tables writable again:
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired ON public.supplier_purchase_orders;
--   DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired ON public.supplier_purchase_order_items;
--   DROP FUNCTION IF EXISTS public.supplier_purchase_orders_retired();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ── 0. A role that reads every row ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '1022 must run as a role that bypasses row security (production''s deploy role postgres does); % does not, so it would copy only the rows its policies show', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ── 1. The legacy tables refuse writes ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.supplier_purchase_orders_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is retired (migration 1022): use purchase_orders / po_items', TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported',
          HINT = 'Purchase orders live in purchase_orders; /accounting/purchase-orders is the page.';
END $$;
REVOKE ALL ON FUNCTION public.supplier_purchase_orders_retired() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_supplier_purchase_orders_retired ON public.supplier_purchase_orders;
CREATE TRIGGER trg_supplier_purchase_orders_retired BEFORE INSERT OR UPDATE ON public.supplier_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.supplier_purchase_orders_retired();
ALTER TABLE public.supplier_purchase_orders ENABLE ALWAYS TRIGGER trg_supplier_purchase_orders_retired;

DROP TRIGGER IF EXISTS trg_supplier_purchase_order_items_retired ON public.supplier_purchase_order_items;
CREATE TRIGGER trg_supplier_purchase_order_items_retired BEFORE INSERT OR UPDATE ON public.supplier_purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.supplier_purchase_orders_retired();
ALTER TABLE public.supplier_purchase_order_items ENABLE ALWAYS TRIGGER trg_supplier_purchase_order_items_retired;

LOCK TABLE public.purchase_orders IN SHARE ROW EXCLUSIVE MODE;

-- ── 2 + 3. The copy, the counter, the bill links, the close step, the committed record ──────────────────────────

DO $$
DECLARE
  h RECORD;
  c RECORD;
  v_number TEXT;
  v_try INT;
  v_status TEXT;
  v_any_recv BOOLEAN;
  v_all_recv BOOLEAN;
  v_cc_type TEXT;
  v_cc1 UUID;
  v_cc2 UUID;
  v_notes TEXT;
  v_reason TEXT;
  v_unit_lines INT;
  v_total INT;
  v_copied UUID[] := '{}';
  v_skip_supplier INT := 0;
  v_skip_negative INT := 0;
  v_skip_item_id INT := 0;
  v_skip_id_taken INT := 0;
  v_skip_error INT := 0;
  v_skipped INT;
  v_renamed INT := 0;
  v_closed INT := 0;
  v_unit_total INT := 0;
  v_links BIGINT := 0;
  v_prefix TEXT;
  v_max INT;
  v_off INT;
  v_billed JSONB;
BEGIN
  SELECT count(*) INTO v_total FROM public.supplier_purchase_orders s
   WHERE NOT EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.id = s.id AND p.company_id = s.company_id);

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
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%, company %): %', h.id, h.order_number, h.company_id, v_reason;
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

    v_any_recv := EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_received, 0) > 0);
    v_all_recv := EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i WHERE i.purchase_order_id = h.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_purchase_order_items i
                       WHERE i.purchase_order_id = h.id AND COALESCE(i.qty_received, 0) < i.quantity);
    v_status := CASE COALESCE(h.status, 'draft')
      WHEN 'draft' THEN 'draft' WHEN 'cancelled' THEN 'cancelled' WHEN 'sent' THEN 'approved'
      WHEN 'partially_received' THEN 'partially_received' WHEN 'received' THEN 'received'
      ELSE CASE WHEN v_all_recv THEN 'received' WHEN v_any_recv THEN 'partially_received' ELSE 'approved' END END;

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

    -- One sub-transaction per order: a row an unforeseen constraint or overflow refuses becomes a WARNING and a skip, never an
    -- aborted release.
    BEGIN
      INSERT INTO public.purchase_orders (
        id, company_id, po_number, supplier_id, order_date, expected_delivery_date, status,
        subtotal, tax_amount, total, notes, reference, created_by, created_at, updated_at
      ) VALUES (
        h.id, h.company_id, v_number, h.supplier_id,
        COALESCE(h.order_date, (h.created_at AT TIME ZONE 'Africa/Johannesburg')::DATE, CURRENT_DATE),
        h.delivery_date, v_status, h.subtotal, h.tax_amount, h.total_amount, v_notes, h.reference, h.created_by::TEXT,
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
             l.rate, l.line_total, COALESCE(l.tax_amount, round(l.line_total * l.rate / 100, 2)),
             CASE WHEN l.as_unit THEN round(LEAST(COALESCE(l.qty_received, 0) / NULLIF(l.quantity, 0), 1), 2) ELSE round(COALESCE(l.qty_received, 0), 2) END,
             CASE WHEN l.as_unit THEN round(LEAST(COALESCE(l.qty_invoiced, 0) / NULLIF(l.quantity, 0), 1), 2) ELSE round(COALESCE(l.qty_invoiced, 0), 2) END,
             (SELECT g.id FROM public.gl_accounts g WHERE g.id = l.gl_account_id AND g.company_id = h.company_id),
             (SELECT it.id FROM public.items it WHERE it.id = l.item_id AND it.company_id = h.company_id),
             v_cc1, v_cc2, (row_number() OVER (ORDER BY l.created_at, l.id) - 1)::INT, l.created_at
        FROM (SELECT i.*, round(i.quantity, 2) AS q2, COALESCE(i.tax_rate, h.tax_rate, 15) AS rate,
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
      IF v_unit_lines > 0 THEN
        RAISE NOTICE '1022: supplier_purchase_orders % (%): % line(s) copied as 1 unit at the line total (quantity at 2 dp could not give it)',
          h.id, h.order_number, v_unit_lines;
        v_unit_total := v_unit_total + v_unit_lines;
      END IF;
      v_copied := v_copied || h.id;
    EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR foreign_key_violation OR numeric_value_out_of_range THEN
      RAISE WARNING '1022: skipped supplier_purchase_orders % (%, company %): refused by the database (%): %',
        h.id, h.order_number, h.company_id, SQLSTATE, left(SQLERRM, 200);
      v_skip_error := v_skip_error + 1;
    END;
  END LOOP;

  v_skipped := v_skip_supplier + v_skip_negative + v_skip_item_id + v_skip_id_taken + v_skip_error;
  IF cardinality(v_copied) + v_skipped <> v_total THEN
    RAISE EXCEPTION '1022: % legacy order(s) to copy, % copied and % skipped: the rest were not seen (row security?)', v_total, cardinality(v_copied), v_skipped;
  END IF;

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

  -- The billing committed nets per copied PO (budgets/remainingHeaderBilled + billedLinesByPoItem, in SQL): bills approved / paid /
  -- partially_paid, not soft-deleted, of the PO's company and supplier; a bill with a line naming a line of the PO nets by those
  -- lines' posted cents, else by its link's amount, else by its subtotal less what its lines and other links attribute elsewhere.
  -- (Line netting in the app still counts a soft-deleted approved bill; for a copy only a legacy bill can line-link, never.)
  -- Kept in a variable, not a TEMP table: no DDL beyond the triggers.
  WITH cand AS (
    SELECT l.supplier_invoice_id AS bill, l.purchase_order_id AS po FROM public.purchase_order_bill_links l WHERE l.purchase_order_id = ANY(v_copied)
    UNION
    SELECT si.id, si.purchase_order_id FROM public.supplier_invoices si WHERE si.purchase_order_id = ANY(v_copied)
    UNION
    SELECT x.supplier_invoice_id, pi.purchase_order_id FROM public.supplier_invoice_items x JOIN public.po_items pi ON pi.id = x.po_item_id
     WHERE pi.purchase_order_id = ANY(v_copied)
  ), tie AS (
    SELECT cd.po, cd.bill, si.subtotal, l.amount AS link_amount,
           (SELECT COALESCE(SUM(p.cents), 0) FROM public.po_bill_posted_cents(cd.bill) p
              JOIN public.supplier_invoice_items x ON x.id = p.item_id JOIN public.po_items pi ON pi.id = x.po_item_id
             WHERE pi.purchase_order_id = cd.po) AS line_c,
           (SELECT COALESCE(SUM(p.cents), 0) FROM public.po_bill_posted_cents(cd.bill) p
              JOIN public.supplier_invoice_items x ON x.id = p.item_id WHERE x.po_item_id IS NOT NULL) AS named_c,
           (SELECT COALESCE(SUM(round(o.amount * 100)), 0) FROM public.purchase_order_bill_links o
             WHERE o.supplier_invoice_id = cd.bill AND o.purchase_order_id <> cd.po) AS other_c,
           EXISTS (SELECT 1 FROM public.supplier_invoice_items x JOIN public.po_items pi ON pi.id = x.po_item_id
                    WHERE x.supplier_invoice_id = cd.bill AND pi.purchase_order_id = cd.po) AS by_lines
      FROM cand cd
      JOIN public.purchase_orders po ON po.id = cd.po
      JOIN public.supplier_invoices si ON si.id = cd.bill AND si.company_id = po.company_id AND si.supplier_id = po.supplier_id
      LEFT JOIN public.purchase_order_bill_links l ON l.purchase_order_id = cd.po AND l.supplier_invoice_id = cd.bill
     WHERE si.status IN ('approved', 'paid', 'partially_paid') AND si.deleted_at IS NULL
  )
  SELECT COALESCE(jsonb_object_agg(g.po, g.cents), '{}'::JSONB) INTO v_billed FROM (
    SELECT t.po::TEXT AS po, SUM(CASE WHEN t.by_lines THEN t.line_c
                                      WHEN t.link_amount IS NOT NULL THEN round(t.link_amount * 100)
                                      ELSE GREATEST(0, round(t.subtotal * 100) - t.named_c - t.other_c) END)::BIGINT AS cents
      FROM tie t GROUP BY t.po) g;

  FOR h IN
    SELECT p.id, p.company_id, p.po_number, p.status, s.status AS legacy, round(COALESCE(p.subtotal, 0) * 100)::BIGINT AS sub_c,
           COALESCE((v_billed ->> p.id::TEXT)::BIGINT, 0) AS billed_c,
           EXISTS (SELECT 1 FROM public.supplier_invoices si
                    WHERE si.company_id = p.company_id AND si.supplier_id = p.supplier_id AND si.purchase_order_id = p.id
                      AND si.status <> 'cancelled' AND si.deleted_at IS NULL) AS live_bill
      FROM public.purchase_orders p
      JOIN public.supplier_purchase_orders s ON s.id = p.id
     WHERE p.id = ANY(v_copied) AND p.status IN ('approved', 'partially_received', 'received')
     ORDER BY p.company_id, p.id
  LOOP
    IF h.billed_c >= h.sub_c - 1 OR (h.legacy = 'invoiced' AND NOT h.live_bill) THEN
      UPDATE public.purchase_orders SET status = 'closed', closed_from_status = h.status WHERE id = h.id;
      RAISE NOTICE '1022: company % purchase order % (%) copied as closed from %: %', h.company_id, h.id, h.po_number, h.status,
        CASE WHEN h.billed_c >= h.sub_c - 1 THEN format('fully billed (R %s of R %s)', h.billed_c / 100.0, h.sub_c / 100.0)
             ELSE 'legacy invoiced, and no live bill names it' END;
      v_closed := v_closed + 1;
    END IF;
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
  RAISE NOTICE '1022: copied % order(s) in all, % skipped, % renamed, % closed, % line(s) as 1 unit',
    cardinality(v_copied), v_skipped, v_renamed, v_closed, v_unit_total;
  RAISE NOTICE '1022: skipped per reason: % supplier of another company, % negative line total, % line id already in po_items, % id already a purchase order of another company, % refused by the database',
    v_skip_supplier, v_skip_negative, v_skip_item_id, v_skip_id_taken, v_skip_error;
  RAISE NOTICE '1022: % bill link(s) written for the copied orders (each backfill call above gives its written / skipped)', v_links;

  -- What entered committed spend (budgets/remainingCommitted: approved / partially_received / received POs), per company and
  -- order-date month, ex VAT: the release log's record of the jump. Billing netted is capped at each PO's line total.
  FOR c IN
    SELECT p.company_id, to_char(p.order_date, 'YYYY-MM') AS month, count(*) AS orders, SUM(t.lt) AS ex_vat,
           SUM(LEAST(COALESCE((v_billed ->> p.id::TEXT)::BIGINT, 0), round(t.lt * 100)) / 100.0)::NUMERIC(19,2) AS netted
      FROM public.purchase_orders p
      CROSS JOIN LATERAL (SELECT COALESCE(SUM(x.line_total), 0) AS lt FROM public.po_items x WHERE x.purchase_order_id = p.id) t
     WHERE p.id = ANY(v_copied) AND p.status IN ('approved', 'partially_received', 'received')
     GROUP BY p.company_id, to_char(p.order_date, 'YYYY-MM') ORDER BY 1, 2
  LOOP
    RAISE NOTICE '1022: company % committing copies, order month %: % order(s), R % ex VAT, less R % billed', c.company_id, c.month, c.orders, c.ex_vat, c.netted;
  END LOOP;
END $$;
