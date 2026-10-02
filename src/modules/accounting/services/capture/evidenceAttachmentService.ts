/**
 * PRD-05 Phase 5 — Bank-first inverted workflow
 * Evidence Attachment Service
 *
 * When a supplier invoice / receipt lands via capture inbox, attempts to match it
 * to an outstanding provisional JE and "flips" the JE to fully-evidenced.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertDocumentNotAlreadyPosted } from '@/modules/accounting/services/gl/documentJournalClaimGuard';
import { journalStandsUnbrokenFragment } from '@/modules/accounting/services/shared/journalInForceAsAt';
import { findJournalChainHead } from '@/modules/accounting/services/shared/journalChainHead';

type Row = DbRow;

export interface AttachResult {
  attachedJeId: string | null;
  bankTxId: string | null;
}

/**
 * Find a provisional JE that matches supplier + amount (±R0.01) + date (±2 days)
 * and flip it from provisional to evidenced.
 *
 * Does NOT throw on no-match — returns null ids so the caller can continue
 * without interrupting the capture post flow.
 */
export async function attachEvidenceToProvisional(
  companyId: string,
  capturedDocumentId: string,
  supplierId: string | null,
  totalAmount: number,
  documentDate: string,
): Promise<AttachResult> {
  const nothing: AttachResult = { attachedJeId: null, bankTxId: null };

  // Best-effort, and ISOLATED: the callers (capture/[id]/post via capturePostFollowUps,
  // ai-invoice-pipeline) run it inside the request transaction after the invoice is
  // written, and swallow its failure. Without the savepoint a failed statement here —
  // a deadlock with the manual attach, which takes bank line -> journal -> slip while
  // these callers hold the slip first — aborted that transaction, the route answered
  // 200, and withAuth's COMMIT became a silent ROLLBACK of the invoice (R-107 r1, K-157).
  try {
    return await withSavepoint('evidence_attach', async () => {
      // Fetch raw_bytes_sha256 + confidence from the captured_documents row.
      // captured_documents stores the file hash under raw_bytes_sha256 (mig-410);
      // extraction_confidence lives in extracted_data JSON (set by VLM service).
      const [docRow] = (await sql`
        SELECT id, raw_bytes_sha256, extracted_data
        FROM captured_documents
        WHERE id = ${capturedDocumentId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[];

      if (!docRow) return nothing;

      const docHash = docRow.raw_bytes_sha256 ? String(docRow.raw_bytes_sha256) : null;
      const extractedData = (docRow.extracted_data ?? {}) as Record<string, unknown>;
      const rawConfidence = extractedData.confidence;
      const docConfidence = typeof rawConfidence === 'number' ? rawConfidence : null;

      // Find matching provisional JE via linked bank_transaction
      // Matching rules:
      //   - JE needs_evidence = true
      //   - bank_transactions.status = 'provisional'
      //   - supplierId match (when provided)
      //   - ABS(bank_transactions.amount) within R0.01 of totalAmount
      //   - bank_transactions.transaction_date within ±2 days of documentDate
      let matchRows: Row[];

      if (supplierId) {
        matchRows = (await sql`
          SELECT je.id AS je_id, bt.id AS bt_id
          FROM gl_journal_entries je
          JOIN bank_transactions bt ON bt.provisional_je_id = je.id
          WHERE je.company_id = ${companyId}::UUID
            AND bt.company_id = ${companyId}::UUID
            AND je.needs_evidence = true
            AND bt.status = 'provisional'
            AND bt.predicted_supplier_id = ${supplierId}::UUID
            AND ABS(bt.amount) BETWEEN ${totalAmount - 0.01} AND ${totalAmount + 0.01}
            AND bt.transaction_date BETWEEN (${documentDate}::DATE - INTERVAL '2 days')
                                        AND (${documentDate}::DATE + INTERVAL '2 days')
          ORDER BY bt.transaction_date DESC
          LIMIT 1
        `) as Row[];
      } else {
        matchRows = (await sql`
          SELECT je.id AS je_id, bt.id AS bt_id
          FROM gl_journal_entries je
          JOIN bank_transactions bt ON bt.provisional_je_id = je.id
          WHERE je.company_id = ${companyId}::UUID
            AND bt.company_id = ${companyId}::UUID
            AND je.needs_evidence = true
            AND bt.status = 'provisional'
            AND ABS(bt.amount) BETWEEN ${totalAmount - 0.01} AND ${totalAmount + 0.01}
            AND bt.transaction_date BETWEEN (${documentDate}::DATE - INTERVAL '2 days')
                                        AND (${documentDate}::DATE + INTERVAL '2 days')
          ORDER BY bt.transaction_date DESC
          LIMIT 1
        `) as Row[];
      }

      if (matchRows.length === 0) return nothing;

      const jeId = String(matchRows[0]!.je_id);
      const btId = String(matchRows[0]!.bt_id);

      // One document, one claim, at the GL write side — before the bank-line
      // write below. A document that already backs a posted, unreversed
      // journal (e.g. the invoice this same request just raised) is not
      // re-attached here; the caller's try/catch treats this as no match.
      await assertDocumentNotAlreadyPosted(companyId, capturedDocumentId, jeId);
      // A broken reversal chain is no candidate: the flip's fragment sees a broken ROOT only (D8 round 6, brk-d8b F3).
      if ((await findJournalChainHead(companyId, jeId))?.kind === 'broken') return nothing;

      // (1) THE BANK LINE FIRST, then (4) the journal — the canonical order in
      // `bank/.claude.md`, and the twin of the same reorder in
      // `pages/api/accounting/provisional/[jeId]/attach.ts`. Reversed, these two
      // writes invert every settlement path that holds a bank line and then
      // reaches a PRE-EXISTING journal. Both statements address a row by id and
      // neither reads what the other writes, so only the order changes.
      await sql`
        UPDATE bank_transactions
        SET status = 'matched'
        WHERE id = ${btId}::UUID AND company_id = ${companyId}::UUID
      `;

      // Flip the JE to evidenced — only if it still needs evidence. The match above read it
      // unlocked; a manual attach that committed while this waited on the bank line has
      // evidenced it already, and must not be overwritten. Throwing rolls the bank UPDATE back.
      // Standing by its reversal chain, not its stamp (D8): a provisional reversed and
      // re-reversed books the bank line again and still needs its evidence.
      const flipped = (await sql`
        UPDATE gl_journal_entries je
        SET source_document_id   = ${capturedDocumentId}::UUID,
            source_document_hash = ${docHash},
            posting_agent        = 'ai-evidenced:v1',
            needs_evidence       = false,
            evidenced_at         = NOW(),
            extraction_confidence = COALESCE(${docConfidence}, extraction_confidence)
        WHERE je.id = ${jeId}::UUID AND je.company_id = ${companyId}::UUID
          AND je.needs_evidence = true AND ${journalStandsUnbrokenFragment('je.id', companyId)}
        RETURNING je.id
      `) as Row[];
      if (flipped.length === 0) throw new Error(`Provisional journal ${jeId} was evidenced by another request`);

      log.info('Evidence attached to provisional JE', {
        companyId,
        capturedDocumentId,
        jeId,
        bankTxId: btId,
        supplierId,
        totalAmount,
      }, 'evidence-attachment');

      return { attachedJeId: jeId, bankTxId: btId };
    });
  } catch (err) {
    log.warn('attachEvidenceToProvisional failed — continuing', {
      companyId,
      capturedDocumentId,
      error: err instanceof Error ? err.message : String(err),
    }, 'evidence-attachment');
    return nothing;
  }
}
