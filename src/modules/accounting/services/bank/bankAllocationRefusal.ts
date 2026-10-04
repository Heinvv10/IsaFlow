/**
 * `allocateTransaction`'s refusals about the LINE — the two it decides from the
 * locked row, before it has written anything.
 *
 * Both used to be bare `Error`s, so a route could only tell them apart from a
 * fault by matching on message text. `bank-match-confirm` answers a throw from
 * this depth with a 500 (correctly: after the first write a 4xx would be
 * COMMITted by `withAuth`), and that swept these two in with it — a line another
 * request is already allocating, or one that is no longer `imported`, came back
 * as "An internal error occurred" with no remedy in it.
 *
 * A caller may answer THIS with a 4xx only where it can show nothing has been
 * written yet; the class marks the refusal, it does not prove the ordering.
 */
export class BankAllocationRefusal extends Error {
  readonly code = 'BANK_ALLOCATION_REFUSED';

  /**
   * `feedState` is set only for the pending/removed-row refusal, so a route can
   * answer that one 409 (as it answers the bare BankTransactionNotPostedError)
   * while every other allocation refusal keeps its 400.
   */
  /**
   * TRUE only when another request changed the line while this one was deciding (D10): nothing was written and the
   * same request succeeds on a retry, so the routes answer it 409 (`core/retryableContention`), not 400.
   */
  readonly retryable: boolean;

  constructor(message: string, readonly feedState?: 'pending' | 'removed', opts?: { retryable?: boolean }) {
    super(message);
    this.name = 'BankAllocationRefusal';
    this.retryable = opts?.retryable === true;
  }
}

/** Structural, for the same reason as `isSupplierPaymentRefusal`. */
export function isBankAllocationRefusal(err: unknown): err is BankAllocationRefusal {
  return err instanceof Error
    && (err as { code?: unknown }).code === 'BANK_ALLOCATION_REFUSED';
}

/** A refusal the caller should answer 409-and-retry rather than 400. */
export function isRetryableBankAllocationRefusal(err: unknown): boolean {
  return isBankAllocationRefusal(err) && (err as { retryable?: unknown }).retryable === true;
}
