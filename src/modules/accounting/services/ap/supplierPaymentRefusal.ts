/**
 * The refusals a supplier-payment allocation makes about the BOOKS, as a type a
 * caller can tell apart from a fault.
 *
 * Every guard in `validateBankSupplierPayment` and `planSupplierAllocationLines`
 * used to throw a bare `Error`, so a caller that wanted to answer a refusal with
 * a 4xx had no way to distinguish "this bill is cancelled" from a dropped
 * connection or a `25P02` on a poisoned transaction. It classified both as the
 * user's fault: raw Postgres text reached the browser as a 400, and a genuine
 * server fault was logged and monitored as a client error — and, worse, answered
 * with a status `withAuth` COMMITs.
 *
 * So: a refusal is thrown as this class and nothing else is. A caller catches
 * `SupplierPaymentRefusal` and re-throws the rest, which is how the 4xx branch
 * and the 500 branch stay separated. The message is unchanged and the class
 * extends `Error`, so callers that only ever read `.message` are unaffected.
 */
export class SupplierPaymentRefusal extends Error {
  readonly code = 'SUPPLIER_PAYMENT_REFUSED';

  /**
   * TRUE only for lock contention — the caller did nothing wrong and the same
   * request will succeed on a retry. Every other refusal is about the books and
   * retrying unchanged repeats it, so it stays FALSE. The AP mirror of
   * `ReceiptRefusal.retryable`; see there for what answering it 400 cost.
   */
  readonly retryable: boolean;

  /**
   * TRUE when the contention is a HELD ROW — a lock wait that timed out (or a deadlock victim) on a row a peer holds.
   * A held row answers 503 + Retry-After (D11, `respondIfLockTimeout`); a `retryable` refusal that is not held is a
   * STATE conflict (the document changed under the caller) and stays 409. Implies `retryable`.
   */
  readonly held: boolean;

  constructor(message: string, opts?: { retryable?: boolean; held?: boolean }) {
    super(message);
    this.name = 'SupplierPaymentRefusal';
    this.held = opts?.held === true;
    this.retryable = this.held || opts?.retryable === true;
  }
}

/**
 * Structural, not `instanceof`. Vitest module mocking and the two copies a
 * bundler can produce of one module both defeat prototype identity, and a
 * refusal misread as a fault would answer 500 where the user needs the remedy.
 */
export function isSupplierPaymentRefusal(err: unknown): err is SupplierPaymentRefusal {
  return err instanceof Error
    && (err as { code?: unknown }).code === 'SUPPLIER_PAYMENT_REFUSED';
}

/** A refusal the caller should answer 409-and-retry rather than 400. */
export function isRetryableSupplierPaymentRefusal(err: unknown): boolean {
  return isSupplierPaymentRefusal(err) && (err as { retryable?: unknown }).retryable === true;
}

/** A refusal for a row a peer holds (`held`): answered 503 + Retry-After, not 409. */
export function isSupplierPaymentHeldRow(err: unknown): boolean {
  return isSupplierPaymentRefusal(err) && (err as { held?: unknown }).held === true;
}
