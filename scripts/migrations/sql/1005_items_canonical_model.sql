-- 1005: Items canonical model, Phase A of the Items / Inventory / PO MCP programme (docs/design/items-inventory-po-mcp.md).
--
-- WHAT.
--   items                 external_system / external_ref / external_document_number (the source system's identity of the
--                         catalogue entry; a partial UNIQUE index on (company_id, external_system, external_ref) where a
--                         reference is present makes bulk_upsert_items idempotent and race-safe) and inventory_tracked
--                         (default false: a Sage service code with a work-unit counter is a service, never stock), with
--                         CHECK (item_type = 'physical' OR NOT inventory_tracked). sales_account_id / purchases_account_id
--                         get foreign keys to gl_accounts (they had none), so an account that an item names cannot be
--                         merged or deleted from under it: the GL account merge's reference sweep reads the catalogue's
--                         FKs and refuses a merge that would leave an item pointing at the source account.
--                         cost_price (= purchase price), selling_price_excl (= sales price), vat_on_sales /
--                         vat_on_purchases, item_type and is_active are reused.
--   item_categories       code (nullable; unique per company when present), external_system / external_ref (unique per
--                         company when present), is_active.
--   stock_movements       company_id (FK companies) and item_id (FK items). company_id is backfilled from
--   stock_levels          products.company_id; stock_levels gets company_id only. A BEFORE INSERT trigger (SECURITY
--                         INVOKER, so it reads products under the caller's own row level security) fills a NULL
--                         company_id from the row's product, so a writer that does not name the column (the old release,
--                         the seeders, other branches' tests) still writes a company-scoped row. There is NO CHECK
--                         (company_id IS NOT NULL): legacy movements of a product that has no company stay NULL and a
--                         superuser may still insert one (master's stock-valuation tests do, for the orphan case); a
--                         tenant session cannot, because the RLS WITH CHECK below needs company_id = the request's company.
--                         Both tables then get the tenant policies of `items` (tenant_isolation for app_user plus the
--                         app_service mirrors, app_service_sync_policies).
--   po_items / supplier_invoice_items / customer_invoice_items / customer_quote_lines
--                         item_id (FK items), nullable: a line may name the catalogue item it is for. Each column and
--                         each FK is added in its own guarded step: customer_invoice_items.item_id (migration 311 indexes
--                         it; duplicateMergeService writes it) and others may already exist on a database, so ADD COLUMN IF
--                         NOT EXISTS ... REFERENCES would skip the FK silently. The step adds the column, adds the FK
--                         NOT VALID when no FK on that column references items yet, and VALIDATEs it when no orphan row
--                         exists (otherwise it says so in a NOTICE and leaves it NOT VALID). A column that exists with a
--                         type other than uuid stops the migration.
--   same-company guard    an item named by a row must belong to the row's company, which a plain FK on items(id) does not
--                         check. stock_movements: a composite FK (company_id, item_id) -> items(company_id, id) on a new
--                         unique index items_company_id_id_key (NOT VALID, validated when clean; a NULL company_id, an
--                         orphan row only a superuser can write, skips it). The four line tables have no company_id of their
--                         own, so a BEFORE INSERT OR UPDATE OF item_id, <header FK column> trigger (SECURITY INVOKER,
--                         line_item_same_company) compares the item's company with the line's header's at the moment a line
--                         is written or its item or header is changed. LIMIT, stated plainly: it does not fire when a
--                         HEADER's own company_id is changed afterwards (the line rows are not touched); RLS stops an
--                         app_user doing that, a superuser or owner could. Rows written before 1005 are not rechecked.
--   stock product guard   a stock row's product must belong to the row's company: composite FKs (company_id, product_id) ->
--                         products(company_id, id) on stock_movements and stock_levels, on a new unique index
--                         products_company_id_id_key (NOT VALID, validated when clean). A foreign-key check reads the
--                         referenced table WITHOUT row level security, so it refuses company B's product for a company-A
--                         row even though B's product is invisible to A's session (a trigger reading products as the caller
--                         could not tell). A NULL company_id (the orphan row only a superuser can write) skips it.
--
-- ORDER. The backfill runs BEFORE row level security is switched on, so it sees every row.
--
-- LOCKS. Each ALTER takes ACCESS EXCLUSIVE (ADD COLUMN) or SHARE ROW EXCLUSIVE (ADD CONSTRAINT / FK) on its table for
--   the catalog change; the new columns are nullable or carry a constant default (no rewrite) and every FK is added NOT
--   VALID, then validated (SHARE UPDATE EXCLUSIVE, readers and writers carry on). lock_timeout 5s turns a blocked lock
--   into a failed (retryable) migration rather than a queue that stalls the app.
--
-- OLD COLOUR. Old code never names the new columns. Its INSERT into stock_movements / stock_levels (the one old writer is
--   POST /api/accounting/stock-adjustments, which this change also fixes to write company_id) names no company_id: the
--   trigger fills it from the product, so the write works under the old release and after a code-only rollback. Its reads
--   are unchanged. The items CHECK refuses only a tracked service, which old code never writes (the column is new).
--
-- Rollback (down SQL; roll the code back first, and only while no row uses what is dropped):
--   ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_company_item_fkey;
--   ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_company_product_fkey;
--   ALTER TABLE public.stock_levels DROP CONSTRAINT IF EXISTS stock_levels_company_product_fkey;
--   DROP INDEX IF EXISTS public.products_company_id_id_key;
--   DROP INDEX IF EXISTS public.items_company_id_id_key;
--   DROP TRIGGER IF EXISTS po_items_item_company ON public.po_items;
--   DROP TRIGGER IF EXISTS supplier_invoice_items_item_company ON public.supplier_invoice_items;
--   DROP TRIGGER IF EXISTS customer_invoice_items_item_company ON public.customer_invoice_items;
--   DROP TRIGGER IF EXISTS customer_quote_lines_item_company ON public.customer_quote_lines;
--   DROP FUNCTION IF EXISTS public.line_item_same_company();
--   DROP TRIGGER IF EXISTS stock_movements_fill_company ON public.stock_movements;
--   DROP TRIGGER IF EXISTS stock_levels_fill_company ON public.stock_levels;
--   DROP FUNCTION IF EXISTS public.stock_row_fill_company();
--   ALTER TABLE public.stock_movements DISABLE ROW LEVEL SECURITY; ALTER TABLE public.stock_levels DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS tenant_isolation ON public.stock_movements; DROP POLICY IF EXISTS tenant_isolation ON public.stock_levels;
--   SELECT public.app_service_sync_policies();
--   ALTER TABLE public.stock_movements DROP COLUMN IF EXISTS item_id, DROP COLUMN IF EXISTS company_id;
--   ALTER TABLE public.stock_levels DROP COLUMN IF EXISTS company_id;
--   ALTER TABLE public.po_items DROP COLUMN IF EXISTS item_id;
--   ALTER TABLE public.supplier_invoice_items DROP COLUMN IF EXISTS item_id;
--   (customer_invoice_items.item_id and customer_quote_lines.item_id: drop only the po_items-style FK constraints named
--   <table>_item_id_fkey; the columns may predate this migration and stay.)
--   ALTER TABLE public.items DROP CONSTRAINT IF EXISTS items_sales_account_id_fkey, DROP CONSTRAINT IF EXISTS items_purchases_account_id_fkey,
--     DROP CONSTRAINT IF EXISTS items_tracked_needs_physical;
--   DROP INDEX IF EXISTS public.item_categories_company_code_key, public.item_categories_company_external_ref_key;
--   ALTER TABLE public.item_categories DROP COLUMN IF EXISTS code, DROP COLUMN IF EXISTS external_system,
--     DROP COLUMN IF EXISTS external_ref, DROP COLUMN IF EXISTS is_active;
--   DROP INDEX IF EXISTS public.items_company_external_ref_key;
--   ALTER TABLE public.items DROP CONSTRAINT IF EXISTS items_external_ref_needs_system, DROP COLUMN IF EXISTS external_system,
--     DROP COLUMN IF EXISTS external_ref, DROP COLUMN IF EXISTS external_document_number, DROP COLUMN IF EXISTS inventory_tracked;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── items ────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS external_system TEXT;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS inventory_tracked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.items DROP CONSTRAINT IF EXISTS items_external_ref_needs_system;
ALTER TABLE public.items ADD CONSTRAINT items_external_ref_needs_system
  CHECK (external_ref IS NULL OR external_system IS NOT NULL) NOT VALID;
ALTER TABLE public.items VALIDATE CONSTRAINT items_external_ref_needs_system;

ALTER TABLE public.items DROP CONSTRAINT IF EXISTS items_tracked_needs_physical;
ALTER TABLE public.items ADD CONSTRAINT items_tracked_needs_physical
  CHECK (item_type = 'physical' OR NOT inventory_tracked) NOT VALID;
ALTER TABLE public.items VALIDATE CONSTRAINT items_tracked_needs_physical;

CREATE UNIQUE INDEX IF NOT EXISTS items_company_external_ref_key
  ON public.items (company_id, external_system, external_ref) WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN public.items.inventory_tracked IS
  '1005: true only for an item whose quantity on hand is kept. A service never is; Sage quantities are not imported by the item tools.';

-- ── item_categories ──────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.item_categories ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE public.item_categories ADD COLUMN IF NOT EXISTS external_system TEXT;
ALTER TABLE public.item_categories ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE public.item_categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.item_categories DROP CONSTRAINT IF EXISTS item_categories_external_ref_needs_system;
ALTER TABLE public.item_categories ADD CONSTRAINT item_categories_external_ref_needs_system
  CHECK (external_ref IS NULL OR external_system IS NOT NULL) NOT VALID;
ALTER TABLE public.item_categories VALIDATE CONSTRAINT item_categories_external_ref_needs_system;

CREATE UNIQUE INDEX IF NOT EXISTS item_categories_company_code_key
  ON public.item_categories (company_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS item_categories_company_external_ref_key
  ON public.item_categories (company_id, external_system, external_ref) WHERE external_ref IS NOT NULL;

-- ── stock_movements / stock_levels: the tenant column ────────────────────────────────────────────────────────────
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE public.stock_levels ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

-- Backfill before RLS is on. A product with no company leaves its rows NULL (they belong to nobody).
UPDATE public.stock_movements sm SET company_id = p.company_id
  FROM public.products p
  WHERE p.id = sm.product_id AND sm.company_id IS NULL AND p.company_id IS NOT NULL;
UPDATE public.stock_levels sl SET company_id = p.company_id
  FROM public.products p
  WHERE p.id = sl.product_id AND sl.company_id IS NULL AND p.company_id IS NOT NULL;

-- A writer that names no company_id gets its product's. SECURITY INVOKER: under a tenant session products is read through
-- that session's RLS, so another company's product yields NULL (then the policy's WITH CHECK refuses the row).
-- It only FILLS: a company_id that disagrees with the product's is refused by the composite FKs below, not here (a trigger
-- reads products as the caller, and RLS hides another company's product from it).
CREATE OR REPLACE FUNCTION public.stock_row_fill_company() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT p.company_id INTO NEW.company_id FROM public.products p WHERE p.id = NEW.product_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_movements_fill_company ON public.stock_movements;
CREATE TRIGGER stock_movements_fill_company BEFORE INSERT OR UPDATE OF product_id, company_id ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.stock_row_fill_company();
DROP TRIGGER IF EXISTS stock_levels_fill_company ON public.stock_levels;
CREATE TRIGGER stock_levels_fill_company BEFORE INSERT OR UPDATE OF product_id, company_id ON public.stock_levels
  FOR EACH ROW EXECUTE FUNCTION public.stock_row_fill_company();

CREATE INDEX IF NOT EXISTS idx_stock_movements_company ON public.stock_movements (company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON public.stock_movements (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_levels_company ON public.stock_levels (company_id);

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.stock_movements;
CREATE POLICY tenant_isolation ON public.stock_movements FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_levels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.stock_levels;
CREATE POLICY tenant_isolation ON public.stock_levels FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

SELECT public.app_service_sync_policies();

-- ── document lines: the catalogue item (columns first, then each FK in its own guarded step) ─────────────────────
ALTER TABLE public.po_items ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE public.supplier_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE public.customer_quote_lines ADD COLUMN IF NOT EXISTS item_id UUID;

-- Every foreign key this migration adds: NOT VALID when none on that column references the target yet, validated when
-- no orphan row exists. items.sales_account_id / purchases_account_id are the ones an account merge must see.
DO $$
DECLARE
  r record;
  v_att smallint;
  v_type regtype;
  v_orphans bigint;
  c record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('items', 'sales_account_id', 'gl_accounts', 'items_sales_account_id_fkey'),
    ('items', 'purchases_account_id', 'gl_accounts', 'items_purchases_account_id_fkey'),
    ('po_items', 'item_id', 'items', 'po_items_item_id_fkey'),
    ('supplier_invoice_items', 'item_id', 'items', 'supplier_invoice_items_item_id_fkey'),
    ('customer_invoice_items', 'item_id', 'items', 'customer_invoice_items_item_id_fkey'),
    ('customer_quote_lines', 'item_id', 'items', 'customer_quote_lines_item_id_fkey'),
    ('stock_movements', 'item_id', 'items', 'stock_movements_item_id_fkey')
  ) AS t(tbl, col, ref, cname)
  LOOP
    SELECT a.attnum, a.atttypid::regtype INTO v_att, v_type FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', r.tbl)::regclass AND a.attname = r.col AND NOT a.attisdropped;
    IF v_att IS NULL THEN
      RAISE EXCEPTION '1005: %.% does not exist', r.tbl, r.col;
    END IF;
    IF v_type <> 'uuid'::regtype THEN
      RAISE EXCEPTION '1005: %.% is % (expected uuid); it needs a hand-written fix before this foreign key', r.tbl, r.col, v_type;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k WHERE k.conrelid = format('public.%I', r.tbl)::regclass AND k.contype = 'f'
        AND k.confrelid = format('public.%I', r.ref)::regclass AND k.conkey = ARRAY[v_att]
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) NOT VALID',
                     r.tbl, r.cname, r.col, r.ref);
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I x WHERE x.id = t.%I)',
                   r.tbl, r.col, r.ref, r.col) INTO v_orphans;
    IF v_orphans = 0 THEN
      FOR c IN SELECT k.conname FROM pg_constraint k WHERE k.conrelid = format('public.%I', r.tbl)::regclass AND k.contype = 'f'
                 AND k.confrelid = format('public.%I', r.ref)::regclass AND k.conkey = ARRAY[v_att] AND NOT k.convalidated
      LOOP
        EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tbl, c.conname);
      END LOOP;
    ELSE
      RAISE NOTICE '1005: %.% has % row(s) naming no %; its foreign key stays NOT VALID', r.tbl, r.col, v_orphans, r.ref;
    END IF;
  END LOOP;
