-- 1006: Purchase order <-> bill links (MCP link_bills_to_purchase_order / unlink_bill_from_purchase_order).
-- Design: docs/design/mcp-po-bill-links.md (decisions 1, 3, 4, 11).
--
-- WHAT. purchase_order_bill_links: one row per (company, purchase order, bill) saying "this bill was billed against
-- this PO, for this ex-VAT amount". A bill may name several POs (Sage does), which supplier_invoices.purchase_order_id
-- (one PO per bill) cannot say. The row stores the amount so a bill's split across POs never changes later;
-- `source` is who wrote it (mcp tool, the app's bill create, or this migration's backfill); external_system +
-- external_ref make a link idempotent for a migration load (a ref-less app / backfill link can ADOPT one later);
-- closed_po_from_status records the status the PO was in when a link's call closed it (close_when_fully_billed), so an
-- unlink can reopen it. A link posts nothing: no gl_journal_* row, no change to a bill's status, totals or amount_paid.
--
-- AMOUNT (decision 4), one rule everywhere: the posted ex-VAT of the bill lines that name a line of that PO, where
-- "posted" is what APPROVE posts for a line (ap/supplierInvoiceExpenseLines.expenseLineNets: lines stored gross are
-- scaled to the subtotal, the last line takes the rounding residual, a R0 line posts nothing).
-- po_bill_posted_cents(bill) is that function in SQL, in the same float arithmetic and the same line order as the
-- TypeScript, so the backfill and the app agree to the cent (tests/integration/mcp-po-bill-links-amounts.int.test.ts runs
-- both on the same bills). A PO the bill names only by its header (or whose lines post nothing) gets the bill's subtotal
-- less what the line-linked POs hold; of several such POs only the lowest id (byte order of its text) is linked. Never above zero or below.
--
-- BACKFILL. purchase_order_bill_links_backfill([company]): one `backfill` link per non-cancelled, non-deleted bill of ANY other status (a
-- draft or pending bill too: approving a bill writes no link, so a bill that was a draft at the release, or that the OLD colour
-- created, would otherwise never get one; the app sync owns ref-less `app` / `backfill` links of an unposted bill and remakes them
-- on its next edit, so a draft's link cannot go stale for good), for each
-- purchase_orders row of the same company AND supplier that the bill's header names OR that its lines name, the PO in an
-- approved / partially_received / received / closed status (a stale or foreign id, an older supplier_purchase_orders id, a draft
-- or cancelled PO gets none). It runs here, BEFORE row security and the guards exist, and is idempotent (ON CONFLICT DO NOTHING
-- on the pair; a header-only / zero-posting PO gets the subtotal less the bill's other links that this writer does not own, as
-- the app sync does, so a re-run never pushes a bill's links past its subtotal). RE-RUN IT ONCE AFTER THE RELEASE goes live
-- (`SELECT purchase_order_bill_links_backfill();` as the deploy role, `postgres`, which bypasses row security): a bill the OLD
-- colour created or approved between this migration and the switch has no link until then. A row that changes while it runs (a concurrent delete) is skipped with a WARNING, never aborts it (the post-release re-run is live). Executable by the migration / deploy role only; the guard lets `postgres` and `migration_admin` write source
-- `backfill` and no other role.
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy, verbatim. app_user reads, INSERTs the payload columns, DELETEs (an unlink) and
--     UPDATEs only external_system / external_ref / closed_po_from_status (adopting a reference; moving the closing
--     record to another link of the same PO).
--   - One link per (company, PO, bill); one link per (company, external_system, external_ref) where a ref is given
--     (the system is stored lower case). amount > 0.
--   - purchase_order_bill_links_guard (BEFORE INSERT OR UPDATE, SECURITY INVOKER, so RLS applies to its reads: a caller
--     is refused a PO or bill it cannot see): the PO and the bill must both be the row's company's, and of the same supplier;
--     `source = 'backfill'` only from `postgres` / `migration_admin` (not app_user, app_service, platform_admin ...); closed_po_from_status only while the PO is closed; a reference, once set,
--     never changes; nothing but those three columns changes.
--   - purchase_order_bill_links_supplier_guard (BEFORE UPDATE OF supplier_id on purchase_orders and supplier_invoices):
--     a PO or a bill that has a link cannot change supplier, so a link can never become cross-supplier (supplier merge,
--     a draft edit, the PO PUT). The code refuses earlier with a reason; this is the last line. SECURITY DEFINER, owned by
--     migration_admin (BYPASSRLS), pinned search_path, registered in app_definer_reviews (930): it must see EVERY link of the
--     row whatever the caller's row security shows (an invoker that sees none, a role with no company set, would pass silently).
--
-- LOCKS. REFERENCES takes SHARE ROW EXCLUSIVE on companies, purchase_orders and supplier_invoices while the table is
-- created, and the two triggers on purchase_orders / supplier_invoices take SHARE ROW EXCLUSIVE too (writers wait,
-- readers do not; lock_timeout bounds the wait). The backfill reads supplier_invoices, supplier_invoice_items,
-- purchase_orders and po_items. The OLD COLOUR never reads or writes the table: it keeps working, and a bill it creates
-- between this migration and the new colour's first request gets no `app` link (the next backfill run covers it).
--
-- Rollback (code first; links are metadata, no ledger row depends on them). A rollback does NOT undo what link calls did to
-- other rows: supplier_invoice_items.po_item_id and supplier_invoices.purchase_order_id stay as set, and a PO a link call
-- closed (close_when_fully_billed) stays closed; reopen those by hand if they matter:
--   DROP TRIGGER IF EXISTS trg_po_bill_links_supplier_guard ON public.purchase_orders;
--   DROP TRIGGER IF EXISTS trg_po_bill_links_supplier_guard ON public.supplier_invoices;
--   DROP TRIGGER IF EXISTS trg_purchase_order_bill_links_guard ON public.purchase_order_bill_links;
--   DELETE FROM public.app_definer_reviews WHERE signature = 'purchase_order_bill_links_supplier_guard()';
--   DROP FUNCTION IF EXISTS public.purchase_order_bill_links_supplier_guard();
--   DROP FUNCTION IF EXISTS public.purchase_order_bill_links_guard();
--   DROP FUNCTION IF EXISTS public.purchase_order_bill_links_backfill(UUID);
--   DROP FUNCTION IF EXISTS public.po_bill_posted_cents(uuid);
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
  -- clock_timestamp(), not now(): the links one call makes keep the order they were made in.
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT purchase_order_bill_links_pair_uq UNIQUE (company_id, purchase_order_id, supplier_invoice_id),
  CONSTRAINT purchase_order_bill_links_ref_pair CHECK ((external_system IS NULL) = (external_ref IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_bill_links_ref_uq
  ON purchase_order_bill_links (company_id, external_system, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_order_bill_links_bill
  ON purchase_order_bill_links (company_id, supplier_invoice_id);

-- ── What APPROVE posts for each line of a bill, in cents (expenseLineNets in SQL) ──────────────────────────────

CREATE OR REPLACE FUNCTION public.po_bill_posted_cents(p_bill UUID)
RETURNS TABLE (item_id UUID, cents BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  h RECORD;
  r RECORD;
  n INT := 0;
  i INT;
  ids UUID[] := '{}';
  lts FLOAT8[] := '{}';
  debits FLOAT8[] := '{}';
  sum_lt FLOAT8 := 0;
  gross BOOLEAN;
  allocated FLOAT8 := 0;
  d FLOAT8;
  largest INT := 0;
  last_d FLOAT8;
BEGIN
  SELECT si.subtotal::FLOAT8 AS sub, si.total_amount::FLOAT8 AS tot, COALESCE(si.tax_rate, 0)::FLOAT8 AS rate INTO h
    FROM supplier_invoices si WHERE si.id = p_bill;
  IF NOT FOUND THEN RETURN; END IF;
  -- The same order as SUPPLIER_INVOICE_LINE_ORDER_BY (ap/supplierInvoiceLineOrder.ts), which the posting reads in.
  FOR r IN
    SELECT sii.id, sii.line_total::FLOAT8 AS lt FROM supplier_invoice_items sii WHERE sii.supplier_invoice_id = p_bill
     ORDER BY sii.created_at, sii.description, sii.gl_account_id, sii.quantity, sii.unit_price, sii.tax_rate, sii.tax_amount,
              sii.line_total, sii.project_id, sii.cost_center_id, sii.vat_classification, sii.id
  LOOP
    n := n + 1;
    ids := ids || r.id;
    lts := lts || r.lt;
    sum_lt := sum_lt + r.lt;
  END LOOP;
  IF n = 0 THEN RETURN; END IF;
  gross := h.rate > 0 AND abs(sum_lt - h.tot) < 0.02;
  FOR i IN 1..n LOOP
    IF i = n THEN
      d := floor((h.sub - allocated) * 100 + 0.5) / 100;
    ELSIF gross AND sum_lt > 0 THEN
      d := floor(lts[i] * (h.sub / sum_lt) * 100 + 0.5) / 100;
    ELSE
      d := floor(lts[i] * 100 + 0.5) / 100;
    END IF;
    allocated := allocated + d;
    debits := debits || d;
  END LOOP;
  -- foldRoundingOvershoot: a scaled bill's sub-cent-per-line NEGATIVE last line folds into the largest other line (ties: later).
  last_d := debits[n];
  IF gross AND lts[n] >= 0 AND last_d < 0 AND -last_d <= n * 0.01 + 1e-9 THEN
    FOR i IN 1..n - 1 LOOP
      IF largest = 0 OR debits[i] >= debits[largest] THEN largest := i; END IF;
    END LOOP;
    IF largest <> 0 THEN
      debits[largest] := floor((debits[largest] + last_d) * 100 + 0.5) / 100;
      debits[n] := 0;
    END IF;
  END IF;
  FOR i IN 1..n LOOP
    item_id := ids[i];
    cents := round(debits[i] * 100)::BIGINT;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ── The backfill ────────────────────────────────────────────────────────────

-- p_company NULL: every company (the migration, the post-release re-run); a company id: that company's bills only (a tenant-sized re-run, and
-- what tests use so they never touch another suite's or tenant's rows). Returns the links written.
-- It never aborts on a row that changed under it: the table's guard (and the FK) read with a fresh statement snapshot, so a PO or bill that is
-- deleted, or moved to another supplier, after this call chose its row would raise inside the INSERT. Each row is inserted in its own
-- sub-transaction; a refusal of the guard (check_violation) or an FK (foreign_key_violation) skips that row with a WARNING and the rest go on.
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
  WITH cand AS (
    SELECT si.id, si.company_id, si.supplier_id, si.purchase_order_id AS header_po, round(si.subtotal * 100)::BIGINT AS sub_c,
           -- What the bill's links this writer does not own (mcp, or with an external reference) already hold.
           COALESCE((SELECT SUM(round(l.amount * 100)) FROM purchase_order_bill_links l
                      WHERE l.company_id = si.company_id AND l.supplier_invoice_id = si.id
                        AND NOT (l.source IN ('app', 'backfill') AND l.external_ref IS NULL)), 0)::BIGINT AS held_c
      FROM supplier_invoices si
     WHERE si.status <> 'cancelled' AND si.deleted_at IS NULL AND (p_company IS NULL OR si.company_id = p_company)
       AND (si.purchase_order_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM supplier_invoice_items x WHERE x.supplier_invoice_id = si.id AND x.po_item_id IS NOT NULL))
  ), posted AS MATERIALIZED (
    -- Once per candidate bill, and carrying the bill's company / supplier / subtotal, so that line_po never joins the CTE `cand` (no
    -- statistics: the planner took it for ~3 000 rows and joined it to every PO of the supplier first: bills x POs rows, 40 s for 40 000 bills).
    SELECT c.id AS bill, c.company_id, c.supplier_id, c.sub_c, p.item_id, p.cents
      FROM cand c CROSS JOIN LATERAL public.po_bill_posted_cents(c.id) p
  ), line_po AS MATERIALIZED (
    SELECT p.bill, po.id AS po, LEAST(SUM(p.cents), p.sub_c)::BIGINT AS cents
      FROM posted p
      JOIN supplier_invoice_items sii ON sii.id = p.item_id
      JOIN po_items pi ON pi.id = sii.po_item_id
      JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = p.company_id AND po.supplier_id = p.supplier_id
                             AND po.status IN ('approved', 'partially_received', 'received', 'closed')
     GROUP BY p.bill, po.id, p.sub_c
  ), parts AS (
    SELECT bill, po, cents FROM line_po
    UNION ALL
    SELECT c.id, po.id, NULL::BIGINT
      FROM cand c
      JOIN purchase_orders po ON po.id = c.header_po AND po.company_id = c.company_id AND po.supplier_id = c.supplier_id
                             AND po.status IN ('approved', 'partially_received', 'received', 'closed')
     WHERE (c.id, po.id) NOT IN (SELECT l.bill, l.po FROM line_po l)
  ), sized AS (
    SELECT pt.bill, pt.po, pt.cents, c.company_id, c.sub_c, c.held_c, COALESCE(pt.cents, 0) > 0 AS positive,
           COALESCE(SUM(pt.cents) FILTER (WHERE pt.cents > 0) OVER (PARTITION BY pt.bill), 0) AS pos_total,
           MIN(pt.po::TEXT COLLATE "C") FILTER (WHERE COALESCE(pt.cents, 0) <= 0) OVER (PARTITION BY pt.bill) AS first_fallback
      FROM parts pt JOIN cand c ON c.id = pt.bill
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

-- ── The guards ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_order_bill_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM purchase_orders po
        JOIN supplier_invoices si ON si.supplier_id = po.supplier_id AND si.company_id = po.company_id
       WHERE po.id = NEW.purchase_order_id AND si.id = NEW.supplier_invoice_id AND po.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'a purchase order link joins a purchase order and a bill of one company and one supplier'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.source = 'backfill' AND current_user NOT IN ('postgres', 'migration_admin') AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      RAISE EXCEPTION 'only the migration backfill (postgres, migration_admin) writes source backfill' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id
       OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a purchase order link changes only its reference and its closing record' USING ERRCODE = '23514';
    END IF;
    IF OLD.external_ref IS NOT NULL AND (NEW.external_system IS DISTINCT FROM OLD.external_system
                                         OR NEW.external_ref IS DISTINCT FROM OLD.external_ref) THEN
      RAISE EXCEPTION 'a purchase order link''s external reference does not change once set' USING ERRCODE = '23514';
    END IF;
    IF NEW.closed_po_from_status IS NOT NULL AND OLD.closed_po_from_status IS NOT NULL
       AND NEW.closed_po_from_status IS DISTINCT FROM OLD.closed_po_from_status THEN
      RAISE EXCEPTION 'a closing record is moved or cleared, not rewritten' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- The closing record is a claim about the PO: only while it is closed.
  IF NEW.closed_po_from_status IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.closed_po_from_status IS NULL)
     AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = NEW.purchase_order_id AND po.company_id = NEW.company_id
                        AND po.status = 'closed') THEN
    RAISE EXCEPTION 'a closing record names a purchase order that is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_purchase_order_bill_links_guard ON purchase_order_bill_links;
CREATE TRIGGER trg_purchase_order_bill_links_guard BEFORE INSERT OR UPDATE ON purchase_order_bill_links
  FOR EACH ROW EXECUTE FUNCTION public.purchase_order_bill_links_guard();
ALTER TABLE purchase_order_bill_links ENABLE ALWAYS TRIGGER trg_purchase_order_bill_links_guard;

CREATE OR REPLACE FUNCTION public.purchase_order_bill_links_supplier_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id AND EXISTS (
    SELECT 1 FROM purchase_order_bill_links l
     WHERE l.company_id = OLD.company_id
       AND CASE WHEN TG_TABLE_NAME = 'purchase_orders' THEN l.purchase_order_id ELSE l.supplier_invoice_id END = OLD.id
  ) THEN
    RAISE EXCEPTION 'a purchase order or bill that is linked cannot change supplier; unlink it first' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.purchase_order_bill_links_supplier_guard() OWNER TO migration_admin;
DROP TRIGGER IF EXISTS trg_po_bill_links_supplier_guard ON purchase_orders;
CREATE TRIGGER trg_po_bill_links_supplier_guard BEFORE UPDATE OF supplier_id ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.purchase_order_bill_links_supplier_guard();
DROP TRIGGER IF EXISTS trg_po_bill_links_supplier_guard ON supplier_invoices;
CREATE TRIGGER trg_po_bill_links_supplier_guard BEFORE UPDATE OF supplier_id ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.purchase_order_bill_links_supplier_guard();
ALTER TABLE purchase_orders ENABLE ALWAYS TRIGGER trg_po_bill_links_supplier_guard;
ALTER TABLE supplier_invoices ENABLE ALWAYS TRIGGER trg_po_bill_links_supplier_guard;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE purchase_order_bill_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_bill_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order_bill_links;
CREATE POLICY tenant_isolation ON purchase_order_bill_links FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- 348's default privileges gave app_user every command: take them back, grant per column.
REVOKE INSERT, UPDATE, DELETE ON purchase_order_bill_links FROM app_user;
GRANT SELECT, DELETE ON purchase_order_bill_links TO app_user;
-- The supplier guard (SECURITY DEFINER, owner migration_admin) reads this table: grant it explicitly, not by default privileges.
GRANT SELECT ON purchase_order_bill_links TO migration_admin;
GRANT INSERT (company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref,
              closed_po_from_status, created_by) ON purchase_order_bill_links TO app_user;
GRANT UPDATE (external_system, external_ref, closed_po_from_status) ON purchase_order_bill_links TO app_user;

REVOKE ALL ON FUNCTION public.purchase_order_bill_links_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_order_bill_links_supplier_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_order_bill_links_backfill(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.po_bill_posted_cents(UUID) FROM PUBLIC;

-- The definer registry (930): the supplier guard reads purchase_order_bill_links whatever the caller's row security shows.
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('purchase_order_bill_links_supplier_guard()', 'public.purchase_order_bill_links_supplier_guard()',
     'nothing (reads purchase_order_bill_links; raises when a PO or bill that has a link changes supplier); trigger function, no EXECUTE for app roles')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.purchase_order_bill_links_supplier_guard()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.purchase_order_bill_links_supplier_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION '1006: a role it must not reach can execute the supplier guard';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT pg_catalog.has_table_privilege('migration_admin', 'public.purchase_order_bill_links', 'SELECT') THEN
    RAISE EXCEPTION '1006: migration_admin cannot read purchase_order_bill_links, so the supplier guard would see no links';
  END IF;
END $$;

-- The service pool reaches the table through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
