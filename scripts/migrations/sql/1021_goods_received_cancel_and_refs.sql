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
--     note of the request's company).
--   grn_items_same_transaction_guard (BEFORE INSERT, SECURITY INVOKER): an item goes in only in the transaction that created its note
--     (the note's created_at is now(), the transaction's start). A note's items are written with it by createGoodsReceived, which
--     also adds them to po_items.quantity_received; an item added to a note that already exists would leave that total disagreeing
--     with the notes, and a later cancel could not put it right. app_user cannot UPDATE a note, so created_at is fixed.
--   goods_received_notes_po_guard (BEFORE INSERT, or UPDATE OF purchase_order_id / company_id; SECURITY INVOKER): a note names a
--     purchase order of its own company. grn_items_po_line_guard (BEFORE INSERT, or UPDATE OF grn_id / po_item_id): an item names a
--     line of its note's purchase order. Neither was a rule of the tables (no company on the PO foreign key, no PO on the item's),
--     and the cancel takes quantities off the PO's lines on the strength of them.
--   grn_items gets row security (FORCE, like its note): grn_items has no company_id, so a row is visible when its note is
--     (the note's own policy), and is written only onto a note of the session company (WITH CHECK).
--   goods_received_note_cancel(note, reason) (SECURITY DEFINER): the cancel's state change, the quantities back off the PO
--     lines and the PO status recompute, in one call, re-deciding the refusals under the note lock. app_user loses UPDATE and
--     DELETE on goods_received_notes and grn_items: nothing in the app changes either table but the cancel, and only a
--     privilege holds (a trigger keyed on the caller's role can be steered), so a note is never cancelled without its
--     quantities coming back, and never deleted.
--   idx_supplier_invoices_grn: the cancel's check for a live bill that names the note scans bills by (company_id, grn_id), under the
--     PO and note locks; supplier_invoices.grn_id had no index.
--   goods_received_note_hold(note) (SECURITY DEFINER): FOR SHARE on one note of the session company, returning its status. A
--     bill that names a note takes it (create, restore of a soft-deleted bill) and refuses a cancelled one; a row lock needs
--     UPDATE privilege, which app_user no longer has. supplier_invoices.grn_id has no foreign key (201 created it bare; 246b's
--     ADD COLUMN ... REFERENCES was skipped), so no KEY SHARE is taken for it: this hold is the lock.
--   procurement_documents.tenant_isolation_via_parent gains a goods_received branch (713's policy, every other branch
--     verbatim): a document filed on a goods received note (entity_type 'goods_received', the entity-store kind
--     attach_entity_document and create_upload_urls / finalize_uploads now accept) is this company's when the note is. The
--     legacy entity_type 'goods_receipt_note' gets the same parent check against goods_received_notes (497 left it invisible to
--     app_user): a bill's listing reads a note's documents of both types, and the documents DELETE deactivates either.
--   mcp_upload_intents.target_kind gains 'goods_received'. 999q's guard needs no change: a non-bank target is checked
--     against procurement_documents by entity_type = target_kind.
--
-- Nothing here posts: a goods received note records quantities only (no GRNI accrual, no stock journal).
--
-- The two guards are SECURITY INVOKER. goods_received_note_cancel and goods_received_note_hold are SECURITY DEFINER, owned by
-- migration_admin (BYPASSRLS), pinned search_path with pg_temp last, a member-of-the-session-company check inside, EXECUTE for
-- app_user and app_service only, and registered in app_definer_reviews (930). Grants: app_user keeps SELECT and INSERT on both
-- tables (348's default privileges, which cover the new columns) and loses UPDATE and DELETE.
--
-- LOCKS. The ALTERs take ACCESS EXCLUSIVE on goods_received_notes (a CHECK scan, small table) and on grn_items (row
--   security), SHARE ROW EXCLUSIVE for the triggers on grn_items, and procurement_documents / mcp_upload_intents for the policy
--   and CHECK swap; lock_timeout bounds the wait. The index on supplier_invoices takes SHARE (it blocks writes to bills while it
--   builds, a scan of the table; nothing else does).
--
-- OLD COLOUR. The old code never writes 'cancelled', the new columns or 'goods_received' documents; it reads the notes by
--   name (`SELECT g.*` passes the new columns through). Its create inserts a note with the new columns NULL, which every
--   CHECK and the unique index accept, and its items onto that note of the request's company, which grn_items' policy
--   accepts. It never UPDATEs or DELETEs either table. Nothing it does is refused.
--
-- Rollback (down SQL; roll the code back first, and only while no row uses what is dropped):
--   DROP INDEX IF EXISTS public.idx_supplier_invoices_grn;
--   DROP TRIGGER IF EXISTS trg_goods_received_notes_po_guard ON public.goods_received_notes;
--   DROP TRIGGER IF EXISTS trg_grn_items_po_line_guard ON public.grn_items;
--   DROP FUNCTION IF EXISTS public.goods_received_notes_po_guard(), public.grn_items_po_line_guard();
--   DROP TRIGGER IF EXISTS trg_grn_items_same_transaction_guard ON public.grn_items;
--   DROP FUNCTION IF EXISTS public.grn_items_same_transaction_guard();
--   DROP FUNCTION IF EXISTS public.goods_received_note_cancel(uuid, text), public.goods_received_note_hold(uuid);
--   DELETE FROM public.app_definer_reviews WHERE signature IN ('goods_received_note_cancel(uuid,text)', 'goods_received_note_hold(uuid)');
--   GRANT UPDATE, DELETE ON public.goods_received_notes, public.grn_items TO app_user;
--   DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.grn_items;
--   ALTER TABLE public.grn_items NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.grn_items DISABLE ROW LEVEL SECURITY;
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

-- A note names a purchase order of its own company, and an item a line of its note's PO. Both read the parents under the caller's row
-- security, as the other guards do: a row the caller cannot see is not one it may name (a foreign key does not look at the company).
CREATE OR REPLACE FUNCTION public.goods_received_notes_po_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = NEW.purchase_order_id AND po.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'a goods received note names a purchase order of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_goods_received_notes_po_guard ON public.goods_received_notes;
CREATE TRIGGER trg_goods_received_notes_po_guard BEFORE INSERT OR UPDATE OF purchase_order_id, company_id ON public.goods_received_notes
  FOR EACH ROW EXECUTE FUNCTION public.goods_received_notes_po_guard();
ALTER TABLE public.goods_received_notes ENABLE ALWAYS TRIGGER trg_goods_received_notes_po_guard;

CREATE OR REPLACE FUNCTION public.grn_items_po_line_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM goods_received_notes g WHERE g.id = NEW.grn_id)
     AND NOT EXISTS (SELECT 1 FROM goods_received_notes g JOIN po_items pi ON pi.purchase_order_id = g.purchase_order_id
                      WHERE g.id = NEW.grn_id AND pi.id = NEW.po_item_id) THEN
    RAISE EXCEPTION 'an item of a goods received note names a line of its purchase order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_grn_items_po_line_guard ON public.grn_items;
CREATE TRIGGER trg_grn_items_po_line_guard BEFORE INSERT OR UPDATE OF grn_id, po_item_id ON public.grn_items
  FOR EACH ROW EXECUTE FUNCTION public.grn_items_po_line_guard();
ALTER TABLE public.grn_items ENABLE ALWAYS TRIGGER trg_grn_items_po_line_guard;

-- An item goes in only in the transaction that created its note: createGoodsReceived writes the note, its items and the PO lines'
-- quantity_received together, so an item added to an existing note would leave quantity_received disagreeing with the notes. The note
-- is read under the caller's row security (the cancelled guard's way). A note that is not visible, or does not exist, is left to the
-- foreign key and the policy's WITH CHECK, which refuse it; only a visible note created earlier is refused here. now() is the start
-- of the transaction, as is the default of created_at; savepoints do not change it (xmin would, a subtransaction has its own id).
CREATE OR REPLACE FUNCTION public.grn_items_same_transaction_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM goods_received_notes g WHERE g.id = NEW.grn_id AND g.created_at IS DISTINCT FROM now()) THEN
    RAISE EXCEPTION 'an item goes onto a goods received note only in the transaction that created its note' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_grn_items_same_transaction_guard ON public.grn_items;
