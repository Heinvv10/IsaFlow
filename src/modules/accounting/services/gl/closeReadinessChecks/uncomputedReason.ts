/**
 * The prefix every "this check did not run" reason starts with.
 *
 * `getCloseReadiness` substitutes the fixed 'Could not compute — check the
 * relevant module.' for a check that THREW; a check that catches its own
 * failure (the AR / AP tie) returns a reason with this prefix and a specific
 * cause. `closePeriodWithReadiness` blocks on the prefix, so both forms refuse
 * an unattended close.
 */
export const UNCOMPUTED_REASON_PREFIX = 'Could not compute';
