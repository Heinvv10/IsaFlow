/**
 * Per-row cap, in characters, on text a person supplies when approving a
 * commentary row. Client-safe on purpose (no database imports): the edit
 * textarea shows the same number the service enforces.
 *
 * MEASURED, not guessed — see tests/unit/services/packs/packApprovedCommentaryCap.test.ts.
 * Page 4 of the board pack joins every approved row into one paragraph and a
 * page that overflows its sheet refuses the whole pack, so the worst realistic
 * case (7 rows, all at the cap) must still fit the tightest page 4 measured.
 */
export const MAX_APPROVED_TEXT_CHARS = 180;