CREATE TRIGGER trg_grn_items_same_transaction_guard BEFORE INSERT ON public.grn_items
  FOR EACH ROW EXECUTE FUNCTION public.grn_items_same_transaction_guard();
ALTER TABLE public.grn_items ENABLE ALWAYS TRIGGER trg_grn_items_same_transaction_guard;

REVOKE ALL ON FUNCTION public.goods_received_notes_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grn_items_cancelled_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grn_items_same_transaction_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.goods_received_notes_po_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grn_items_po_line_guard() FROM PUBLIC;

-- The cancel's live-bill check (below), under the PO and note locks: bills by (company_id, grn_id).
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_grn ON public.supplier_invoices (company_id, grn_id) WHERE grn_id IS NOT NULL;

-- ── grn_items: row security through its note ─────────────────────────────────────────────────────────────────────
-- grn_items has no company_id: a row is this company's when its note is. USING reads the note under the note's own row security
-- (the caller's companies, as the note's policy reads); WITH CHECK requires the note to be the session company's, so an item is
-- never written onto another company's note. FORCE, like goods_received_notes.

ALTER TABLE public.grn_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grn_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.grn_items;
CREATE POLICY tenant_isolation_via_parent ON public.grn_items FOR ALL TO app_user
  USING (EXISTS (SELECT 1 FROM public.goods_received_notes g WHERE g.id = grn_items.grn_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.goods_received_notes g
                       WHERE g.id = grn_items.grn_id AND g.company_id = app.current_company_id()));

