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
-- LOCKS. Each ALTER takes ACCESS EXCLUSIVE on its table for the catalog change only: the new CHECKs are added
--   NOT VALID and then VALIDATEd (SHARE UPDATE EXCLUSIVE, readers and writers carry on), the columns are nullable
--   with no default (no rewrite).
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
  ('draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled')) NOT VALID;
ALTER TABLE public.purchase_orders VALIDATE CONSTRAINT purchase_orders_status_check;

ALTER TABLE public.mcp_upload_intents DROP CONSTRAINT IF EXISTS mcp_upload_intents_target_kind_check;
ALTER TABLE public.mcp_upload_intents ADD CONSTRAINT mcp_upload_intents_target_kind_check CHECK (target_kind IN (
  'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
  'purchase_order')) NOT VALID;
ALTER TABLE public.mcp_upload_intents VALIDATE CONSTRAINT mcp_upload_intents_target_kind_check;
