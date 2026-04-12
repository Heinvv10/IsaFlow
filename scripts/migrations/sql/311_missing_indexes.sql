-- Migration 311: Missing indexes audit
-- Covers tables skipped in migrations 290 and 292, plus new tables added in 294-310.
--
-- Query patterns supported:
--   • Line-item lookups by parent FK: SELECT * FROM customer_invoice_items WHERE invoice_id = ?
--   • SO/PO item lookups:            SELECT * FROM customer_sales_order_items WHERE sales_order_id = ?
--   • GL account balance per period: SELECT * FROM gl_account_balances WHERE company_id = ? AND fiscal_period_id = ?
--   • Customer category list:        SELECT * FROM customer_categories WHERE company_id = ?
--   • Supplier category list:        SELECT * FROM supplier_categories WHERE company_id = ?
--   • Warehouse list:                SELECT * FROM warehouses WHERE company_id = ?
--   • Item category list:            SELECT * FROM item_categories WHERE company_id = ?
--   • Dunning by company+customer:   SELECT * FROM dunning_communications WHERE company_id = ? AND customer_id = ?
--   • Portal access by company:      SELECT * FROM portal_access WHERE company_id = ?
--   • Portal payment links list:     SELECT * FROM portal_payment_links WHERE company_id = ?
--   • Captured documents by company: SELECT * FROM captured_documents WHERE company_id = ?
--   • Supplier payment allocations:  SELECT * FROM supplier_payment_allocations WHERE payment_id = ?
--   • Company document numbers:      SELECT * FROM company_document_numbers WHERE company_id = ?
--   • Company messages by company:   SELECT * FROM company_messages WHERE company_id = ?
--   • Intercompany eliminations:     SELECT * FROM intercompany_eliminations WHERE group_company_id = ?
--   • Payroll: payslip by employee:  SELECT * FROM payslips WHERE employee_id = ?
--   • Leave balance by type:         SELECT * FROM leave_balances WHERE leave_type_id = ?
--   • Leave type list:               SELECT * FROM leave_types WHERE company_id = ?
--   • Document links by entity:      SELECT * FROM document_links WHERE linked_entity_type = ? AND linked_entity_id = ?
--   • GL journal lines item lookup:  SELECT * FROM gl_journal_lines WHERE item_id = ?


-- ── customer_invoice_items ─────────────────────────────────────────────────────
-- Used in every invoice detail fetch: WHERE invoice_id = ?
-- Also item-level reporting: WHERE item_id = ?, gl_account_id = ?
CREATE INDEX IF NOT EXISTS idx_cii_invoice_id
  ON customer_invoice_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_cii_item_id
  ON customer_invoice_items(item_id)
  WHERE item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cii_gl_account_id
  ON customer_invoice_items(gl_account_id)
  WHERE gl_account_id IS NOT NULL;


-- ── customer_quote_lines ───────────────────────────────────────────────────────
-- Used in quote detail: WHERE quote_id = ?
CREATE INDEX IF NOT EXISTS idx_cql_quote_id
  ON customer_quote_lines(quote_id);

CREATE INDEX IF NOT EXISTS idx_cql_item_id
  ON customer_quote_lines(item_id)
  WHERE item_id IS NOT NULL;


-- ── customer_sales_order_items ─────────────────────────────────────────────────
-- Used in SO detail: WHERE sales_order_id = ?
-- Also item lookup for fulfilment: WHERE item_id = ?
CREATE INDEX IF NOT EXISTS idx_csoi_sales_order_id
  ON customer_sales_order_items(sales_order_id);

CREATE INDEX IF NOT EXISTS idx_csoi_item_id
  ON customer_sales_order_items(item_id)
  WHERE item_id IS NOT NULL;