END $$;

-- ── an item named by a row belongs to the row's company ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS items_company_id_id_key ON public.items (company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stock_movements'::regclass AND conname = 'stock_movements_company_item_fkey') THEN
    ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_company_item_fkey
      FOREIGN KEY (company_id, item_id) REFERENCES public.items (company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_movements sm WHERE sm.company_id IS NOT NULL AND sm.item_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM public.items i WHERE i.id = sm.item_id AND i.company_id = sm.company_id)) THEN
    ALTER TABLE public.stock_movements VALIDATE CONSTRAINT stock_movements_company_item_fkey;
  ELSE
    RAISE NOTICE '1005: stock_movements has row(s) naming another company''s item; stock_movements_company_item_fkey stays NOT VALID';
  END IF;
END $$;

-- A stock row's product belongs to the row's company (see the header). products.id is the primary key, so (company_id, id) is
-- unique by construction; the index is what a composite FK needs to reference.
CREATE UNIQUE INDEX IF NOT EXISTS products_company_id_id_key ON public.products (company_id, id);

DO $$
DECLARE
  t text;
  v_orphans bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements', 'stock_levels'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND conname = t || '_company_product_fkey') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (company_id, product_id) REFERENCES public.products (company_id, id) NOT VALID',
                     t, t || '_company_product_fkey');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND conname = t || '_company_product_fkey' AND convalidated) THEN
      EXECUTE format('SELECT count(*) FROM public.%I r WHERE r.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = r.product_id AND p.company_id = r.company_id)', t) INTO v_orphans;
      IF v_orphans = 0 THEN
        EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t, t || '_company_product_fkey');
      ELSE
        RAISE NOTICE '1005: % has % row(s) naming another company''s product; %_company_product_fkey stays NOT VALID', t, v_orphans, t;
      END IF;
    END IF;
  END LOOP;