-- ── The cancel, and the hold a bill takes on its note: SECURITY DEFINER (930) ─────────────────────────────────────

-- goods_received_note_cancel(note, reason): the one way a note is cancelled. app_user may no longer UPDATE or DELETE either table
-- (below), so the state change, the quantities back off the PO lines and the PO status recompute happen together or not at all.
-- The caller: a member (company_users, auth.uid()) of the session company (app.current_company_id()), the same pair row security
-- reads; any other caller, or another company's note, gets 'not_found'. Locks, the create's order: number lock 620 -> the PO row
-- FOR UPDATE -> its po_items FOR UPDATE -> the note FOR UPDATE (the app's cancel holds them already; taking them again is a no-op).
-- The refusals are re-decided under the note lock and answered, not raised, so nothing is written: 'already_cancelled',
-- 'po_not_receivable' (the PO is not approved / partially_received / received / closed), 'grn_on_bill' (a bill of the company that is
-- not deleted and not cancelled carries the note in supplier_invoices.grn_id; a bill naming the note holds goods_received_note_hold's
-- FOR SHARE until it commits, so this lock waits for it and the check after the lock sees it), 'receipts_disagree' (after this
-- note's quantity comes off, a PO line would hold less than the other live notes' items still account for: the totals were not written
-- with the notes; nothing is kept).
-- 'cancelled' with po_status (the PO's status now) and receipt_status (what the receipts now give: received / partially_received /
-- approved) otherwise.
-- A CLOSED PO (closed by hand or by a bill link) stays closed: its status does not come from its receipts, a closed PO is a decision.
-- The quantities come back as usual, and what the closed PO would be (receipt_status) replaces the records of the status it was closed
-- from, so a later reopen lands on what the receipts say: purchase_orders.closed_from_status (1007; only a PO closed by hand holds
-- one) and purchase_order_bill_links.closed_po_from_status (1006; a closing record is moved or cleared, never rewritten, so cleared
-- and set again). A CANCELLED PO is refused: a cancelled PO carries only cancelled notes (cancel_purchase_order and set_purchase_order_status
-- refuse a PO with a live note), so a live note there was put by hand.
-- Drop first: 1021's first version returned two columns.
DROP FUNCTION IF EXISTS public.goods_received_note_cancel(uuid, text);
CREATE FUNCTION public.goods_received_note_cancel(p_grn uuid, p_reason text)
RETURNS TABLE (outcome text, po_status text, receipt_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company uuid := app.current_company_id();
  v_user text := auth.uid();
  v_po uuid;
  v_po_status text;
  v_status text;
  v_receipt text;
  v_moved uuid[];
BEGIN
  IF v_company IS NULL OR v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_users cu WHERE cu.company_id = v_company AND cu.user_id = v_user
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT g.purchase_order_id INTO v_po FROM public.goods_received_notes g WHERE g.id = p_grn AND g.company_id = v_company;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text; RETURN; END IF;

  PERFORM public.take_number_lock(v_company::text, 620);
  SELECT po.status INTO v_po_status FROM public.purchase_orders po WHERE po.id = v_po AND po.company_id = v_company FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text; RETURN; END IF;
  PERFORM 1 FROM public.po_items pi WHERE pi.purchase_order_id = v_po ORDER BY pi.id FOR UPDATE;
  SELECT g.status INTO v_status FROM public.goods_received_notes g
   WHERE g.id = p_grn AND g.company_id = v_company AND g.purchase_order_id = v_po FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text; RETURN; END IF;

  IF v_status = 'cancelled' THEN RETURN QUERY SELECT 'already_cancelled'::text, v_po_status, NULL::text; RETURN; END IF;
  IF v_po_status NOT IN ('approved', 'partially_received', 'received', 'closed') THEN
    RETURN QUERY SELECT 'po_not_receivable'::text, v_po_status, NULL::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_invoices si
              WHERE si.company_id = v_company AND si.grn_id = p_grn AND si.deleted_at IS NULL AND si.status IS DISTINCT FROM 'cancelled') THEN
    RETURN QUERY SELECT 'grn_on_bill'::text, v_po_status, NULL::text; RETURN;
  END IF;
  -- The cancel takes this note's quantity off each line it names. A line must keep what the OTHER live notes of the PO still account for
  -- (and so not fall below zero): where it would not, the line's total was not written with the notes (an item added with a note but
  -- without the line's quantity, or the total edited), and taking the quantity off would let more be received than was ordered.
  -- Refused before anything is written.
  IF EXISTS (
    SELECT 1 FROM public.po_items pi
      JOIN (SELECT gi.po_item_id, sum(gi.quantity_received) AS qty FROM public.grn_items gi WHERE gi.grn_id = p_grn GROUP BY gi.po_item_id) r
        ON r.po_item_id = pi.id
     WHERE pi.purchase_order_id = v_po AND r.qty > 0
       AND COALESCE(pi.quantity_received, 0) - r.qty < COALESCE((
         SELECT sum(g2i.quantity_received) FROM public.grn_items g2i JOIN public.goods_received_notes g2 ON g2.id = g2i.grn_id
          WHERE g2i.po_item_id = pi.id AND g2.id <> p_grn AND g2.purchase_order_id = v_po AND g2.company_id = v_company
            AND g2.status IS DISTINCT FROM 'cancelled'), 0)
  ) THEN
    RETURN QUERY SELECT 'receipts_disagree'::text, v_po_status, NULL::text; RETURN;
  END IF;

  UPDATE public.goods_received_notes SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_user, cancel_reason = btrim(p_reason)
   WHERE id = p_grn AND company_id = v_company;
  UPDATE public.po_items pi SET quantity_received = COALESCE(pi.quantity_received, 0) - r.qty
    FROM (SELECT gi.po_item_id, sum(gi.quantity_received) AS qty FROM public.grn_items gi WHERE gi.grn_id = p_grn GROUP BY gi.po_item_id) r
   WHERE pi.id = r.po_item_id AND pi.purchase_order_id = v_po AND r.qty > 0;
  -- goodsReceivedService.recomputePoReceiptStatus, the same CASE.
  SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM public.po_items pi WHERE pi.purchase_order_id = v_po AND COALESCE(pi.quantity_received, 0) < pi.quantity) THEN 'received'
      WHEN EXISTS (SELECT 1 FROM public.po_items pi WHERE pi.purchase_order_id = v_po AND pi.quantity_received > 0) THEN 'partially_received'
      ELSE 'approved' END INTO v_receipt;
  IF v_po_status = 'closed' THEN
    UPDATE public.purchase_orders po SET closed_from_status = CASE WHEN po.closed_from_status IS NULL THEN NULL ELSE v_receipt END, updated_at = now()
     WHERE po.id = v_po AND po.company_id = v_company;
    WITH moved AS (
      UPDATE public.purchase_order_bill_links l SET closed_po_from_status = NULL
       WHERE l.company_id = v_company AND l.purchase_order_id = v_po AND l.closed_po_from_status IS NOT NULL AND l.closed_po_from_status <> v_receipt
      RETURNING l.id
    ) SELECT array_agg(m.id) INTO v_moved FROM moved m;
    IF v_moved IS NOT NULL THEN
      UPDATE public.purchase_order_bill_links l SET closed_po_from_status = v_receipt WHERE l.id = ANY (v_moved);
    END IF;
  ELSE
    UPDATE public.purchase_orders po SET status = v_receipt, updated_at = now() WHERE po.id = v_po AND po.company_id = v_company;
    v_po_status := v_receipt;
  END IF;
  RETURN QUERY SELECT 'cancelled'::text, v_po_status, v_receipt;
