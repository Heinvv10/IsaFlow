-- One-off check (Hein, 2026-11-07): captured documents that already back MORE THAN ONE input-VAT claim.
-- Read-only. Run per database with psql: psql "$URL" -f scripts/audit/vat-document-double-use.sql
-- Production only with Hein's approval for that run.
--
-- A claim is keyed by the journal that claims the VAT, so one bill and its own journal, or a receipt matched to its
-- own bank line, count once. Uses: a posted, unreversed journal claiming input VAT (source_document_id or an active
-- link); a live bill with VAT; a live expense claim line with VAT; the journal on a bank line the document sits on
-- (linked, or as its copy) when that journal claims input VAT.
WITH vat_journals AS (
  SELECT je.id, je.company_id, je.entry_number, je.entry_date
  FROM gl_journal_entries je
  WHERE je.status = 'posted'
    -- Stands: an even number of posted reversals below it in its chain (shared/journalInForceAsAt's parity).
    AND (WITH RECURSIVE reversals AS (
           SELECT r.id, ARRAY[r.reversal_of_id, r.id] AS path FROM gl_journal_entries r
            WHERE r.reversal_of_id = je.id AND r.company_id = je.company_id AND r.status = 'posted'
           UNION ALL
           SELECT j.id, reversals.path || j.id FROM gl_journal_entries j JOIN reversals ON j.reversal_of_id = reversals.id
            WHERE j.company_id = je.company_id AND j.status = 'posted'
              AND NOT j.id = ANY(reversals.path) AND cardinality(reversals.path) < 100)
         SELECT COUNT(*) % 2 = 0 FROM reversals)
    -- Input VAT, including a late claim's clearing account (section 16(3)).
    AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM gl_journal_lines jl
           JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
          WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
            AND ga.account_subtype IN ('vat_input', 'vat_input_late_claim')) > 0.005
),
uses AS (
  SELECT je.source_document_id AS document_id, vj.company_id, vj.id::TEXT AS claim_key, 'journal ' || vj.entry_number AS what
  FROM vat_journals vj JOIN gl_journal_entries je ON je.id = vj.id WHERE je.source_document_id IS NOT NULL
  UNION
  SELECT l.captured_document_id, vj.company_id, vj.id::TEXT, 'journal ' || vj.entry_number || ' (link)'
  FROM gl_journal_document_links l JOIN vat_journals vj ON vj.id = l.journal_entry_id AND vj.company_id = l.company_id
  WHERE l.unlinked_at IS NULL
  UNION
  SELECT d.document_id, si.company_id, COALESCE(si.gl_journal_entry_id::TEXT, 'bill:' || si.id), 'bill ' || si.invoice_number
  FROM supplier_invoices si
  CROSS JOIN LATERAL (
    SELECT si.source_document_id AS document_id WHERE si.source_document_id IS NOT NULL
    UNION SELECT cd.id FROM captured_documents cd WHERE cd.matched_invoice_id = si.id AND cd.company_id = si.company_id
  ) d
  WHERE si.status NOT IN ('draft', 'cancelled') AND ABS(COALESCE(si.tax_amount, 0)) > 0.005
  UNION
  SELECT ecl.source_document_id, ec.company_id, COALESCE(ec.posted_je_id::TEXT, 'claim:' || ec.id), 'expense claim ' || ec.claim_number
  FROM expense_claim_lines ecl JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
  WHERE ecl.source_document_id IS NOT NULL AND ABS(ecl.vat_amount) > 0.005
    AND ec.status NOT IN ('draft', 'rejected', 'cancelled')
  UNION
  SELECT cd.id, bt.company_id, vj.id::TEXT, 'bank line ' || bt.transaction_date || ' ' || bt.amount || ' (journal ' || vj.entry_number || ')'
  FROM captured_documents cd
  JOIN bank_transactions bt ON bt.id = cd.matched_bank_tx_id AND bt.company_id = cd.company_id
  JOIN vat_journals vj ON vj.company_id = bt.company_id AND (vj.id = bt.provisional_je_id
    OR vj.id = (SELECT ml.journal_entry_id FROM gl_journal_lines ml WHERE ml.id = bt.matched_journal_line_id
                  AND ml.company_id = bt.company_id))
  WHERE cd.status <> 'rejected'
)
SELECT c.name AS company, u.document_id, cd.file_name, cd.extracted_data ->> 'vatAmount' AS document_vat,
  COUNT(DISTINCT u.claim_key) AS claims, string_agg(DISTINCT u.what, '; ') AS used_by
FROM uses u
JOIN captured_documents cd ON cd.id = u.document_id AND cd.company_id = u.company_id
JOIN companies c ON c.id = u.company_id
GROUP BY c.name, u.document_id, cd.file_name, cd.extracted_data ->> 'vatAmount'
HAVING COUNT(DISTINCT u.claim_key) > 1
ORDER BY c.name, claims DESC;