END $$;

-- The line tables carry no company_id: the item's company is compared with the header's (on INSERT, and on an UPDATE of the item
-- or of the header FK column). SECURITY INVOKER, so the item is
-- read under the caller's row level security (another company's item is invisible to a tenant session: refused).
CREATE OR REPLACE FUNCTION public.line_item_same_company() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_header uuid;
  v_item uuid;
BEGIN
  IF NEW.item_id IS NULL THEN RETURN NEW; END IF;
  -- IF branches, not one CASE: plpgsql plans a whole expression, and NEW has only the fields of ITS table.
  IF TG_TABLE_NAME = 'po_items' THEN
    SELECT company_id INTO v_header FROM public.purchase_orders WHERE id = NEW.purchase_order_id;
  ELSIF TG_TABLE_NAME = 'supplier_invoice_items' THEN
    SELECT company_id INTO v_header FROM public.supplier_invoices WHERE id = NEW.supplier_invoice_id;
  ELSIF TG_TABLE_NAME = 'customer_invoice_items' THEN
    SELECT company_id INTO v_header FROM public.customer_invoices WHERE id = NEW.invoice_id;
  ELSIF TG_TABLE_NAME = 'customer_quote_lines' THEN
    SELECT company_id INTO v_header FROM public.customer_quotes WHERE id = NEW.quote_id;
  END IF;
  SELECT i.company_id INTO v_item FROM public.items i WHERE i.id = NEW.item_id;
  IF v_item IS NULL OR v_header IS NULL OR v_item <> v_header THEN
    RAISE EXCEPTION '%: item_id names an item that is not the document''s company''s', TG_TABLE_NAME USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS po_items_item_company ON public.po_items;
