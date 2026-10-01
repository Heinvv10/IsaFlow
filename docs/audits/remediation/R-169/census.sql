-- R-169 census — READ ONLY. For Hein to run on prod; never run here.
-- ai-invoice-pipeline never marked the document's capture_events row posted, and
-- recordCoding always stored glAccountId: null for a pipeline bill even when the
-- pipeline's own lines were coded from the supplier's coding rule. This fix does
-- not touch historical rows — no repair is proposed, and none is run by this file.

-- 1. capture_events still 'extracted' (or another pre-posted status) whose
--    document was in fact turned into a bill by the pipeline: the summary, per
--    company.
SELECT ce.company_id, COUNT(*) AS stuck_events
FROM capture_events ce
JOIN captured_documents cd ON cd.id = ce.captured_document_id
JOIN supplier_invoices si ON si.id = cd.matched_invoice_id
WHERE ce.status <> 'posted'
  AND si.posting_agent = 'ai:ai-invoice-pipeline:v1'
GROUP BY ce.company_id
ORDER BY stuck_events DESC;

-- 2. The detail rows for query 1.
SELECT ce.id AS event_id, ce.company_id, ce.status AS event_status, ce.captured_document_id,
       si.id AS invoice_id, si.invoice_number, si.status AS invoice_status, si.created_at AS invoice_created_at
FROM capture_events ce
JOIN captured_documents cd ON cd.id = ce.captured_document_id
JOIN supplier_invoices si ON si.id = cd.matched_invoice_id
WHERE ce.status <> 'posted'
  AND si.posting_agent = 'ai:ai-invoice-pipeline:v1'
ORDER BY si.created_at;

-- 3. Pipeline coding-history rows overall: how many carry no GL account at all.
SELECT COUNT(*) FILTER (WHERE gl_account_id IS NULL)     AS null_gl,
       COUNT(*) FILTER (WHERE gl_account_id IS NOT NULL) AS coded_gl,
       COUNT(*)                                          AS total
FROM supplier_coding_history
WHERE posted_by = 'ai:ai-invoice-pipeline:v1';

-- 4. Pipeline coding-history rows with no GL account, for a supplier who has
--    (today) a coding rule with an account on it — the rows that would have
--    carried that account had this fix been live at posting time. This is an
--    approximation: the rule may have been created or repointed since. Per
--    company, with detail.
SELECT sch.company_id, COUNT(*) AS uncoded_with_rule_available
FROM supplier_coding_history sch
JOIN supplier_coding_rules scr
  ON scr.company_id = sch.company_id AND scr.supplier_id = sch.supplier_id
WHERE sch.posted_by = 'ai:ai-invoice-pipeline:v1'
  AND sch.gl_account_id IS NULL
  AND scr.default_gl_account_id IS NOT NULL
GROUP BY sch.company_id
ORDER BY uncoded_with_rule_available DESC;

SELECT sch.id AS history_id, sch.company_id, sch.supplier_id, sch.supplier_invoice_id,
       scr.default_gl_account_id AS rule_account_today, sch.created_at
FROM supplier_coding_history sch
JOIN supplier_coding_rules scr
  ON scr.company_id = sch.company_id AND scr.supplier_id = sch.supplier_id
WHERE sch.posted_by = 'ai:ai-invoice-pipeline:v1'
  AND sch.gl_account_id IS NULL
  AND scr.default_gl_account_id IS NOT NULL
ORDER BY sch.created_at;
