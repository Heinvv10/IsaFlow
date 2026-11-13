/**
 * Background VLM extraction for bank tx attachments, shared by both routes that store one
 * (/api/accounting/bank-tx-attachments and /api/accounting/documents with entity_type bank_transaction).
 *
 * Runs after the request COMMITs, on the pool's role with no RLS (R-075), so the UPDATE carries the tenant predicate
 * itself. bank_transaction_attachments has no company_id column; it is scoped through its parent transaction, so
 * this reproduces the table's own RLS WITH CHECK.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/core/ocrService';
import { isVlmAvailable } from './vlmService';

export async function extractAttachmentBytes(buffer: Buffer, mime: string, attachmentId: string, companyId: string) {
  const isPdf = mime === 'application/pdf';

  const extracted = isPdf
    ? await extractFromPdf(buffer)
    : await extractFromImage(buffer, mime);

  if (extracted && extracted.confidence > 0) {
    const stored = await sql`
      UPDATE bank_transaction_attachments
      SET extracted_data = ${JSON.stringify(extracted)}::jsonb
      WHERE id = ${attachmentId}::uuid
        AND EXISTS (
          SELECT 1 FROM bank_transactions bt
          WHERE bt.id = bank_transaction_attachments.bank_transaction_id
            AND bt.company_id = ${companyId}::uuid
        )
      RETURNING id
    `;
    // By outcome: the fence can match nothing, and a success log there would be
    // the same false "extraction complete" R-075 itself produced.
    if (stored.length === 0) {
      log.warn('VLM extraction discarded — attachment is not this company\'s', { attachmentId, companyId }, 'bank-tx-attachments');
    } else {
      log.info('VLM extraction stored for bank tx attachment', { attachmentId, confidence: extracted.confidence }, 'bank-tx-attachments');
    }
  }
}

/** The data-URL form the bank-tx-attachments route holds. */
export async function extractAttachmentData(dataUrl: string, mime: string, attachmentId: string, companyId: string) {
  const base64Part = dataUrl.split(',')[1];
  if (!base64Part) return;
  await extractAttachmentBytes(Buffer.from(base64Part, 'base64'), mime, attachmentId, companyId);
}

/** Fire-and-forget extraction once the request commits; a no-op when no VLM is configured. */
export function scheduleAttachmentExtraction(buffer: Buffer, mime: string, attachmentId: string, companyId: string): void {
  if (!isVlmAvailable()) return;
  runAfterCommit('bank tx attachment extraction', () => extractAttachmentBytes(buffer, mime, attachmentId, companyId).catch((err) =>
    log.warn('Background attachment extraction failed', { error: err instanceof Error ? err.message : String(err) }, 'bank-tx-attachments')));
}
