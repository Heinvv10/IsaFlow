// src/modules/accounting/services/afs/afsReviewError.ts
// The refusal every AFS review and section-write guard raises, in its own module so the guard
// (afsSectionAttestation) and the services that use the guard can both reach it without a cycle.

export type ReviewErrorCode =
  | 'UNRESOLVED_COMMENTS'
  | 'SECTIONS_NOT_READY'
  | 'DOCUMENT_LOCKED'
  | 'INVALID_TRANSITION'
  | 'NOT_FOUND'
  /** Another request holds the section or document row longer than the lock timeout. */
  | 'LOCK_TIMEOUT'
  /** An impersonated session may not void or record a review — a person must. */
  | 'IMPERSONATED';

export class ReviewError extends Error {
  constructor(message: string, public readonly code: ReviewErrorCode) {
    super(message);
    this.name = 'ReviewError';
  }
}
