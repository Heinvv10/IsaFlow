/**
 * The document half of an APPROVE decision (R-035): the approver must be
 * vouching for the content the document has now, and must say which content
 * they were shown.
 */

import { sql } from '@/lib/neon';
import { resolveApprovalDocument } from './approvalDocuments';
import type { DocumentType } from './approvalService';

/** approve on a request whose document no longer has the content it was raised for. */
export class ApprovalDocumentChangedError extends Error {
  readonly code = 'DOCUMENT_CHANGED';
  constructor(requestId: string) {
    super(`The document changed after approval request ${requestId} was raised. Submit it for approval again.`);
    this.name = 'ApprovalDocumentChangedError';
  }
}

/** approve without naming the digest the approver was shown, on a request that carries one. */
export class ApprovalExpectedDigestRequiredError extends Error {
  readonly code = 'EXPECTED_DIGEST_REQUIRED';
  constructor(requestId: string) {
    super(`Approving request ${requestId} requires expectedDigest — the document digest you were shown.`);
    this.name = 'ApprovalExpectedDigestRequiredError';
  }
}

/**
 * Refuses an approve unless three digests agree: the one the approver was shown
 * (`expectedDigest`, from the approvals list), the one the request was raised
 * for, and the document's live one (the single SQL definition). Otherwise the
 * approver would be vouching for figures the document no longer carries, or
 * for figures they never saw.
 *
 *  - document gone — deleted, soft-deleted, or not this company's — 404,
 *    checked by EXISTENCE (resolveApprovalDocument), not inferred from the
 *    digest: a NULL stored digest equals a NULL live one, so a bill
 *    soft-deleted before migration 708, or any type with no digest, passed;
 *  - request carries a digest but the caller named none: 400;
 *  - any disagreement: 409 DOCUMENT_CHANGED.
 * A request with NO digest (a type with no digest definition) needs none; one
 * raised in the deploy window before migration 708's code carries NULL while
 * its document has a digest, so it is 409 until re-requested, which heals it.
 *
 * Silent when the request is gone or decided: the decide's own UPDATE reports that.
 */
export async function assertDocumentUnchanged(
  companyId: string,
  requestId: string,
  expectedDigest: string | null | undefined,
): Promise<void> {
  const rows = (await sql`
    SELECT ar.document_type, ar.document_id, ar.document_digest AS stored,
           approval_document_digest(ar.company_id, ar.document_type, ar.document_id) AS live
    FROM approval_requests ar
    WHERE ar.id = ${requestId}::UUID AND ar.company_id = ${companyId} AND ar.status = 'pending'
  `) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return;
  // Throws ApprovalDocumentNotFoundError (the route answers 404).
  await resolveApprovalDocument(companyId, String(row.document_type) as DocumentType, String(row.document_id));
  const stored = row.stored != null ? String(row.stored) : null;
  const live = row.live != null ? String(row.live) : null;
  const expected = expectedDigest ? expectedDigest : null;
  if (stored !== null && expected === null) throw new ApprovalExpectedDigestRequiredError(requestId);
  if (expected !== stored || stored !== live) throw new ApprovalDocumentChangedError(requestId);
}
