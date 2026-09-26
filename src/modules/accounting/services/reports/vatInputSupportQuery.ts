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
 *
 * VAT-gaps batch item 1: `document_id` is `source_document_id`, OR — when
 * that is NULL — the company's ACTIVE `gl_journal_document_links` row on the
 * journal (migration 706). A manual/recurring/Sage-GL-import/migration
 * journal linked after posting is classified identically to one created
 * from a capture.
 *
 * VAT-gaps batch item 2: `has_bank_attachment` is true when the bank line
 * behind the journal (the same one `bank_amount` sums) carries a row in
 * `bank_transaction_attachments` — PRESENCE only, it carries no extracted VAT
 * to compare against the claim.
 *
 * BREAKER ROUND 2 (item 1): `document_claimed_vat` sums every root that has
 * EVER been tied to the document — via the immutable `source_document_id`, or
 * ANY row in `gl_journal_document_links` regardless of `unlinked_at`.
 * Unlinking and relinking a document to a new journal no longer drops the old
 * journal's still-standing claim out of the total — a document's VAT can
 * support at most its own amount across every claim it has ever backed, not
 * merely the one currently linked to it. Each row's own `document_id` (used
 * to look up the document's own extracted VAT) stays the CURRENT attribution
 * — source_document_id, else the active link — so the verdict is still keyed
 * on what the journal is claimed to be supported by today.
 *
 * BREAKER ROUND 2 (item 2): `had_document_link` reuses `doc_history` (already
 * built for the sum above, already company_id-scoped on every join) to say
 * whether the root's journal has EVER carried a `gl_journal_document_links`
 * row, active or not. `vatInputSupport.ts` uses it to tell "never evidenced"
 * (`no_document`, a warning) apart from "was evidenced, isn't any more"
 * (`document_unlinked`, blocking) when nothing else supports the claim.
 *
 * NOTE ON THE `gl_journal_document_links` SCAN: this is inlined directly
 * rather than shared via a `gl/documentLinkHistorySql`-style helper that
 * builds its own `sql\`...\`` fragment and splices it in (the LazyQuery
 * embedding `lib/neon.ts` supports). That splicing only works against the
 * REAL `sql` tag; a test that mocks `sql` as a bare `vi.fn()` with a
 * positional queue of resolved values (vatExceptionsService.test.ts and
 * friends, via `vatExceptionsTestUtils.mockExceptionsSql`) has no such
 * splicing behaviour — constructing the fragment calls the mock an EXTRA
 * time to build a value that is then embedded as an opaque object, silently
 * consuming one queued mock result and shifting every later query's result
 * by one position (this broke `declaredElsewhere`, the query queued right
 * after this one, until fixed). Same reasoning as `documentJournalClaimGuard
 * .ts`'s header on why IT doesn't use the shared fragment either — a helper
 * that calls `sql` to build a piece of a bigger query is only safe to use
 * inside code no low-level `sql`-mocked test exercises.
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
      -- document_id prefers source_document_id; a journal with none (manual,
      -- recurring, Sage-GL-import, migration) falls back to an ACTIVE
      -- gl_journal_document_links row on THAT SAME journal (migration 706).
      SELECT ro.*, rj.entry_number, rj.entry_date, rj.source, COALESCE(rj.description, '') AS description,
        COALESCE(rj.late_claim_of_id, rj.id) AS doc_je_id, orig.source AS doc_source,
        orig.source_record_id AS doc_record_id,
        COALESCE(orig.source_document_id, jdl.captured_document_id) AS document_id
      FROM roots ro
      JOIN gl_journal_entries rj ON rj.id = ro.root AND rj.company_id = ${companyId}::UUID
      JOIN gl_journal_entries orig ON orig.id = COALESCE(rj.late_claim_of_id, rj.id) AND orig.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_document_links jdl
        ON jdl.journal_entry_id = orig.id AND jdl.company_id = ${companyId}::UUID AND jdl.unlinked_at IS NULL
    ),
    doc_history AS (
      -- Every document a root's underlying journal has EVER been tied to:
      -- the immutable source_document_id, or ANY link row ever recorded for
      -- it (active or unlinked). Deduplicated per (root, document) so a
      -- journal linked and relinked to the SAME document is not double-counted.
      SELECT DISTINCT a.root, orig2.source_document_id AS document_id
      FROM attributed a
      JOIN gl_journal_entries orig2 ON orig2.id = a.doc_je_id AND orig2.source_document_id IS NOT NULL
      UNION
      SELECT DISTINCT a.root, jdl2.captured_document_id AS document_id
      FROM attributed a
      JOIN gl_journal_document_links jdl2
        ON jdl2.journal_entry_id = a.doc_je_id AND jdl2.company_id = ${companyId}::UUID
    ),
    doc_claims AS (
      SELECT dh.document_id, SUM(ro.claimed_to_date) AS document_claimed_vat
      FROM doc_history dh JOIN roots ro ON ro.root = dh.root
      GROUP BY dh.document_id
    )
    SELECT a.root AS id, a.entry_number, a.entry_date, a.source, a.description,
      a.claimed_vat, a.claimed_to_date, a.document_id, dc.document_claimed_vat,
      cd.id IS NOT NULL AS has_document, cd.extracted_data -> 'vatAmount' AS document_vat_raw,
      -- Breaker fix (item 2, Hein 2026-09-26): has this chain's journal EVER
      -- carried a document link (active or unlinked)? doc_history already
      -- scopes by company_id on every join; reused here so an unlink alone
      -- (no active row left) still reads as "had one".
      EXISTS (SELECT 1 FROM doc_history dh WHERE dh.root = a.root) AS had_document_link,
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
                 WHERE ml.company_id = ${companyId}::UUID AND ml.journal_entry_id = a.doc_je_id))) AS bank_amount,
      -- Item 2: an invoice attached to that SAME bank line counts as a tax
      -- invoice on file — presence only, no VAT amount to compare.
      EXISTS (
        SELECT 1 FROM bank_transactions bt
        JOIN bank_transaction_attachments bta ON bta.bank_transaction_id = bt.id
        WHERE bt.company_id = ${companyId}::UUID
          AND (bt.provisional_je_id = a.doc_je_id
            OR bt.matched_journal_line_id IN (SELECT ml.id FROM gl_journal_lines ml
                 WHERE ml.company_id = ${companyId}::UUID AND ml.journal_entry_id = a.doc_je_id))
      ) AS has_bank_attachment
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
