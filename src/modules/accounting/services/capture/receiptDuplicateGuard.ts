/**
 * The duplicate-receipt check the receipt posting paths run before they post
 * (R-088): `receipt-to-journal` and both branches of `capture/[id]/post-expense`.
 *
 * It asks `postedContentFence` the fuller receipt question: has another
 * document in this company already been posted with the same bytes, or the
 * same normalised vendor|date|total|VAT (`receiptContentKey`) — the key being
 * what catches one slip that arrived by email AND by WhatsApp, unless both
 * extractions read a printed reference number and the two differ.
 *
 * A match refuses the post with a 409 naming the earlier document.
 *   - SAME FILE: final. Identical bytes are the same slip, so there is no
 *     repeat purchase to confirm, and `confirmDuplicate` does not apply.
 *   - SAME DETAILS: a person may know better (two identical coffees on one
 *     day) and resends with `confirmDuplicate: true`. The claim then records
 *     the earlier document (`posted_duplicate_of`) and who confirmed it
 *     (`posted_duplicate_confirmed_by`). The posting's own bytes are distinct
 *     and are stamped like any other, inside the unique index.
 *
 * The check holds the advisory locks on both fingerprints (bytes and key)
 * until commit, so two concurrent posts of one slip — same bytes or not —
 * land once. The byte-level backstop is `uq_captured_documents_posted_content`
 * (migration 710), stamped by the claim for every caller; the key has no
 * index, because the reference-number rule is not one an index can express.
 *
 * Callers run it after their row locks and BEFORE their first write, and
 * answer a non-`clear` result with a 409 — `withAuth` commits on 4xx, and
 * nothing has been written. The fingerprint a `clear` result carries goes to
 * `claimCapturedDocumentForPosting`.
 *
 * Unattended use: the refusal is right for a person at a keyboard. A future
 * UNATTENDED receipt poster should not confirm a details match on its own —
 * without printed numbers two genuine same-total slips are indistinguishable.
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PostedReceiptFingerprint } from './capturePostingClaim';
import { findPostedContent, lockPostedContent, PostedContentBusyError } from './postedContentFence';
import { receiptContentKey, type ReceiptKeyInput } from './receiptFingerprint';

export type ReceiptDuplicateCheck =
  | { kind: 'clear'; fingerprint: PostedReceiptFingerprint }
  | { kind: 'duplicate' | 'busy'; message: string; details: Record<string, unknown> };

function postedOn(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

export async function checkReceiptDuplicate(
  companyId: string,
  documentId: string,
  extracted: ReceiptKeyInput,
  confirm: { confirmDuplicate: boolean; userId: string },
): Promise<ReceiptDuplicateCheck> {
  const [doc] = (await sql`
    SELECT raw_bytes_sha256 FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}`) as DbRow[];
  const contentSha256 = (doc?.raw_bytes_sha256 as string | null | undefined) ?? null;
  const receiptKey = receiptContentKey(extracted);

  try {
    await lockPostedContent(companyId, [
      contentSha256 ? `sha:${contentSha256}` : null,
      receiptKey ? `key:${receiptKey}` : null,
    ]);
  } catch (err) {
    if (!(err instanceof PostedContentBusyError)) throw err;
    return { kind: 'busy', message: err.message, details: { code: err.code } };
  }

  const earlier = await findPostedContent(companyId, documentId, {
    contentSha256, receiptKey, referenceNumber: extracted.referenceNumber, spend: 'expense',
  });
  const canConfirm = earlier !== null && !earlier.sameFile;

  if (earlier && !(canConfirm && confirm.confirmDuplicate)) {
    const matchedOn = earlier.sameFile ? 'file' : 'details';
    log.info('Receipt post refused: content already posted', {
      companyId, documentId, earlierDocumentId: earlier.id, matchedOn,
    }, 'capture');
    return {
      kind: 'duplicate',
      message: `This receipt was already posted from ${earlier.fileName} on ${postedOn(earlier.postedAt)}`
        + (earlier.sameFile
          ? ' (the same file). It cannot be posted twice.'
          : ' (same vendor, date, total and VAT). If it is a genuine repeat purchase, confirm the duplicate and post again.'),
      details: { code: 'DUPLICATE_RECEIPT', earlierDocumentId: earlier.id, matchedOn, canConfirm },
    };
  }

  return {
    kind: 'clear',
    fingerprint: {
      receiptKey,
      duplicateOf: earlier ? earlier.id : null,
      confirmedBy: earlier ? confirm.userId : null,
    },
  };
}
