/**
 * Is this error one of the row-lock timeouts the services throw by hand?
 *
 * Seven lock helpers — `creditNoteLock`, `customerInvoiceLock`,
 * `supplierInvoiceLock`, `bankTxLock`, `core/paymentLock`, `glAccountLock`,
 * `customerInvoiceApprovalService` — catch SQLSTATE 55P03 and rethrow a typed
 * error whose message tells the caller to retry. Every one of them sets a
 * `code` ending in `_LOCK_TIMEOUT`.
 *
 * That `code` is the problem this predicate exists to solve. The two filters
 * that decide whether a service message may reach a caller —
 * `isRefusal` in the receipt-match route and `safeErrorText` for the MCP tools —
 * both key on `code === undefined`, because a pg driver error always carries a
 * SQLSTATE and could leak schema names. A hand-thrown lock timeout carries a
 * code too, so it was being filtered out with the driver errors: the route
 * returned a 500 for routine 5s contention, and the agent — the audience the
 * "retry in a moment" wording was written for — got the generic fallback.
 *
 * The suffix test is safe against the case it is guarding: SQLSTATE codes are
 * five characters and cannot end in `_LOCK_TIMEOUT`.
 */
export function isLockTimeoutError(err: unknown): err is Error & { code: string } {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.endsWith('_LOCK_TIMEOUT');
}

/**
 * May this error's own message be shown to the caller?
 *
 * True for an application-level refusal — a hand-thrown Error with no SQLSTATE
 * `code` — and for the typed lock timeouts above, whose whole purpose is to say
 * "retry". False for everything a driver raised.
 */
export function isCallerSafeError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  return (err as { code?: unknown }).code === undefined || isLockTimeoutError(err);
}
