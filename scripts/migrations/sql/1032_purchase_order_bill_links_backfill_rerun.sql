-- 1032: purchase-order <-> bill links backfill: no double count beside a stale link, then re-run once for every company.
-- Design: docs/design/po-bill-links-backfill.md. Function: purchase_order_bill_links_backfill(UUID) (1006, redefined by 1022, again here).
--
-- WHY THE REDEFINITION. 1022's function sized a header-only (or zero-posting) PO as the subtotal less the links this writer does NOT own, so a
-- stale `backfill` / `app` link to ANOTHER PO (the header was re-pointed outside the app; no line names it) was not subtracted, and the header PO
-- got the full subtotal beside it: A 100.00 + B 100.00 on a 100.00 bill. The one change here: that remainder subtracts every link the bill
-- already has on a PO its lines do not name, of any source (the NOT (source IN ('app','backfill') ...) clause is gone from held_c). Arithmetic:
-- header PO gets subtotal - lines' posted cents - existing links elsewhere, never <= 0, so a bill's links sum to at most its subtotal. A stale
-- 100.00 link on a 100.00 bill leaves 0: no second link. A stale 30.00 leaves 70.00: the remainder, not the whole. A link on a PO the lines
-- name is still not subtracted (the lines account for it, 1022 BRK-B). Everything else is 1022's body verbatim. Signature, SECURITY INVOKER,
-- search_path, owner and grants are unchanged (CREATE OR REPLACE keeps the ACL: executable by the migration / deploy role only), so there is no
-- app_definer_reviews row. The app's TypeScript sync (billPurchaseOrderLinks.planBillLinks) still subtracts only links it does not own, because
-- it first remakes its own; the backfill never touches an existing link, so it is the more conservative of the two where a stale owned link exists.
--
-- WHAT. Then one call, all companies. A bill created or edited before the new code wrote its `app` links (or by the old colour between
-- 1006 and the switch) has no link until this runs; 1006's header asks for exactly this re-run after the release. It writes only
-- `backfill` links, ON CONFLICT DO NOTHING on (company, PO, bill): idempotent, a second run writes 0, an existing link of any source is
-- never touched. No GL row, no change to a bill or a PO. Existing links sized under 1006's / 1022's rule are not corrected.
--
-- LOCKS. CREATE OR REPLACE FUNCTION takes a lock on the function row only. The call reads, then INSERTs into purchase_order_bill_links
-- (ROW EXCLUSIVE): no LOCK TABLE, no table DDL, no FOR UPDATE. The foreign keys take FOR KEY SHARE on the linked company / PO / bill rows until
-- this file's transaction commits; that conflicts only with a DELETE or key change of those rows. lock_timeout bounds a wait behind such a
-- transaction; statement_timeout bounds the loop. On either the file fails whole, nothing is written, and the release retries.
--
-- Rollback (not part of the migration; as the migration role; links are metadata and no ledger row depends on them): put 1022's definition
-- back (its section 1b) and
--   DELETE FROM public.purchase_order_bill_links WHERE source = 'backfill';

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE OR REPLACE FUNCTION public.purchase_order_bill_links_backfill(p_company UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  inserted BIGINT := 0;
  skipped BIGINT := 0;
  n BIGINT;
  r RECORD;
BEGIN
  FOR r IN
  -- THE PLAN HAS NO bills x POs SHAPE, WHATEVER THE STATISTICS. Every join is on a key: a bill to its lines' posted cents (the function, per
  -- bill), a line to its po_items row (id), a po_items row to its PO (id), a bill to its header PO (id). The bill's company / supplier and the
  -- PO's status are compared only AFTER `pairs` is materialized, as a filter on one row: never as a join clause, which lets the planner join
  -- bills to every PO of their supplier (it did: the bill lines, a CTE without statistics, merge-joined to purchase_orders ON company AND
  -- supplier, estimated at 41 rows, were 982 167 for 1 300 bills x 400 POs). Nothing below `pairs` joins: a header PO that a line also names
  -- folds into the line's pair by GROUP BY (no NOT IN / anti join against a CTE, which nested loops rescan once per bill), and the bill's
  -- company / subtotal / held cents ride along instead of being joined back.
  WITH cand AS MATERIALIZED (
    SELECT si.id, si.company_id, si.supplier_id, si.purchase_order_id AS header_po, round(si.subtotal * 100)::BIGINT AS sub_c,
           -- What the bill's links already hold, of ANY source (1032: 1022 left out the links this writer owns, so a stale `backfill` / `app` link to
           -- a PO the bill's header no longer names was counted on top of the header PO's full subtotal).
           COALESCE((SELECT SUM(round(l.amount * 100)) FROM purchase_order_bill_links l
                      WHERE l.company_id = si.company_id AND l.supplier_invoice_id = si.id
                        -- 1022 (PR #1703, breaker BRK-B): not a link of a PO the bill's lines name: the lines account for it.
                        AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                                         WHERE x.supplier_invoice_id = si.id AND pi.purchase_order_id = l.purchase_order_id)), 0)::BIGINT AS held_c
      FROM supplier_invoices si
     WHERE si.status <> 'cancelled' AND si.deleted_at IS NULL AND (p_company IS NULL OR si.company_id = p_company)
       AND (si.purchase_order_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM supplier_invoice_items x WHERE x.supplier_invoice_id = si.id AND x.po_item_id IS NOT NULL))
  ), pairs AS MATERIALIZED (
    -- One row per bill line that names a PO line (its posted cents; po_bill_posted_cents once per bill) and one per bill header, each with
    -- the PO it reaches BY ID and that PO's company / supplier / status, unfiltered: MATERIALIZED keeps the filter below out of these joins.
    SELECT c.id AS bill, c.company_id, c.supplier_id, c.sub_c, c.held_c, TRUE AS by_line, p.cents,
           po.id AS po, po.company_id AS po_company, po.supplier_id AS po_supplier, po.status AS po_status
      FROM cand c
      CROSS JOIN LATERAL public.po_bill_posted_cents(c.id) p
      JOIN supplier_invoice_items sii ON sii.id = p.item_id
      JOIN po_items pi ON pi.id = sii.po_item_id
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
    UNION ALL
    SELECT c.id, c.company_id, c.supplier_id, c.sub_c, c.held_c, FALSE, NULL::BIGINT,
           po.id, po.company_id, po.supplier_id, po.status
      FROM cand c
      JOIN purchase_orders po ON po.id = c.header_po
  ), parts AS (
    -- Per (bill, PO) of the bill's company and supplier, PO linkable: the posted cents of the lines that name it (at most the subtotal), or
    -- NULL when only the header names it.
    SELECT pr.bill, pr.po, pr.company_id, pr.sub_c, pr.held_c,
           CASE WHEN bool_or(pr.by_line) THEN LEAST(SUM(pr.cents) FILTER (WHERE pr.by_line), pr.sub_c)::BIGINT END AS cents
      FROM pairs pr
     WHERE pr.po_company = pr.company_id AND pr.po_supplier = pr.supplier_id
       AND pr.po_status IN ('approved', 'partially_received', 'received', 'closed')
     GROUP BY pr.bill, pr.po, pr.company_id, pr.sub_c, pr.held_c
  ), sized AS (
    SELECT pt.bill, pt.po, pt.cents, pt.company_id, pt.sub_c, pt.held_c, COALESCE(pt.cents, 0) > 0 AS positive,
           COALESCE(SUM(pt.cents) FILTER (WHERE pt.cents > 0) OVER (PARTITION BY pt.bill), 0) AS pos_total,
           MIN(pt.po::TEXT COLLATE "C") FILTER (WHERE COALESCE(pt.cents, 0) <= 0) OVER (PARTITION BY pt.bill) AS first_fallback
      FROM parts pt
  ), amounts AS (
    SELECT s.company_id, s.po, s.bill, CASE WHEN s.positive THEN s.cents ELSE s.sub_c - s.pos_total - s.held_c END AS cents
      FROM sized s WHERE s.positive OR (s.po::TEXT COLLATE "C") = s.first_fallback
  )
  SELECT a.company_id, a.po, a.bill, a.cents FROM amounts a WHERE a.cents > 0 ORDER BY a.bill, a.po
  LOOP
    BEGIN
      INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source)
      VALUES (r.company_id, r.po, r.bill, r.cents / 100.0, 'backfill')
      ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      inserted := inserted + n;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      skipped := skipped + 1;
      RAISE WARNING 'purchase_order_bill_links_backfill: skipped purchase order % / bill % (it changed while the backfill ran): %', r.po, r.bill, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'purchase_order_bill_links_backfill: % link(s) written, % skipped', inserted, skipped;
  RETURN inserted;
END;
$$;

SELECT public.purchase_order_bill_links_backfill();
