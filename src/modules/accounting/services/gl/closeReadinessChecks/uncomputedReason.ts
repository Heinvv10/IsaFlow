/**
 * The prefix every "this check did not run" reason starts with.
 *
 * `getCloseReadiness` substitutes the fixed 'Could not compute — check the
 * relevant module.' for a check that THREW; a check that catches its own
 * failure (the AR / AP tie) returns a reason with this prefix and a specific
 * cause. The close gate's `isCloseBlocker` (periodCloseErrors.ts) blocks on the
 * prefix, so both forms refuse every close and lock (periodCloseGate.ts).
 */
export const UNCOMPUTED_REASON_PREFIX = 'Could not compute';
