/**
 * The ONE test of "this bank reconciliation is balanced / may be completed": the difference is exactly R0.00.
 * `difference` is numeric(15,2) (a generated column), so whole cents are exact. Every judge — the completion gate,
 * the MCP tool, the screen badge, the Complete button, the list colour — calls this, so none can drift to a tolerance.
 * A NaN (a missing or unparseable figure) is NOT balanced.
 */
export function isExactlyBalanced(difference: number | string): boolean {
  if (typeof difference === 'string' && difference.trim() === '') return false; // Number('') is 0: not a figure
  // |d|, so a half-cent rounds away from zero on both sides (Math.round(-0.5) is -0, which would pass).
  return Math.round(Math.abs(Number(difference)) * 100) === 0;
}

/**
 * Raised by `completeReconciliation` when the ledger no longer agrees with the statement to the cent — either at the
 * first check or when the completing UPDATE recomputed the difference (a back-dated journal landed in between).
 * Raised before any write; the route answers 400.
 */
export class ReconciliationNotBalancedError extends Error {
  readonly code = 'RECONCILIATION_NOT_BALANCED';
  constructor(readonly difference: number) {
    super(`Cannot complete: difference is R${difference.toFixed(2)} (must be R0.00)`);
    this.name = 'ReconciliationNotBalancedError';
  }
}

export function isReconciliationNotBalanced(err: unknown): err is ReconciliationNotBalancedError {
  return err instanceof ReconciliationNotBalancedError;
}
