/**
 * The typed reason a hand-made elimination needs on or after a mirroring pair's cutover (RULING 2026-11-21): its length limits, shared by
 * the API (consolidated-reports create-elimination), the form hook and the dialog. Pure (no imports), so the page may use it.
 */
export const MANUAL_REASON_MIN = 5;
export const MANUAL_REASON_MAX = 500;

/** Why a reason (already trimmed) is missing where one is required (on or after `cutover`), or null. */
export function manualReasonMissing(reason: string, cutover: string): string | null {
  return reason.length < MANUAL_REASON_MIN
    ? `This group's intercompany documents are eliminated by mirroring from ${cutover}: give a reason (at least ${MANUAL_REASON_MIN} characters) for this manual elimination`
    : null;
}

/** Why a reason (already trimmed) is too long, whether or not one is required, or null. */
export function manualReasonTooLong(reason: string): string | null {
  return reason.length > MANUAL_REASON_MAX ? `The reason is too long: at most ${MANUAL_REASON_MAX} characters` : null;
}
