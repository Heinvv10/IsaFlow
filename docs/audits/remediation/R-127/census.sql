-- R-127 census — READ-ONLY. Supplier invoices in the AP population whose source
-- document ALSO evidences a live bank-first provisional journal in the same
-- company. Does not reference migration 711's column, so it runs before or
-- after the deploy.
--   kind = 'double_booked_gl' : the invoice's own journal is posted and live —
--          expense and input VAT are in the GL twice and the AP it raised is
--          open against a bank line that already paid it.
--   kind = 'subledger_only'   : an auto-approved invoice with no journal (the
--          capture routes' shape) — the GL holds the bill once through the
--          provisional, but the AP subledger shows it owing, and "Post to GL"
--          before this fix would have booked it a second time.
--   already_settled = true    : a live supplier payment tied to the bank line
--          (reference = bank transaction id) is applied to this invoice — the
--          R-127 treatment has run (or a human settled it the same way).
WITH prov AS (
  SELECT je.company_id, je.id AS provisional_je_id, je.entry_number, je.entry_date,
         je.source_document_id, bt.id AS bank_tx_id, ABS(bt.amount) AS bank_amount
  FROM gl_journal_entries je
  JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id
  WHERE je.source_document_id IS NOT NULL
    AND je.status = 'posted' AND je.reversed_at IS NULL AND je.needs_evidence = false
)
SELECT p.company_id, c.name AS company_name,
       si.id AS invoice_id, si.invoice_number, si.status, si.invoice_date,
       si.total_amount, si.amount_paid,
       p.provisional_je_id, p.entry_number AS provisional_entry, p.entry_date AS provisional_date,
       p.bank_tx_id, p.bank_amount,
       CASE WHEN ije.id IS NOT NULL THEN 'double_booked_gl' ELSE 'subledger_only' END AS kind,
       EXISTS (
         SELECT 1 FROM supplier_payments sp
         JOIN payment_allocations pa ON pa.payment_id = sp.id AND pa.invoice_id = si.id
         WHERE sp.company_id = p.company_id AND sp.reference = p.bank_tx_id::TEXT
           AND sp.status <> 'cancelled'
       ) AS already_settled
FROM prov p
JOIN supplier_invoices si
  ON si.company_id = p.company_id AND si.source_document_id = p.source_document_id
LEFT JOIN gl_journal_entries ije
  ON ije.id = si.gl_journal_entry_id AND ije.company_id = si.company_id
 AND ije.status = 'posted' AND ije.reversed_at IS NULL
JOIN companies c ON c.id = p.company_id
WHERE si.status IN ('approved', 'partially_paid', 'paid') AND si.deleted_at IS NULL
ORDER BY c.name, p.entry_date, si.invoice_number;