END;
$$;
ALTER FUNCTION public.goods_received_note_cancel(uuid, text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.goods_received_note_cancel(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.goods_received_note_cancel(uuid, text) TO app_user, app_service;

-- goods_received_note_hold(note): the note's status under a FOR SHARE row lock held to the end of the caller's transaction, or NULL
-- when it is not a note of the session company or the caller is not a member of it. A bill that names a note (its create, the restore
-- of a soft-deleted bill) takes it and refuses a cancelled note: the lock conflicts with the cancel's FOR UPDATE, so either the bill
-- waits for the cancel and then reads 'cancelled', or the cancel waits for the bill and then finds it. A definer because a row lock
-- needs UPDATE privilege, which app_user no longer has on goods_received_notes. Reads one row; writes nothing.
CREATE OR REPLACE FUNCTION public.goods_received_note_hold(p_grn uuid)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT g.status FROM public.goods_received_notes g
   WHERE g.id = p_grn AND g.company_id = app.current_company_id()
     AND EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.company_id = g.company_id AND cu.user_id = auth.uid())
   FOR SHARE OF g
$$;
ALTER FUNCTION public.goods_received_note_hold(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.goods_received_note_hold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.goods_received_note_hold(uuid) TO app_user, app_service;

-- The definers' owner reads and writes these through its own grants, not default privileges. (company_users: 930 already
-- requires migration_admin to read it, and only the pinned migrations grant on it.)
GRANT SELECT, UPDATE ON public.goods_received_notes, public.po_items, public.purchase_orders TO migration_admin;
GRANT SELECT ON public.grn_items, public.supplier_invoices TO migration_admin;
-- A closed PO's closing record on its links follows the receipts (1006 granted migration_admin SELECT on the links).
GRANT SELECT ON public.purchase_order_bill_links TO migration_admin;
GRANT UPDATE (closed_po_from_status) ON public.purchase_order_bill_links TO migration_admin;

-- ── Only the cancel changes a note: app_user loses UPDATE and DELETE on both tables ───────────────────────────────
-- No app path UPDATEs or DELETEs either table except the cancel, which now runs in goods_received_note_cancel. A privilege holds
-- where a trigger keyed on the caller's role could be steered; the 1021 triggers stay as the rule for every other role.
REVOKE UPDATE, DELETE ON public.goods_received_notes, public.grn_items FROM app_user;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('app_user'), ('app_service')) v(role)
           CROSS JOIN (VALUES ('public.goods_received_notes'), ('public.grn_items')) t(rel)
           CROSS JOIN (VALUES ('UPDATE'), ('DELETE')) p(priv) LOOP
    IF pg_catalog.has_table_privilege(r.role, r.rel, r.priv) THEN
      RAISE EXCEPTION '1021: % can still % %', r.role, r.priv, r.rel;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('public', 'public.goods_received_note_cancel(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.goods_received_note_hold(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1021: PUBLIC can execute a goods received note definer function';
  END IF;
END $$;

-- The definer registry (930).
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('goods_received_note_cancel(uuid,text)', 'public.goods_received_note_cancel(uuid, text)',
     'goods_received_notes (status cancelled, cancelled_at / cancelled_by = auth.uid() / cancel_reason of one note of the session company), po_items.quantity_received of that note''s PO (less the note''s items), purchase_orders.status / updated_at of that PO (recomputed; a closed PO keeps its status and has closed_from_status recomputed), purchase_order_bill_links.closed_po_from_status of that PO''s links (a closed PO''s closing record, recomputed); only for a member of the session company, and only when the note is not cancelled, its PO is approved / partially_received / received / closed, no live bill carries it and its PO lines keep at least what the PO''s other live notes account for; reads company_users, grn_items, supplier_invoices'),
    ('goods_received_note_hold(uuid)', 'public.goods_received_note_hold(uuid)',
     'nothing (a FOR SHARE row lock on one goods_received_notes row of the session company, for a member of it; returns its status)')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- ── Upload targets: a goods received note ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
  'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
  'purchase_order', 'goods_received'));

-- ── procurement_documents: 713's policy, verbatim, plus the goods_received branch ─────────────────────────────
-- The branch admits the legacy entity_type 'goods_receipt_note' too, through the same parent: the bill's listing reads a note's
-- documents of both types, and WITH CHECK keeps the documents DELETE (UPDATE is_active = false) working on a legacy row. No app path
-- inserts that type (VALID_ENTITY_TYPES omits it); a row of it naming another company's note, or a note of the old
-- goods_receipt_notes table, stays invisible.

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
    OR (entity_type IN ('goods_received', 'goods_receipt_note') AND EXISTS (
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
    OR (entity_type IN ('goods_received', 'goods_receipt_note') AND EXISTS (
      SELECT 1 FROM public.goods_received_notes p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
  );

-- The service pool reaches procurement_documents through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
