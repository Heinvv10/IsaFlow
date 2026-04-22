/**
 * PRD-05 Phase 5 — Bank-first inverted workflow
 * Evidence Attachment Service
 *
 * When a supplier invoice / receipt lands via capture inbox, attempts to match it
 * to an outstanding provisional JE and "flips" the JE to fully-evidenced.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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

  try {
    // Fetch source_document_hash from the captured_documents row (may be null)
    const [docRow] = (await sql`
      SELECT id, source_document_hash, extraction_confidence
      FROM captured_documents
      WHERE id = ${capturedDocumentId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];

    if (!docRow) return nothing;

    const docHash = docRow.source_document_hash ? String(docRow.source_document_hash) : null;
    const docConfidence = docRow.extraction_confidence ? Number(docRow.extraction_confidence) : null;

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

    // Flip the JE to evidenced
    await sql`
      UPDATE gl_journal_entries
      SET source_document_id   = ${capturedDocumentId}::UUID,
          source_document_hash = ${docHash},
          posting_agent        = 'ai-evidenced:v1',
          needs_evidence       = false,
          evidenced_at         = NOW(),
          extraction_confidence = COALESCE(${docConfidence}, extraction_confidence)
      WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    `;

    // Flip the bank transaction to matched
    await sql`
      UPDATE bank_transactions
      SET status = 'matched'
      WHERE id = ${btId}::UUID AND company_id = ${companyId}::UUID
    `;

    log.info('Evidence attached to provisional JE', {
      companyId,
      capturedDocumentId,
      jeId,
      bankTxId: btId,
      supplierId,
      totalAmount,
    }, 'evidence-attachment');

    return { attachedJeId: jeId, bankTxId: btId };
  } catch (err) {
    log.warn('attachEvidenceToProvisional failed — continuing', {
      companyId,
      capturedDocumentId,
      error: err instanceof Error ? err.message : String(err),
    }, 'evidence-attachment');
    return nothing;
  }
}