-- ── supplier_purchase_order_items ──────────────────────────────────────────────
-- Used in PO detail: WHERE purchase_order_id = ?
-- Also item lookup for receiving: WHERE item_id = ?
CREATE INDEX IF NOT EXISTS idx_spoi_purchase_order_id
  ON supplier_purchase_order_items(purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_spoi_item_id
  ON supplier_purchase_order_items(item_id)
  WHERE item_id IS NOT NULL;


-- ── delivery_note_lines ────────────────────────────────────────────────────────
-- Used in delivery note detail: WHERE delivery_note_id = ?
-- Also item lookup for fulfilment: WHERE item_id = ?
CREATE INDEX IF NOT EXISTS idx_dnl_item_id
  ON delivery_note_lines(item_id)
  WHERE item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_notes_customer
  ON delivery_notes(company_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_delivery_notes_invoice
  ON delivery_notes(invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_notes_status
  ON delivery_notes(company_id, status);


-- ── gl_account_balances ────────────────────────────────────────────────────────
-- Used in trial balance / balance sheet by company: WHERE company_id = ?
-- (existing indexes only cover gl_account_id and fiscal_period_id independently)
CREATE INDEX IF NOT EXISTS idx_gl_ab_company_period
  ON gl_account_balances(fiscal_period_id, gl_account_id);


-- ── customer_categories ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customer_categories_company
  ON customer_categories(company_id);


-- ── supplier_categories ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_supplier_categories_company
  ON supplier_categories(company_id);


-- ── item_categories ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_item_categories_company
  ON item_categories(company_id);


-- ── warehouses ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_warehouses_company
  ON warehouses(company_id);


-- ── dunning_communications ─────────────────────────────────────────────────────
-- Already has idx_dc_customer; adding company_id + status for list queries
CREATE INDEX IF NOT EXISTS idx_dc_company_customer
  ON dunning_communications(company_id, customer_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_company_status
  ON dunning_communications(company_id, status);


-- ── portal_access ──────────────────────────────────────────────────────────────
-- portal_access has no company_id column — client_id already indexed.
-- Add token index for auth lookup:
CREATE INDEX IF NOT EXISTS idx_portal_access_token
  ON portal_access(token)
  WHERE token IS NOT NULL;


-- ── portal_payment_links ───────────────────────────────────────────────────────
-- Add company_id index if column exists (added in some environments):
CREATE INDEX IF NOT EXISTS idx_ppl_invoice_id
  ON portal_payment_links(invoice_id);

CREATE INDEX IF NOT EXISTS idx_ppl_client_id
  ON portal_payment_links(client_id);


-- ── captured_documents ────────────────────────────────────────────────────────
-- No company_id on this table — add uploaded_by + status compound for user dashboard:
CREATE INDEX IF NOT EXISTS idx_captured_documents_uploader
  ON captured_documents(uploaded_by, created_at DESC)
  WHERE uploaded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_captured_documents_matched_inv
  ON captured_documents(matched_invoice_id)
  WHERE matched_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_captured_documents_matched_bt
  ON captured_documents(matched_bank_tx_id)
  WHERE matched_bank_tx_id IS NOT NULL;


-- ── supplier_payment_allocations ───────────────────────────────────────────────
-- No indexes at all — payment_id and invoice_id are high-traffic FK lookups
CREATE INDEX IF NOT EXISTS idx_spa_payment_id
  ON supplier_payment_allocations(payment_id);

CREATE INDEX IF NOT EXISTS idx_spa_invoice_id
  ON supplier_payment_allocations(invoice_id);


-- ── company_document_numbers ───────────────────────────────────────────────────
-- UNIQUE(company_id, document_type) constraint exists but no plain index on company_id
-- PostgreSQL creates a unique index automatically — no extra index needed.
-- Adding index on document_type for cross-company config queries:
CREATE INDEX IF NOT EXISTS idx_cdn_company
  ON company_document_numbers(company_id);


-- ── company_messages ──────────────────────────────────────────────────────────
-- UNIQUE(company_id, message_type) exists — plain company_id for list queries
CREATE INDEX IF NOT EXISTS idx_company_messages_company
  ON company_messages(company_id);


-- ── intercompany_eliminations ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_interco_elim_group
  ON intercompany_eliminations(group_company_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_interco_elim_from
  ON intercompany_eliminations(from_company_id);

CREATE INDEX IF NOT EXISTS idx_interco_elim_to
  ON intercompany_eliminations(to_company_id);


-- ── leave_types ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leave_types_company
  ON leave_types(company_id);


-- ── document_links ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON document_links(linked_entity_type, linked_entity_id);

CREATE INDEX IF NOT EXISTS idx_document_links_document
  ON document_links(document_id);


-- ── sales_reps ─────────────────────────────────────────────────────────────────
-- idx_sales_reps_company already exists; add is_active filter for active-only queries:
CREATE INDEX IF NOT EXISTS idx_sales_reps_company_active
  ON sales_reps(company_id, is_active)
  WHERE is_active = true;