CREATE TRIGGER po_items_item_company BEFORE INSERT OR UPDATE OF item_id, purchase_order_id ON public.po_items
  FOR EACH ROW WHEN (NEW.item_id IS NOT NULL) EXECUTE FUNCTION public.line_item_same_company();
DROP TRIGGER IF EXISTS supplier_invoice_items_item_company ON public.supplier_invoice_items;
CREATE TRIGGER supplier_invoice_items_item_company BEFORE INSERT OR UPDATE OF item_id, supplier_invoice_id ON public.supplier_invoice_items
  FOR EACH ROW WHEN (NEW.item_id IS NOT NULL) EXECUTE FUNCTION public.line_item_same_company();
DROP TRIGGER IF EXISTS customer_invoice_items_item_company ON public.customer_invoice_items;
CREATE TRIGGER customer_invoice_items_item_company BEFORE INSERT OR UPDATE OF item_id, invoice_id ON public.customer_invoice_items
  FOR EACH ROW WHEN (NEW.item_id IS NOT NULL) EXECUTE FUNCTION public.line_item_same_company();
DROP TRIGGER IF EXISTS customer_quote_lines_item_company ON public.customer_quote_lines;
CREATE TRIGGER customer_quote_lines_item_company BEFORE INSERT OR UPDATE OF item_id, quote_id ON public.customer_quote_lines
  FOR EACH ROW WHEN (NEW.item_id IS NOT NULL) EXECUTE FUNCTION public.line_item_same_company();
