/**
 * The refusals a customer-receipt application makes about the BOOKS, as a type
 * a caller can tell apart from a fault. The AR mirror of
 * `SupplierPaymentRefusal`, and it exists for the same reason.
 *
 * Every guard in `validateBankReceiptApplication`, `planAllocationLines` and
 * `planReceiptApplication` used to throw a bare `Error`, and their callers
 * classified structurally on "carries no SQLSTATE `code`". That predicate is
 * true of a refusal — and equally true of a `TypeError` or any other internal
 * fault raised on the same call. Such a bug was answered with
 * `apiResponse.badRequest(err.message)`: internal text in front of the user, on
 * a status `withAuth` COMMITs, monitored as the user's mistake rather than as
 * the fault it is.
 *
 * So: a refusal is thrown as this class and nothing else is. A caller catches
 * `ReceiptRefusal` and re-throws the rest, which is how the 4xx branch and the
 * 500 branch stay separated. The message is unchanged and the class extends
 * `Error`, so callers that only ever read `.message` are unaffected.
 *
 * NOT for a post-write invariant failure (`confirmReceiptMatch`'s "the bank
 * allocation posted but no customer payment record was created"): that is a
 * fault, it must reach `withAuth` as a 5xx, and it stays a bare `Error`.
 */
export class ReceiptRefusal extends Error {
  readonly code = 'RECEIPT_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'ReceiptRefusal';
  }
}

/**
 * Structural, not `instanceof`. Vitest module mocking and the two copies a
 * bundler can produce of one module both defeat prototype identity, and a
 * refusal misread as a fault would answer 500 where the user needs the remedy.
 */
export function isReceiptRefusal(err: unknown): err is ReceiptRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'RECEIPT_REFUSED';
}
