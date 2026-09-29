-- R-131 census — READ-ONLY. For Hein to run on prod; the session never connects there.
-- Wrap in a read-only transaction so nothing can write:
BEGIN READ ONLY;

-- 1. Approved (or later) supplier invoices with ZERO line items and NO journal, per company.
--    These are owing in the AP subledger and absent from the GL. A bill with no items
--    cannot post a balanced journal (buildExpenseLines books the expense side from items).
SELECT c.id AS company_id, c.name AS company, si.status,
       COUNT(*)                                                    AS bills,
       SUM(si.total_amount - COALESCE(si.amount_paid, 0))::numeric AS outstanding,
       SUM(si.total_amount)::numeric                               AS total,
       COUNT(*) FILTER (WHERE si.source_document_id IS NOT NULL)   AS from_capture,
       MIN(si.created_at) AS first_created, MAX(si.created_at) AS last_created
FROM supplier_invoices si
JOIN companies c ON c.id = si.company_id
WHERE si.status IN ('approved', 'partially_paid', 'paid')
  AND si.gl_journal_entry_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items i WHERE i.supplier_invoice_id = si.id)
GROUP BY c.id, c.name, si.status
ORDER BY outstanding DESC NULLS LAST;

-- 2. The wider gap the same fix closes for capture/[id]/post: captured bills that are
--    approved (or later) with NO journal, whether or not they have items, per company.
--    (ai-invoice-pipeline leaves the same shape; see fix.md "Sibling".)
SELECT c.id AS company_id, c.name AS company,
       COUNT(*) AS bills,
       COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM supplier_invoice_items i
                                          WHERE i.supplier_invoice_id = si.id)) AS without_items,
       SUM(si.total_amount - COALESCE(si.amount_paid, 0))::numeric AS outstanding
FROM supplier_invoices si
JOIN companies c ON c.id = si.company_id
WHERE si.status IN ('approved', 'partially_paid', 'paid')
  AND si.gl_journal_entry_id IS NULL
  AND si.source_document_id IS NOT NULL
GROUP BY c.id, c.name
ORDER BY outstanding DESC NULLS LAST;

-- 3. Detail for query 1 (the rows a repair would touch; no repair is proposed here).
SELECT si.company_id, si.id, si.invoice_number, si.status, si.invoice_date, si.total_amount,
       si.amount_paid, si.source_document_id, si.created_at
FROM supplier_invoices si
WHERE si.status IN ('approved', 'partially_paid', 'paid')
  AND si.gl_journal_entry_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items i WHERE i.supplier_invoice_id = si.id)
ORDER BY si.company_id, si.created_at;

ROLLBACK;
