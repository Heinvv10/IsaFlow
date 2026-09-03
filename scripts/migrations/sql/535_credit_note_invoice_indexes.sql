-- ============================================================================
-- 535: index the credit-note -> invoice links the aging rewind joins on
--
-- The point-in-time AR and AP aging reports run a LATERAL per invoice row to
-- work out what settlement to rewind. Two of its branches join credit_notes on
-- the invoice link:
--
--     WHERE cn.customer_invoice_id = ci.id      (AR)
--     WHERE cn.supplier_invoice_id = si.id      (AP)
--
-- Neither column is indexed, so both branches sequentially scan credit_notes
-- once per invoice. credit_notes already carries eight indexes — company,
-- client, supplier, status, type, applied_amount, external_ref, actor — and
-- neither of the two invoice foreign keys is among them.
--
-- Partial on IS NOT NULL because the columns are mutually exclusive: a customer
-- credit note has customer_invoice_id and a NULL supplier_invoice_id, and an
-- unallocated note has neither. In production 93 of 93 customer notes carry a
-- customer_invoice_id and no note carries a supplier_invoice_id, so the
-- supplier index is empty today and costs nothing until AP credit notes exist.
--
-- customer_write_offs.invoice_id is deliberately absent from this migration:
-- it is already covered by idx_write_offs_invoice.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_credit_notes_customer_invoice
  ON credit_notes (customer_invoice_id)
  WHERE customer_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_supplier_invoice
  ON credit_notes (supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL;
