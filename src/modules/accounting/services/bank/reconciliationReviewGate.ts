/**
 * Hein, 2026-11-12 (migration 980): a bank reconciliation cannot be completed while a line it would reconcile is
 * still unreviewed (on the New tab). Raised by `completeReconciliation` inside its transaction, before any write.
 */
export class ReconciliationReviewRequiredError extends Error {
  readonly code = 'RECONCILIATION_REVIEW_REQUIRED';
  constructor(readonly unreviewed: number) {
    super(`Cannot complete: ${unreviewed} transaction${unreviewed === 1 ? ' is' : 's are'} not reviewed yet. `
      + 'Review them on the Bank Transactions New tab first.');
    this.name = 'ReconciliationReviewRequiredError';
  }
}

export function isReconciliationReviewRequired(err: unknown): err is ReconciliationReviewRequiredError {
  return err instanceof ReconciliationReviewRequiredError;
}
