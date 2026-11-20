-- 1021: Goods received notes: cancel, external references, and their documents (MCP create_goods_received /
-- cancel_goods_received / list_goods_received / get_goods_received; design docs/design/mcp-goods-received.md).
--
-- WHAT.
--   goods_received_notes.status gains 'cancelled'
--     cancel_goods_received sets it, takes the note's quantities back off its PO lines (po_items.quantity_received) and
--     recomputes the PO status. A cancelled note is kept as a record: it is never deleted.
--   goods_received_notes.cancelled_at / cancelled_by / cancel_reason
--     Who cancelled it, when and why. goods_received_notes_cancel_consistent: all three are set (a non-blank reason of
--     at most 500 characters) if and only if the status is 'cancelled'.
--   goods_received_notes.external_system / external_ref
--     The source system's id for the note (FibreFlow site deliveries send external_system 'fibreflow'). Both or neither;
--     the system is stored lower case. goods_received_notes_external_ref_uq: unique per company among notes that are
--     not cancelled, so a delivery is not received twice, and its reference is free again once its note is cancelled.
--     The tool refuses a repeat first (duplicate_external_ref, naming the note that holds it); the index is the last line.
--   goods_received_notes_guard (BEFORE UPDATE, SECURITY INVOKER): a cancelled note never changes again, so it never
--     moves out of 'cancelled'.
--   grn_items_cancelled_guard (BEFORE INSERT OR UPDATE, SECURITY INVOKER): no item is added to, moved onto or edited on a
--     cancelled note. It reads the parent under the caller's row security, which is where every app path writes from (a
--     note of the request's company). grn_items has no company_id and no row security of its own (unchanged here).
--   procurement_documents.tenant_isolation_via_parent gains a goods_received branch (713's policy, every other branch
--     verbatim): a document filed on a goods received note (entity_type 'goods_received', the entity-store kind
--     attach_entity_document and create_upload_urls / finalize_uploads now accept) is this company's when the note is.
--   mcp_upload_intents.target_kind gains 'goods_received'. 999q's guard needs no change: a non-bank target is checked
--     against procurement_documents by entity_type = target_kind.
--
-- Nothing here posts: a goods received note records quantities only (no GRNI accrual, no stock journal).
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930). Grants are unchanged: app_user already holds
-- SELECT / INSERT / UPDATE / DELETE on both tables (348's default privileges), which cover the new columns.
--
-- LOCKS. The ALTERs take ACCESS EXCLUSIVE on goods_received_notes (a CHECK scan, small table), SHARE ROW EXCLUSIVE for the
--   triggers on grn_items, and procurement_documents / mcp_upload_intents for the policy and CHECK swap; lock_timeout bounds
--   the wait.
--
-- OLD COLOUR. The old code never writes 'cancelled', the new columns or 'goods_received' documents; it reads the notes by
--   name (`SELECT g.*` passes the new columns through). Its create inserts a note with the new columns NULL, which every
--   CHECK and the unique index accept. Nothing it does is refused.
--
-- Rollback (down SQL; roll the code back first, and only while no row uses what is dropped):
--   DROP TRIGGER IF EXISTS trg_goods_received_notes_guard ON public.goods_received_notes;
--   DROP TRIGGER IF EXISTS trg_grn_items_cancelled_guard ON public.grn_items;
--   DROP FUNCTION IF EXISTS public.goods_received_notes_guard();
--   DROP FUNCTION IF EXISTS public.grn_items_cancelled_guard();
--   DROP INDEX IF EXISTS public.goods_received_notes_external_ref_uq;
--   ALTER TABLE public.goods_received_notes DROP CONSTRAINT IF EXISTS goods_received_notes_cancel_consistent,
--     DROP CONSTRAINT IF EXISTS goods_received_notes_external_ref_pair, DROP CONSTRAINT IF EXISTS goods_received_notes_status_check;
--   ALTER TABLE public.goods_received_notes ADD CONSTRAINT goods_received_notes_status_check
--     CHECK (status IN ('draft', 'received', 'inspected', 'accepted', 'rejected'));
--   ALTER TABLE public.goods_received_notes DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancelled_by,
--     DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS external_system, DROP COLUMN IF EXISTS external_ref;
--   ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
--   ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
--     'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
--     'purchase_order'));
--   -- and recreate 713's procurement_documents policy (without the goods_received branch), then
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── The note: cancel and external reference columns ────────────────────────────────────────────────────────────

ALTER TABLE public.goods_received_notes ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.goods_received_notes ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE public.goods_received_notes ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE public.goods_received_notes ADD COLUMN IF NOT EXISTS external_system TEXT;
ALTER TABLE public.goods_received_notes ADD COLUMN IF NOT EXISTS external_ref TEXT;

