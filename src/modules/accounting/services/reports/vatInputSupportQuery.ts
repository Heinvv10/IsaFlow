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
 * behind the journal (the same one `bank_amount` sums) carries a supporting
 * document — a row in `bank_transaction_attachments` or a captured document
 * linked to the line (bank/bankLineDocumentSql) — PRESENCE. A captured one
 * with VAT read is judged as a USE instead (bank_documents, below).
 *
 * ONE TAX INVOICE, ONE CLAIM'S WORTH (Hein, 2026-11-07): `doc_uses` lists every
 * use of a captured document by a chain — a journal tie (doc_history), the
 * journal on a bank line it sits on (linked, or as its copy), a bill
 * (source_document_id or the capture's matched_invoice_id) and an expense
 * claim line (that LINE's VAT, while the claim still claims). `doc_root_use`
 * counts each (document, chain) once; `document_claimed_vat` sums them to the
 * period end. `bank_documents` / `claim_documents` hand each chain its bank-line
 * and claim-line documents as { vat, total, own } for vatInputDocumentUses.
 *
 * BREAKER ROUND 2 (item 1): `document_claimed_vat` sums (among its uses) every root that has
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
 * embedding `lib/neon/query.ts` supports). That splicing only works against the
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
import { bankLineCapturedDocIdsSql, hasBankLineDocumentSql, hasBankLineUploadSql } from '../bank/bankLineDocumentSql';
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
      JOIN gl_journal_entries orig2 ON orig2.id = a.doc_je_id AND orig2.company_id = ${companyId}::UUID
        AND orig2.source_document_id IS NOT NULL
      UNION
      SELECT DISTINCT a.root, jdl2.captured_document_id AS document_id
      FROM attributed a
      JOIN gl_journal_document_links jdl2
        ON jdl2.journal_entry_id = a.doc_je_id AND jdl2.company_id = ${companyId}::UUID
    ),
    chain_je AS (
      -- One row per (chain, underlying journal). attributed repeats a chain whose journal has two active links.
      SELECT root, doc_je_id, BOOL_OR(document_id IS NOT NULL) AS has_document FROM attributed GROUP BY root, doc_je_id
    ),
    bank_line_je AS (
      -- Each bank line of the company with the journal behind it (provisional, or the journal of its matched
      -- line), resolved once so the uses below join on equality rather than probing every line per chain.
      SELECT bt.id, bt.company_id, bt.provisional_je_id AS je_id FROM bank_transactions bt
      WHERE bt.company_id = ${companyId}::UUID AND bt.provisional_je_id IN (SELECT doc_je_id FROM chain_je)
      UNION
      SELECT bt.id, bt.company_id, ml.journal_entry_id FROM bank_transactions bt
      JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id AND ml.company_id = ${companyId}::UUID
        AND ml.journal_entry_id IN (SELECT doc_je_id FROM chain_je)
      WHERE bt.company_id = ${companyId}::UUID
    ),
    doc_uses AS (
      -- Every USE of a captured document by a chain: a journal tie (doc_history), the journal on a bank line the
      -- document sits on (bank/bankLineDocumentSql), a bill (its source_document_id, or the capture's
      -- matched_invoice_id), an expense claim line. line_vat is set only for a claim line.
      SELECT dh.document_id, dh.root, 'journal' AS via, NULL::NUMERIC AS line_vat FROM doc_history dh
      UNION ALL
      SELECT bd.id, a.root, 'bank', NULL FROM chain_je a
      JOIN bank_line_je bt ON bt.je_id = a.doc_je_id AND NOT a.has_document
      CROSS JOIN LATERAL ${sql.unsafe(bankLineCapturedDocIdsSql('bt'))} bd
      UNION ALL
      SELECT sd.document_id, a.root, 'bill', NULL FROM chain_je a
      JOIN supplier_invoices si ON si.company_id = ${companyId}::UUID AND si.gl_journal_entry_id = a.doc_je_id
      CROSS JOIN LATERAL (
        SELECT si.source_document_id AS document_id WHERE si.source_document_id IS NOT NULL
        UNION SELECT cdm.id FROM captured_documents cdm
        WHERE cdm.company_id = ${companyId}::UUID AND cdm.matched_invoice_id = si.id) sd
      UNION ALL
      SELECT ecl.source_document_id, a.root, 'claim', ecl.vat_amount FROM chain_je a
      JOIN expense_claims ec ON ec.company_id = ${companyId}::UUID AND ec.posted_je_id = a.doc_je_id
      JOIN expense_claim_lines ecl ON ecl.claim_id = ec.id AND ecl.company_id = ${companyId}::UUID
        AND ecl.source_document_id IS NOT NULL
    ),
    doc_root_use AS (
      -- One figure per (document, chain), however many routes tie them: an expense claim's lines on the document
      -- (their VAT, while the claim's chain still claims), else the chain's net claim to the period end. Only the
      -- company's own documents count.
      SELECT du.document_id, du.root, cdu.extracted_data -> 'vatAmount' AS vat_raw,
        CASE WHEN NOT BOOL_OR(du.via = 'claim') THEN MAX(ro.claimed_to_date)
             WHEN ABS(MAX(ro.claimed_to_date)) > ${cent} THEN SUM(du.line_vat) ELSE 0 END AS used_vat,
        BOOL_OR(du.via = 'bank') AS on_bank, BOOL_OR(du.via = 'claim') AS on_claim,
        COUNT(*) FILTER (WHERE du.via = 'claim') AS claim_lines
      FROM doc_uses du JOIN roots ro ON ro.root = du.root
      JOIN captured_documents cdu ON cdu.id = du.document_id AND cdu.company_id = ${companyId}::UUID
      GROUP BY du.document_id, du.root, cdu.extracted_data -> 'vatAmount'
    ),
    doc_claims AS (
      SELECT document_id, SUM(used_vat) AS document_claimed_vat FROM doc_root_use GROUP BY document_id
    ),
    uses_by_root AS (
      -- Each chain's bank-line and claim-line documents as { vat, total, own, lines }, aggregated once.
      SELECT u.root,
        json_agg(json_build_object('vat', u.vat_raw, 'total', dc.document_claimed_vat, 'own', u.used_vat,
          'lines', u.claim_lines)) FILTER (WHERE u.on_bank) AS bank_documents,
        json_agg(json_build_object('vat', u.vat_raw, 'total', dc.document_claimed_vat, 'own', u.used_vat,
          'lines', u.claim_lines)) FILTER (WHERE u.on_claim) AS claim_documents
      FROM doc_root_use u JOIN doc_claims dc ON dc.document_id = u.document_id
      GROUP BY u.root
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
      -- Item 2: a document on that SAME bank line is a tax invoice on file — PRESENCE, the grid's own definition
      -- (bank/bankLineDocumentSql). A captured one with VAT read is judged as a use (bank_documents) first.
      EXISTS (
        SELECT 1 FROM bank_transactions bt
        WHERE bt.company_id = ${companyId}::UUID
          AND ${sql.unsafe(hasBankLineDocumentSql('bt'))}
          AND (bt.provisional_je_id = a.doc_je_id
            OR bt.matched_journal_line_id IN (SELECT ml.id FROM gl_journal_lines ml
                 WHERE ml.company_id = ${companyId}::UUID AND ml.journal_entry_id = a.doc_je_id))
      ) AS has_bank_attachment,
      -- A plain upload on the chain's bank line (no captured document's copy): a document the report cannot read.
      EXISTS (
        SELECT 1 FROM bank_transactions bt
        WHERE bt.company_id = ${companyId}::UUID
          AND ${sql.unsafe(hasBankLineUploadSql('bt'))}
          AND (bt.provisional_je_id = a.doc_je_id
            OR bt.matched_journal_line_id IN (SELECT ml.id FROM gl_journal_lines ml
                 WHERE ml.company_id = ${companyId}::UUID AND ml.journal_entry_id = a.doc_je_id))
      ) AS has_bank_upload,
      -- The chain's uses of documents on its bank lines (only while it has no document of its own, which judges
      -- it alone) and on its expense claim lines: each document's VAT, its claimed total over every use
      -- (doc_claims), this chain's own share, and how many of its claim lines carry it.
      COALESCE(ubr.bank_documents, '[]'::json) AS bank_documents,
      COALESCE(ubr.claim_documents, '[]'::json) AS claim_documents
    FROM attributed a
    LEFT JOIN doc_claims dc ON dc.document_id = a.document_id
    LEFT JOIN uses_by_root ubr ON ubr.root = a.root
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
