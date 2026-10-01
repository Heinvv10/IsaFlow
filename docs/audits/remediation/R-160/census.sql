-- R-160 census — READ-ONLY. For Hein to run on prod; the session never connects there.
-- Bills written by ai-invoice-pipeline carry posting_agent = 'ai:ai-invoice-pipeline:v1'
-- (capture/[id]/post writes none), so this route's rows are distinguishable.
-- R-131/census.sql query 2 already counts these among "captured approved bills with no journal".
BEGIN READ ONLY;

-- 1. Pipeline bills approved (or later) with NO journal, per company: owing in the AP
--    subledger, absent from the GL. Split by whether they have any line items.
SELECT c.id AS company_id, c.name AS company, si.status,
       COUNT(*)                                                    AS bills,
       COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM supplier_invoice_items i
                                          WHERE i.supplier_invoice_id = si.id)) AS without_items,
       COUNT(*) FILTER (WHERE si.total_amount = 0)                 AS zero_total,
       SUM(si.total_amount - COALESCE(si.amount_paid, 0))::numeric AS outstanding,
       MIN(si.created_at) AS first_created, MAX(si.created_at) AS last_created
FROM supplier_invoices si
JOIN companies c ON c.id = si.company_id
WHERE si.posting_agent = 'ai:ai-invoice-pipeline:v1'
  AND si.status IN ('approved', 'partially_paid', 'paid')
  AND si.gl_journal_entry_id IS NULL
GROUP BY c.id, c.name, si.status
ORDER BY outstanding DESC NULLS LAST;

-- 2. Every pipeline bill (any status) with ZERO line items or a zero total — the other
--    defect: skipped lines left a bill with none, and a document with no total became a R0 bill.
SELECT si.company_id, si.id, si.invoice_number, si.status, si.invoice_date, si.total_amount,
       si.gl_journal_entry_id,
       (SELECT COUNT(*) FROM supplier_invoice_items i WHERE i.supplier_invoice_id = si.id) AS items,
       si.source_document_id, si.created_at
FROM supplier_invoices si
WHERE si.posting_agent = 'ai:ai-invoice-pipeline:v1'
  AND si.status <> 'cancelled'
  AND (si.total_amount = 0
       OR NOT EXISTS (SELECT 1 FROM supplier_invoice_items i WHERE i.supplier_invoice_id = si.id))
ORDER BY si.company_id, si.created_at;

-- 3. Detail for query 1 (the rows a repair would touch; no repair is proposed here).
SELECT si.company_id, si.id, si.invoice_number, si.status, si.invoice_date, si.total_amount,
       si.amount_paid, si.source_document_id, si.created_at
FROM supplier_invoices si
WHERE si.posting_agent = 'ai:ai-invoice-pipeline:v1'
  AND si.status IN ('approved', 'partially_paid', 'paid')
  AND si.gl_journal_entry_id IS NULL
ORDER BY si.company_id, si.created_at;

ROLLBACK;
