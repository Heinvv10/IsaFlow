/**
 * The typed reason a hand-made elimination needs on or after a mirroring pair's cutover (RULING 2026-11-21): its length limits, shared by
 * the API (consolidated-reports create-elimination), the form hook and the dialog. Pure (no imports), so the page may use it.
 */
export const MANUAL_REASON_MIN = 5;
export const MANUAL_REASON_MAX = 500;

/**
 * What mirroring covers, said from the facts (the pair's cutover; mirrorEliminations.ts): the group's EARLIEST mirroring pair mirrors from
 * `cutover`, and a mirrored document is eliminated only when it is ZAR, accepted and approved by the receiver, with expense lines in the
 * same financial year and every account mapped to a group account. Not every document of every pair from that date.
 */
export const mirrorCoverage = (cutover: string): string => `A company pair of this group mirrors its intercompany invoices and credit notes from ${cutover}. `
  + 'Mirroring eliminates only a ZAR document the receiver has approved, as expense lines in the same financial year, on mapped group accounts.';

/** Why a reason (already trimmed) is missing where one is required (on or after `cutover`), or null. */
export function manualReasonMissing(reason: string, cutover: string): string | null {
  return reason.length < MANUAL_REASON_MIN
    ? `${mirrorCoverage(cutover)} A manual elimination dated on or after ${cutover} needs a reason: give one (at least ${MANUAL_REASON_MIN} characters) saying why this one is made by hand`
    : null;
}

/** Why a reason (already trimmed) is too long, whether or not one is required, or null. */
export function manualReasonTooLong(reason: string): string | null {
  return reason.length > MANUAL_REASON_MAX ? `The reason is too long: at most ${MANUAL_REASON_MAX} characters` : null;
}
