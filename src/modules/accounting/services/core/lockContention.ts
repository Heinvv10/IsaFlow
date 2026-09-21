/**
 * Is this Postgres error CONTENTION rather than a fault?
 *
 * Two SQLSTATEs answer yes, and they are the same answer to the caller:
 *
 *   · `55P03 lock_not_available` — our own `SET LOCAL lock_timeout` elapsed
 *     waiting for a row another request holds.
 *   · `40P01 deadlock_detected` — two requests took the same rows in opposite
 *     orders and Postgres chose this transaction as the victim.
 *
 * Both abort the transaction, so NOTHING this request wrote survives; both are
 * RETRYABLE, and the identical call a moment later will usually succeed. Left
 * unmapped they reach `withAuth` as a 500 — the money path answering "server
 * fault" to a user whose only mistake was arriving at the same instant as
 * somebody else. Every lock helper on the settlement paths therefore maps them
 * to its own typed refusal, and the route answers 409.
 *
 * A deadlock should not HAPPEN — the canonical lock order recorded in
 * `bank/.claude.md` exists to make it impossible on the paths we control. This
 * is the second line: an order violation introduced by a path we do not (a
 * migration, a psql session, a future caller) is answered as contention instead
 * of as a fault. Mapping it here is not a licence to stop ordering locks.
 */

/** `lock_not_available` — our `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';
/** `deadlock_detected` — this transaction was chosen as the victim. */
const DEADLOCK_DETECTED = '40P01';

export function isLockContention(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED;
}
