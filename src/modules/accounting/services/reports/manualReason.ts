/**
 * The typed reason a hand-made elimination needs on or after a mirroring pair's cutover (RULING 2026-11-21): its length limits, shared by
 * the API (consolidated-reports create-elimination), the form hook and the dialog. Pure (no imports), so the page may use it.
 */
export const MANUAL_REASON_MIN = 5;
export const MANUAL_REASON_MAX = 500;

/** Why `reason` (already trimmed) is not acceptable, or null. */
export function manualReasonProblem(reason: string, cutover: string): string | null {
  if (reason.length < MANUAL_REASON_MIN) {
    return `This group's intercompany documents are eliminated by mirroring from ${cutover}: give a reason (at least ${MANUAL_REASON_MIN} characters) for this manual elimination`;
  }
  if (reason.length > MANUAL_REASON_MAX) return `The reason is too long: at most ${MANUAL_REASON_MAX} characters`;
  return null;
}