ALTER TABLE public.goods_received_notes DROP CONSTRAINT IF EXISTS goods_received_notes_status_check;
ALTER TABLE public.goods_received_notes ADD CONSTRAINT goods_received_notes_status_check
  CHECK (status IN ('draft', 'received', 'inspected', 'accepted', 'rejected', 'cancelled'));

ALTER TABLE public.goods_received_notes DROP CONSTRAINT IF EXISTS goods_received_notes_cancel_consistent;
ALTER TABLE public.goods_received_notes ADD CONSTRAINT goods_received_notes_cancel_consistent CHECK (
  CASE WHEN status = 'cancelled'
    THEN cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL
         AND btrim(cancel_reason) <> '' AND char_length(cancel_reason) <= 500
    ELSE cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL
  END);

ALTER TABLE public.goods_received_notes DROP CONSTRAINT IF EXISTS goods_received_notes_external_ref_pair;
ALTER TABLE public.goods_received_notes ADD CONSTRAINT goods_received_notes_external_ref_pair CHECK (
  (external_system IS NULL) = (external_ref IS NULL)
  AND (external_system IS NULL OR (external_system = lower(external_system) AND char_length(external_system) BETWEEN 1 AND 32))
  AND (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 128));

CREATE UNIQUE INDEX IF NOT EXISTS goods_received_notes_external_ref_uq
  ON public.goods_received_notes (company_id, external_system, external_ref)
  WHERE external_ref IS NOT NULL AND status <> 'cancelled';

-- ── A cancelled note never changes again ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.goods_received_notes_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled goods received note does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_goods_received_notes_guard ON public.goods_received_notes;
CREATE TRIGGER trg_goods_received_notes_guard BEFORE UPDATE ON public.goods_received_notes
  FOR EACH ROW EXECUTE FUNCTION public.goods_received_notes_guard();
ALTER TABLE public.goods_received_notes ENABLE ALWAYS TRIGGER trg_goods_received_notes_guard;

CREATE OR REPLACE FUNCTION public.grn_items_cancelled_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM goods_received_notes g WHERE g.id = NEW.grn_id AND g.status = 'cancelled')
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM goods_received_notes g WHERE g.id = OLD.grn_id AND g.status = 'cancelled')) THEN
    RAISE EXCEPTION 'the items of a cancelled goods received note do not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_grn_items_cancelled_guard ON public.grn_items;
CREATE TRIGGER trg_grn_items_cancelled_guard BEFORE INSERT OR UPDATE ON public.grn_items
  FOR EACH ROW EXECUTE FUNCTION public.grn_items_cancelled_guard();
ALTER TABLE public.grn_items ENABLE ALWAYS TRIGGER trg_grn_items_cancelled_guard;

REVOKE ALL ON FUNCTION public.goods_received_notes_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grn_items_cancelled_guard() FROM PUBLIC;

-- ── Upload targets: a goods received note ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
  'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
  'purchase_order', 'goods_received'));

-- ── procurement_documents: 713's policy, verbatim, plus the goods_received branch ─────────────────────────────

DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.procurement_documents;
CREATE POLICY tenant_isolation_via_parent ON public.procurement_documents
  FOR ALL TO app_user
  USING (
    (entity_type = 'supplier_invoice' AND EXISTS (
      SELECT 1 FROM public.supplier_invoices p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'customer_invoice' AND EXISTS (
      SELECT 1 FROM public.customer_invoices p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'supplier_payment' AND EXISTS (
      SELECT 1 FROM public.supplier_payments p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'customer_payment' AND EXISTS (
      SELECT 1 FROM public.customer_payments p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'credit_note' AND EXISTS (
      SELECT 1 FROM public.credit_notes p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'purchase_order' AND EXISTS (
      SELECT 1 FROM public.purchase_orders p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'goods_received' AND EXISTS (
      SELECT 1 FROM public.goods_received_notes p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
  )
  WITH CHECK (
    (entity_type = 'supplier_invoice' AND EXISTS (
      SELECT 1 FROM public.supplier_invoices p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'customer_invoice' AND EXISTS (
      SELECT 1 FROM public.customer_invoices p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'supplier_payment' AND EXISTS (
      SELECT 1 FROM public.supplier_payments p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'customer_payment' AND EXISTS (
      SELECT 1 FROM public.customer_payments p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'credit_note' AND EXISTS (
      SELECT 1 FROM public.credit_notes p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'purchase_order' AND EXISTS (
      SELECT 1 FROM public.purchase_orders p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'goods_received' AND EXISTS (
      SELECT 1 FROM public.goods_received_notes p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
  );

-- The service pool reaches procurement_documents through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
