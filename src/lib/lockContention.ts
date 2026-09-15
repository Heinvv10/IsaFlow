/**
 * A lock the transaction could not get: lock_timeout expired (55P03, e.g. the 5 s bound on every function that
 * takes the company authority key, migration 838) or the deadlock detector chose it (40P01). Either aborts the
 * whole transaction and nothing it did survives, so the request edge answers 503 with a retry hint, not 500.
 */
export function isRetryableLockFailure(error: unknown): boolean {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === '55P03' || code === '40P01';
}

/** Seconds a client should wait before retrying a request refused for lock contention. */
export const LOCK_RETRY_AFTER_SECONDS = 2;
