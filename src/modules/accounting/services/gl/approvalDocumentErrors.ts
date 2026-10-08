/**
 * The document-side refusals of the approval request paths, in a module of
 * their own so the SQL writers (approvalRequestWrites.ts) can raise them
 * without importing the services that import the writers. Re-exported from
 * approvalDocuments.ts and approvalDecideDocument.ts, where they were defined.
 */

/** The id names no document of that type in this company. */
export class ApprovalDocumentNotFoundError extends Error {
  constructor(documentType: string, documentId: string) {
    super(`No ${documentType} ${documentId} exists for this company`);
    this.name = 'ApprovalDocumentNotFoundError';
  }
}

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
 * The rule set or the document moved between the rule requestApproval chose
 * and the write (approval_request_raise / _rebind found a stricter rule
 * governing it now). Nothing was written; raising again binds the right rule.
 * The route answers 409 APPROVAL_RULES_CHANGED — its own reason, not the
 * decide path's DOCUMENT_CHANGED, since a client shows every 409 message alike
 * and "submit again" is not "the content moved".
 */
export class ApprovalRequestStaleError extends Error {
  readonly code = 'APPROVAL_RULES_CHANGED';
  constructor(documentType: string, documentId: string) {
    super(`The approval rules for ${documentType} ${documentId}, or its amount, changed while the request was being raised. Submit it for approval again.`);
    this.name = 'ApprovalRequestStaleError';
  }
}
