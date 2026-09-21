// Its own module so `supplierPaymentCancel.ts` can raise it without importing
// the workflow service that imports it. Re-exported from there unchanged.

/**
 * Raised when the payment id does not resolve inside this company. Raised by
 * approve, process, void and cancel BEFORE any write, so a route may answer it 404.
 *
 * Typed rather than matched on the message: the route classified it with
 * `/not found$/`, which also matched 'Bank account not found' — thrown AFTER
 * `processSupplierPayment` has claimed the payment. That answered 404, and
 * `withAuth` COMMITs below 500, so the payment stayed 'processed' with no
 * journal and no path back: every retry hit the claim it had already taken.
 */
export class SupplierPaymentNotFoundError extends Error {
  readonly code = 'SUPPLIER_PAYMENT_NOT_FOUND';
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = 'SupplierPaymentNotFoundError';
  }
}
