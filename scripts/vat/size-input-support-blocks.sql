-- Pre-deploy sizing for the VAT-gaps batch (item 13). READ-ONLY — this is not
-- a migration and writes nothing. Run it on production BEFORE deploying the
-- input-VAT support check (reports/vatInputSupport.ts) and the unposted-
-- invoice block (reports/vatUnpostedInvoices.ts) so Hein knows, per company
-- and VAT period, how many journals/invoices would newly refuse eFiling.
--
-- Usage: psql "$DATABASE_URL" -f scripts/vat/size-input-support-blocks.sql
--
-- APPROXIMATIONS (this is a sizing estimate, not the exact app logic):
--   - VAT periods are bucketed as calendar Jan/Feb, Mar/Apr, ... pairs. Most
--     SA VAT vendors file bimonthly on this cadence, but a company's actual
--     registered period boundary can differ — treat counts as indicative,
--     not exact, for a company on an odd cycle.
--   - "would be unsupportedInputVat" here means: net input-VAT movement in
--     the period > 1 cent, with NO document link (source_document_id or an
--     ACTIVE gl_journal_document_links row), NOT a bill/expense-claim/
--     credit-note/VAT-adjustment journal, and either no bank line at all or
--     the claimed VAT exceeds 15%-of-money on the matched bank line. It does
--     NOT walk reversal chains to their root (vatInputSupportQuery.ts does;
--     this script measures per-journal, which is a slightly WIDER estimate —
--     a reversed-and-reinstated claim can double-count here where the app
--     would net it to one chain).
--   - "unposted invoice VAT" mirrors vatUnpostedInvoices.ts's population
--     directly (issued invoices / approved bills with VAT and no live
--     posted, unreversed journal) — this part is exact, not approximate.

\echo '=== Per-company, per-period: journals that would newly show as unsupportedInputVat ==='
WITH period AS (
  SELECT
    jl.company_id,
    date_trunc('year', je.entry_date)
      + make_interval(months => (EXTRACT(month FROM je.entry_date)::int - 1) / 2 * 2) AS period_start,
    je.id AS journal_id,
    SUM(jl.debit - jl.credit) AS vat
  FROM gl_journal_lines jl
  JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
  JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
  WHERE je.status = 'posted'
    AND je.source IS DISTINCT FROM 'auto_vat_submission'
    AND ga.account_subtype = 'vat_input'
  GROUP BY jl.company_id, je.id, je.entry_date
  HAVING ABS(SUM(jl.debit - jl.credit)) > 0.005
),
classified AS (
  SELECT p.*,
    EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.id = p.journal_id AND je.source_document_id IS NOT NULL) AS has_source_doc,
    EXISTS (SELECT 1 FROM gl_journal_document_links jdl
      WHERE jdl.journal_entry_id = p.journal_id AND jdl.unlinked_at IS NULL) AS has_active_link,
    EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.gl_journal_entry_id = p.journal_id) AS is_bill,
    EXISTS (SELECT 1 FROM expense_claims ec WHERE ec.posted_je_id = p.journal_id) AS is_expense_claim,
    EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.gl_journal_entry_id = p.journal_id) AS is_credit_note,
    EXISTS (SELECT 1 FROM vat_adjustments va WHERE va.gl_journal_entry_id = p.journal_id) AS is_vat_adjustment,
    (SELECT SUM(ABS(bt.amount)) FROM bank_transactions bt
      WHERE bt.provisional_je_id = p.journal_id
        OR bt.matched_journal_line_id IN (SELECT id FROM gl_journal_lines WHERE journal_entry_id = p.journal_id)
    ) AS bank_amount
  FROM period p
)
SELECT company_id, period_start, period_start + INTERVAL '1 month' + (INTERVAL '1 month' - INTERVAL '1 day') AS period_end,
  COUNT(*) AS estimated_unsupported_journals,
  ROUND(SUM(vat)::numeric, 2) AS estimated_unsupported_input_vat
FROM classified
WHERE NOT has_source_doc AND NOT has_active_link AND NOT is_bill AND NOT is_expense_claim
  AND NOT is_credit_note AND NOT is_vat_adjustment
  AND (bank_amount IS NULL OR vat > ROUND(bank_amount * 0.15 / 1.15, 2) + 0.005)
  AND vat > 0.005
GROUP BY company_id, period_start
ORDER BY company_id, period_start;

\echo ''
\echo '=== Per-company, per-period: unposted invoices/bills carrying VAT (exact, mirrors vatUnpostedInvoices.ts) ==='
WITH docs AS (
  SELECT ci.company_id, ci.invoice_date AS doc_date, COALESCE(ci.tax_amount, 0) AS unposted_vat
  FROM customer_invoices ci
  LEFT JOIN gl_journal_entries je ON je.id = ci.gl_journal_entry_id AND je.company_id = ci.company_id
  WHERE ci.deleted_at IS NULL
    AND ci.vat_declared_elsewhere_at IS NULL
    AND ci.status IN ('sent', 'approved', 'partially_paid', 'paid', 'overdue')
    AND (
      ci.gl_journal_entry_id IS NULL
      OR je.status IS DISTINCT FROM 'posted'
      -- Reversed OUT: an ODD number of posted links in its reversal chain (D7) —
      -- a delete undone in-period, O <- R <- R2, stands and does not block.
      OR (WITH RECURSIVE l AS (
            SELECT r.id FROM gl_journal_entries r
            WHERE r.reversal_of_id = ci.gl_journal_entry_id AND r.company_id = ci.company_id AND r.status = 'posted'
            UNION ALL
            SELECT j.id FROM gl_journal_entries j JOIN l ON j.reversal_of_id = l.id
            WHERE j.company_id = ci.company_id AND j.status = 'posted')
          SELECT COUNT(*) % 2 = 1 FROM l)
    )
  UNION ALL
  SELECT si.company_id, si.invoice_date,
    COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii WHERE sii.supplier_invoice_id = si.id), si.tax_amount, 0)
  FROM supplier_invoices si
  LEFT JOIN gl_journal_entries je ON je.id = si.gl_journal_entry_id AND je.company_id = si.company_id
  WHERE si.deleted_at IS NULL
    AND si.vat_declared_elsewhere_at IS NULL
    AND si.status IN ('approved', 'partially_paid', 'paid')
    AND (
      si.gl_journal_entry_id IS NULL
      OR je.status IS DISTINCT FROM 'posted'
      -- Reversed OUT: an ODD number of posted links in its reversal chain (D7) —
      -- a delete undone in-period, O <- R <- R2, stands and does not block.
      OR (WITH RECURSIVE l AS (
            SELECT r.id FROM gl_journal_entries r
            WHERE r.reversal_of_id = si.gl_journal_entry_id AND r.company_id = si.company_id AND r.status = 'posted'
            UNION ALL
            SELECT j.id FROM gl_journal_entries j JOIN l ON j.reversal_of_id = l.id
            WHERE j.company_id = si.company_id AND j.status = 'posted')
          SELECT COUNT(*) % 2 = 1 FROM l)
    )
)
SELECT company_id,
  date_trunc('year', doc_date) + make_interval(months => (EXTRACT(month FROM doc_date)::int - 1) / 2 * 2) AS period_start,
  COUNT(*) AS unposted_invoice_count,
  ROUND(SUM(unposted_vat)::numeric, 2) AS unposted_invoice_vat
FROM docs
WHERE unposted_vat <> 0
GROUP BY company_id, period_start
ORDER BY company_id, period_start;
