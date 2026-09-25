/**
 * The query behind the input-VAT support check (vatInputSupport.ts): one row
 * per reversal CHAIN with input-VAT movement in the period, and the facts its
 * classification needs. Read vatInputSupport.ts for the rules.
 *
 * CHAINS, NOT JOURNALS (review round 1, B1). A reversal of a reversal
 * reinstates a claim; judged journal by journal it looked like a reversal and
 * escaped. Every posted journal is walked up `reversal_of_id` to its ROOT (the
 * journal no reversal points above), the chain's movement in the period is
 * netted on the root, and the root's links — and only the root's — say what
 * supports it. The walk is bounded (100 levels) so a corrupt cycle ends.
 *
 * DOCUMENTS ARE COUNTED ACROSS CLAIMS (B2). A captured document's VAT supports
 * ONE claim: `document_claimed_vat` is the net input VAT of every chain whose
 * root names the document, over every period up to the period end.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { VAT_SUBMISSION_CLEARING_SOURCE } from './vatSubmissionClearing';

export async function queryInputVatSupport(
  companyId: string, periodStart: string, periodEnd: string, cent: number,
): Promise<DbRow[]> {
  return (await sql`
    WITH RECURSIVE moves AS (
      SELECT je.id, je.entry_date, SUM(jl.debit - jl.credit) AS vat
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${periodEnd}::DATE
        AND je.source IS DISTINCT FROM ${VAT_SUBMISSION_CLEARING_SOURCE}
        AND ga.account_subtype = 'vat_input'
      GROUP BY je.id, je.entry_date
    ),
    chain AS (
      SELECT m.id AS member, j.id AS node, j.reversal_of_id AS up, 0 AS depth
      FROM moves m JOIN gl_journal_entries j ON j.id = m.id AND j.company_id = ${companyId}::UUID
      UNION ALL
      SELECT ch.member, p.id, p.reversal_of_id, ch.depth + 1
      FROM chain ch JOIN gl_journal_entries p ON p.id = ch.up AND p.company_id = ${companyId}::UUID
      WHERE ch.depth < 100
    ),
    rooted AS (
      SELECT m.id, m.entry_date, m.vat, ch.node AS root
      FROM moves m JOIN chain ch ON ch.member = m.id AND ch.up IS NULL
    ),
    roots AS (
      SELECT r.root,
        SUM(r.vat) FILTER (WHERE r.entry_date >= ${periodStart}::DATE) AS claimed_vat,
        SUM(r.vat) AS claimed_to_date
      FROM rooted r GROUP BY r.root
    ),
    attributed AS (
      -- The journal whose links count: a late-claim companion's original.
      SELECT ro.*, rj.entry_number, rj.entry_date, rj.source, COALESCE(rj.description, '') AS description,
        COALESCE(rj.late_claim_of_id, rj.id) AS doc_je_id, orig.source AS doc_source,
        orig.source_record_id AS doc_record_id, orig.source_document_id AS document_id
      FROM roots ro
      JOIN gl_journal_entries rj ON rj.id = ro.root AND rj.company_id = ${companyId}::UUID
      JOIN gl_journal_entries orig ON orig.id = COALESCE(rj.late_claim_of_id, rj.id) AND orig.company_id = ${companyId}::UUID
    ),
    doc_claims AS (
      SELECT a.document_id, SUM(a.claimed_to_date) AS document_claimed_vat
      FROM attributed a WHERE a.document_id IS NOT NULL GROUP BY a.document_id
    )
    SELECT a.root AS id, a.entry_number, a.entry_date, a.source, a.description,
      a.claimed_vat, a.claimed_to_date, a.document_id, dc.document_claimed_vat,
      cd.id IS NOT NULL AS has_document, cd.extracted_data -> 'vatAmount' AS document_vat_raw,
      (SELECT SUM(ecl.vat_amount) FROM expense_claims ec
        JOIN expense_claim_lines ecl ON ecl.claim_id = ec.id AND ecl.company_id = ${companyId}::UUID
        WHERE ec.company_id = ${companyId}::UUID AND ec.posted_je_id = a.doc_je_id) AS expense_claim_vat,
      EXISTS (SELECT 1 FROM expense_claims ec
        WHERE ec.company_id = ${companyId}::UUID AND ec.posted_je_id = a.doc_je_id) AS is_expense_claim,
      (SELECT SUM(cn.tax_amount) FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.gl_journal_entry_id = a.doc_je_id) AS credit_note_vat,
      EXISTS (SELECT 1 FROM vat_adjustments va
        WHERE va.company_id = ${companyId}::UUID AND va.gl_journal_entry_id = a.doc_je_id) AS is_vat_adjustment,
      -- Bank support: a bank line matched to a line of the journal, or a
      -- bank-first PROVISIONAL journal (provisional_je_id — B5).
      (SELECT SUM(ABS(bt.amount)) FROM bank_transactions bt
        WHERE bt.company_id = ${companyId}::UUID
          AND (bt.provisional_je_id = a.doc_je_id
            OR bt.matched_journal_line_id IN (SELECT ml.id FROM gl_journal_lines ml
                 WHERE ml.company_id = ${companyId}::UUID AND ml.journal_entry_id = a.doc_je_id))) AS bank_amount
    FROM attributed a
    LEFT JOIN doc_claims dc ON dc.document_id = a.document_id
    LEFT JOIN captured_documents cd ON cd.id = a.document_id AND cd.company_id = ${companyId}::UUID
    WHERE ABS(COALESCE(a.claimed_vat, 0)) > ${cent}
      AND NOT EXISTS (
        SELECT 1 FROM supplier_invoices si
        WHERE si.company_id = ${companyId}::UUID
          AND (si.gl_journal_entry_id = a.doc_je_id
            OR (a.doc_source = 'auto_vat_adjustment' AND si.id = a.doc_record_id))
      )
    ORDER BY a.entry_date, a.entry_number
  `) as DbRow[];
}
