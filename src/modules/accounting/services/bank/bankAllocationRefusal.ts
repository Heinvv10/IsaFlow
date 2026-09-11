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
  constructor(message: string, readonly feedState?: 'pending' | 'removed') {
    super(message);
    this.name = 'BankAllocationRefusal';
  }
}

/** Structural, for the same reason as `isSupplierPaymentRefusal`. */
export function isBankAllocationRefusal(err: unknown): err is BankAllocationRefusal {
  return err instanceof Error
    && (err as { code?: unknown }).code === 'BANK_ALLOCATION_REFUSED';
}
