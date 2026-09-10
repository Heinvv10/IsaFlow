/**
 * The capture POSTING CLAIM: the `posted_at` fence every posting route stamps
 * before its first ledger write, and the refusal it answers with.
 *
 * Split out of `captureRowLock.ts` (K-072 round 18), which carries the locks
 * the claim is taken under and had grown past the 300-line cap. Why the fence
 * is `posted_at` and not `status`, and which routes it reaches, is documented
 * at the top of that file; `captureRowLock` re-exports everything here, so
 * callers import from one place.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * Why a posting route refused the document.
 *
 * Two reasons, two messages: telling an operator "already posted to a journal"
 * about a document that was merely rejected — or merely attached to a bank
 * transaction — is a false statement about the ledger, and the only undo the
 * product offered for it was the confirm button, which is itself a bypass.
 */
export type CapturedDocumentRefusal = 'already_posted' | 'rejected';

export const CAPTURED_DOCUMENT_REFUSAL_MESSAGE: Record<CapturedDocumentRefusal, string> = {
  already_posted: 'Document already posted',
  rejected: 'Document was rejected — reopen it before posting',
};

/**
 * The refusal a locked document row earns, or null when it may be posted.
 *
 * `posted_at` is the fence; `status` is consulted for one value only, the
 * terminal `'rejected'` an operator set deliberately. Every other status —
 * including the `'matched'` that attaching the slip to a bank transaction
 * writes — is postable, which is the whole point of moving off the column.
 */
export function refusalForPosting(
  row: { status?: unknown; posted_at?: unknown },
): CapturedDocumentRefusal | null {
  if (row.posted_at != null) return 'already_posted';
  if (row.status === 'rejected') return 'rejected';
  return null;
}

/**
 * The document cannot be posted: already claimed by another route or request,
 * or rejected by an operator.
 *
 * Thrown rather than returned where the claim happens inside a service, so the
 * route can answer 400 with the same wording it uses for its own read guard.
 * Safe to answer 4xx with, and only because of WHERE it is thrown: the claim is
 * every caller's LAST read-only step, so a refusal has written nothing and
 * `withAuth`'s commit-on-4xx commits nothing.
 */
export class CapturedDocumentAlreadyPostedError extends Error {
  readonly code = 'CAPTURED_DOCUMENT_ALREADY_POSTED';
  readonly refusal: CapturedDocumentRefusal;
  constructor(refusal: CapturedDocumentRefusal = 'already_posted') {
    super(CAPTURED_DOCUMENT_REFUSAL_MESSAGE[refusal]);
    this.name = 'CapturedDocumentAlreadyPostedError';
    this.refusal = refusal;
  }
}

/**
 * Claim the document for posting: stamp `posted_at`, but only from a row that
 * has not been claimed and has not been rejected.
 *
 * The read under `lockCapturedDocumentForUpdate` refuses the ordinary second
 * attempt with an accurate message. This is the fence behind it — one statement
 * carrying the same predicate the read did, so a caller reaching the write
 * without the lock still cannot post what another path settled. The predicate
 * is on `posted_at`: a status-predicated claim is only as durable as the
 * lifecycle column it rides on, and that column is rewritten by the confirm
 * button, the reject button and the bank-attach path — none of which know they
 * are unlocking a ledger write.
 *
 * Callers MUST run it BEFORE their first ledger write and answer a refusal with
 * a 4xx. That ordering is the safe one: `withAuth` COMMITs the request
 * transaction on a 4xx, so a refusal here commits nothing (the UPDATE matched
 * no row), while every failure AFTER it throws and rolls the claim back with
 * the journal.
 *
 * `status = 'matched'` is stamped alongside because the inbox reads that column
 * to show the document as settled; it is now a consequence of posting, never
 * the thing that decides it. `document_category` is stamped for the two routes
 * that set it; passing null leaves the column untouched.
 *
 * Returns null when the claim succeeded, otherwise the reason it did not.
 */
export async function claimCapturedDocumentForPosting(
  companyId: string,
  documentId: string,
  documentCategory: string | null = null,
): Promise<CapturedDocumentRefusal | null> {
  const rows = (await sql`
    UPDATE captured_documents
       SET posted_at = NOW(),
           status = 'matched',
           document_category = COALESCE(${documentCategory}, document_category),
           updated_at = NOW()
     WHERE id = ${documentId}::uuid
       AND company_id = ${companyId}
       AND posted_at IS NULL
       AND status <> 'rejected'
    RETURNING id`) as DbRow[];
  if (rows.length === 1) return null;

  // Which of the two predicates refused it. The row is held under
  // `lockCapturedDocumentForUpdate` on every posting path, so this re-read sees
  // the settled values. A row that vanished (wrong tenant, deleted) reports
  // 'already_posted' — the caller has already answered NOT_FOUND for that case
  // from its own earlier read.
  const [row] = (await sql`
    SELECT status, posted_at FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}`) as DbRow[];
  return row ? (refusalForPosting(row) ?? 'already_posted') : 'already_posted';
}
