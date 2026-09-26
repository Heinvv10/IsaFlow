/**
 * The duplicate-receipt check every receipt posting path runs before it posts
 * (R-088).
 *
 * Every upload is a new `captured_documents` row, so the per-document fences —
 * the row lock and the `posted_at` claim — never see a second upload of the
 * same slip. This asks the question they cannot: has a DIFFERENT document in
 * this company already been posted with the same content? Same content is the
 * same bytes (`raw_bytes_sha256`, written at intake by every channel) or the
 * same normalised vendor|date|total|VAT (`receiptContentKey`), which is what
 * catches one slip that arrived by email AND by WhatsApp — unless both
 * extractions read a printed reference number and the two differ.
 *
 * A match refuses the post, naming the earlier document. A person who knows it
 * is a genuine repeat purchase (two identical coffees on one day) resends with
 * `confirmDuplicate: true`, and the posting is stamped with the document it
 * repeats (`posted_duplicate_of`), which is what takes it outside the partial
 * unique index on the posted bytes (migration 710) that backs this check.
 *
 * THE CHECK IS SERIALISED, not just read: two uploads of one slip are two rows,
 * so the document row locks do not order them, and two concurrent posts would
 * both read "no earlier posting" and both post. A transaction-scoped advisory
 * lock per fingerprint (company-scoped, taken in sorted order so two keys
 * cannot deadlock) makes the second wait for the first to commit, then read
 * its posting and refuse cleanly. The unique index stays as the byte-level
 * backstop for a path that skips this function; the key has none, because the
 * reference-number rule that tells two same-total receipts apart is not one an
 * index can express.
 *
 * Callers run it after their row locks and BEFORE their first write, and
 * answer a non-`clear` result with a 409 — `withAuth` commits on 4xx, and
 * nothing has been written. The fingerprint a `clear` result carries is handed
 * to `claimCapturedDocumentForPosting`, which stamps it in the claim UPDATE.
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { CaptureRowLockTimeoutError, lockWithTimeout } from './captureRowLock';
import type { PostedReceiptFingerprint } from './capturePostingClaim';
import { receiptContentKey, referencesDistinguish, type ReceiptKeyInput } from './receiptFingerprint';

export type ReceiptDuplicateCheck =
  | { kind: 'clear'; fingerprint: PostedReceiptFingerprint }
  | { kind: 'duplicate' | 'busy'; message: string; details?: Record<string, unknown> };

function postedOn(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

export async function checkReceiptDuplicate(
  companyId: string,
  documentId: string,
  extracted: ReceiptKeyInput,
  confirmDuplicate: boolean,
): Promise<ReceiptDuplicateCheck> {
  const [doc] = (await sql`
    SELECT raw_bytes_sha256 FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}`) as DbRow[];
  const contentSha256 = (doc?.raw_bytes_sha256 as string | null | undefined) ?? null;
  const receiptKey = receiptContentKey(extracted);

  const lockKeys = [
    contentSha256 ? `sha:${contentSha256}` : null,
    receiptKey ? `key:${receiptKey}` : null,
  ].filter((k): k is string => k !== null).sort();
  try {
    for (const key of lockKeys) {
      await lockWithTimeout(documentId, async () => (await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`r088|${companyId}|${key}`}, 0))`) as DbRow[]);
    }
  } catch (err) {
    if (err instanceof CaptureRowLockTimeoutError) return { kind: 'busy', message: err.message };
    throw err;
  }

  // Same bytes is the same slip, full stop. Same key is the same slip unless
  // both sides printed a reference number and they differ.
  const candidates = (await sql`
    SELECT id, file_name, posted_at, extracted_data->>'referenceNumber' AS reference,
           (raw_bytes_sha256 IS NOT NULL AND raw_bytes_sha256 = ${contentSha256}) IS TRUE AS same_file
      FROM captured_documents
     WHERE company_id = ${companyId}
       AND id <> ${documentId}::uuid
       AND posted_at IS NOT NULL
       AND ((${contentSha256}::text IS NOT NULL AND raw_bytes_sha256 = ${contentSha256})
         OR (${receiptKey}::text IS NOT NULL AND posted_receipt_key = ${receiptKey}))
     ORDER BY posted_at, id`) as DbRow[];
  const earlier = candidates.find(
    (c) => c.same_file === true || !referencesDistinguish(c.reference, extracted.referenceNumber),
  );

  if (earlier && !confirmDuplicate) {
    const matchedOn = earlier.same_file ? 'file' : 'details';
    log.info('Receipt post refused: content already posted', {
      companyId, documentId, earlierDocumentId: earlier.id, matchedOn,
    }, 'capture');
    return {
      kind: 'duplicate',
      message: `This receipt was already posted from ${String(earlier.file_name)} on ${postedOn(earlier.posted_at)}`
        + (matchedOn === 'file' ? ' (the same file)' : ' (same vendor, date, total and VAT)')
        + '. If it is a genuine repeat purchase, confirm the duplicate and post again.',
      details: { code: 'DUPLICATE_RECEIPT', earlierDocumentId: String(earlier.id), matchedOn },
    };
  }

  return {
    kind: 'clear',
    fingerprint: { contentSha256, receiptKey, duplicateOf: earlier ? String(earlier.id) : null },
  };
}
