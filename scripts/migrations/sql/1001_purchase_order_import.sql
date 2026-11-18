-- 1001: Purchase orders imported from Sage through MCP (bulk_create_purchase_orders), and their documents.
--
-- WHAT.
--   purchase_orders.external_ref / external_document_number / external_system
--     The source system's id for the PO (530's three columns, which never reached purchase_orders). The import is
--     idempotent on (company, external_system, external_ref): a PO already carrying the reference is returned, not
--     created again (externalRefService). Not unique, as 530 explains; a partial index leading with the tenant.
--   purchase_orders.status gains 'closed'
--     A PO that is finished: billed in full in the source system (Sage "Invoiced"). It commits nothing: committed
--     spend (budgets/remainingCommitted COMMITTING_PO_STATUSES), the bill-to-PO link list, the bank-match payable list
--     and the unmatched list all read ALLOWLISTS of statuses, and none of them names 'closed'. The PUT edits only
--     draft / submitted, the cancel path only approved, the delete only draft, so a closed PO is read-only.
--   mcp_upload_intents.target_kind gains 'purchase_order'
--     create_upload_urls / finalize_uploads can target a PO in the entity store (procurement_documents, whose
--     tenant_isolation_via_parent policy already has a purchase_order branch since 497/713). 999q's guard trigger
--     needs no change: a non-bank target is checked against procurement_documents by entity_type = target_kind.
--
--   po_items.unit_price NUMERIC(15,2) -> NUMERIC(19,6)
--     The import stores a line's EFFECTIVE ex-VAT unit price (line_total / quantity: a discount, an inclusive document
--     or a 4-decimal source price), so line_total = round(quantity x unit_price) still holds for every PO line. The app's
--     edit recomputes line_total from those two and a bill copies them; at 2 decimals that would silently re-price an
--     imported line. Widening loses nothing: every stored 2-decimal value is the same 6-decimal value.
--
-- LOCKS. The file is one transaction, so every table it alters stays ACCESS EXCLUSIVE until it commits:
--   purchase_orders and mcp_upload_intents for catalog changes and a CHECK scan, po_items for a rewrite (the type
--   change). All three are small (purchase_orders is empty on the companies this is for); lock_timeout bounds the wait.
--
-- OLD COLOUR. The old code never writes 'closed', 'purchase_order' intents or the new columns, and reads purchase_orders
--   by name (SELECT po.* returns three more columns, which the routes pass through). Nothing it does is refused.
--
-- Rollback (down SQL; roll the code back first, and only while no row uses what is dropped):
--   ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
--   ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN
--     ('draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'));
--   ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
--   ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
--     'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment'));
--   ALTER TABLE public.po_items ALTER COLUMN unit_price TYPE NUMERIC(15,2);   -- rounds any imported effective price
--   DROP INDEX IF EXISTS public.idx_purchase_orders_external_ref;
--   ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS external_ref, DROP COLUMN IF EXISTS external_document_number,
--     DROP COLUMN IF EXISTS external_system;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS external_system TEXT;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_external_ref
  ON public.purchase_orders (company_id, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN
  ('draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled'));

ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
  'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
  'purchase_order'));

ALTER TABLE public.po_items ALTER COLUMN unit_price TYPE NUMERIC(19,6);
