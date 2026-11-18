-- 1002: Items canonical model, Phase A of the Items / Inventory / PO MCP programme (docs/design/items-inventory-po-mcp.md).
--
-- WHAT.
--   items                 external_system / external_ref / external_document_number (the source system's identity of the
--                         catalogue entry; a partial UNIQUE index on (company_id, external_system, external_ref) where a
--                         reference is present makes bulk_upsert_items idempotent and race-safe) and inventory_tracked
--                         (default false: a Sage service code with a work-unit counter is a service, never stock).
--                         cost_price (= purchase price), selling_price_excl (= sales price), vat_on_sales /
--                         vat_on_purchases, sales_account_id / purchases_account_id, item_type and is_active are reused.
--   item_categories       code (nullable; unique per company when present), external_system / external_ref (unique per
--                         company when present), is_active.
--   stock_movements       company_id (FK companies) and item_id (FK items). company_id is backfilled from
--   stock_levels          products.company_id; stock_levels gets company_id only. CHECK (company_id IS NOT NULL) is added
--                         NOT VALID, so every NEW row must carry one, and validated only when no orphan remains (a
--                         movement of a product that has no company stays NULL and keeps the check unvalidated).
--                         Both tables then get row level security with the policies of `items`: tenant_isolation for
--                         app_user, plus the app_service mirrors (app_service_sync_policies).
--   warehouses            location_type (warehouse | site | vehicle), default warehouse. Phase C uses it.
--   po_items / supplier_invoice_items / customer_invoice_items / customer_quote_lines
--                         item_id (FK items), nullable: a line may name the catalogue item it is for.
--
-- ORDER. The backfill runs BEFORE row level security is switched on, so it sees every row.
--
-- LOCKS. Each ALTER takes ACCESS EXCLUSIVE (ADD COLUMN) or SHARE ROW EXCLUSIVE (ADD CONSTRAINT / FK) on its table for
--   the catalog change; the new columns are nullable or carry a constant default (no rewrite) and the FKs reference
--   all-NULL columns, so the validation scans are short. lock_timeout 5s turns a blocked lock into a failed (retryable)
--   migration rather than a queue that stalls the app.
--
-- OLD COLOUR. Old code never names the new columns. Its INSERT into stock_movements / stock_levels (none of the other
--   tables change shape for it) writes no company_id, which the NOT VALID check refuses: the one old writer
--   (POST /api/accounting/stock-adjustments) was already failing on dev and is fixed in this change to write company_id.
--
-- Rollback (down SQL; roll the code back first, and only while no row uses what is dropped):
--   ALTER TABLE public.stock_movements DISABLE ROW LEVEL SECURITY; ALTER TABLE public.stock_levels DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS tenant_isolation ON public.stock_movements; DROP POLICY IF EXISTS tenant_isolation ON public.stock_levels;
--   SELECT public.app_service_sync_policies();
--   ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_company_id_not_null,
--     DROP COLUMN IF EXISTS item_id, DROP COLUMN IF EXISTS company_id;
--   ALTER TABLE public.stock_levels DROP CONSTRAINT IF EXISTS stock_levels_company_id_not_null, DROP COLUMN IF EXISTS company_id;
--   ALTER TABLE public.po_items DROP COLUMN IF EXISTS item_id;
--   ALTER TABLE public.supplier_invoice_items DROP COLUMN IF EXISTS item_id;
--   ALTER TABLE public.customer_invoice_items DROP COLUMN IF EXISTS item_id;
--   ALTER TABLE public.customer_quote_lines DROP COLUMN IF EXISTS item_id;
--   ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_location_type_check, DROP COLUMN IF EXISTS location_type;
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

CREATE UNIQUE INDEX IF NOT EXISTS items_company_external_ref_key
  ON public.items (company_id, external_system, external_ref) WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN public.items.inventory_tracked IS
  '1002: true only for an item whose quantity on hand is kept. A service never is; Sage quantities are not imported by the item tools.';

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
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.items(id);
ALTER TABLE public.stock_levels ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

-- Backfill before RLS is on. A product with no company leaves its rows NULL (they belong to nobody).
UPDATE public.stock_movements sm SET company_id = p.company_id
  FROM public.products p
  WHERE p.id = sm.product_id AND sm.company_id IS NULL AND p.company_id IS NOT NULL;
UPDATE public.stock_levels sl SET company_id = p.company_id
  FROM public.products p
  WHERE p.id = sl.product_id AND sl.company_id IS NULL AND p.company_id IS NOT NULL;

ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_company_id_not_null;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_company_id_not_null CHECK (company_id IS NOT NULL) NOT VALID;
ALTER TABLE public.stock_levels DROP CONSTRAINT IF EXISTS stock_levels_company_id_not_null;
ALTER TABLE public.stock_levels ADD CONSTRAINT stock_levels_company_id_not_null CHECK (company_id IS NOT NULL) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE company_id IS NULL) THEN
    ALTER TABLE public.stock_movements VALIDATE CONSTRAINT stock_movements_company_id_not_null;
  ELSE
    RAISE NOTICE '1002: stock_movements has rows with no company; stock_movements_company_id_not_null stays NOT VALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_levels WHERE company_id IS NULL) THEN
    ALTER TABLE public.stock_levels VALIDATE CONSTRAINT stock_levels_company_id_not_null;
  ELSE
    RAISE NOTICE '1002: stock_levels has rows with no company; stock_levels_company_id_not_null stays NOT VALID';
  END IF;
END $$;

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

-- ── warehouses: location type (Phase C) ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'warehouse';
ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_location_type_check;
ALTER TABLE public.warehouses ADD CONSTRAINT warehouses_location_type_check
  CHECK (location_type IN ('warehouse', 'site', 'vehicle')) NOT VALID;
ALTER TABLE public.warehouses VALIDATE CONSTRAINT warehouses_location_type_check;

-- ── document lines: the catalogue item ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.po_items ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.items(id);
ALTER TABLE public.supplier_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.items(id);
ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.items(id);
ALTER TABLE public.customer_quote_lines ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.items(id);
