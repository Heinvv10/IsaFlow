/**
 * Budget, in characters, for the approved commentary of ONE pack (one
 * company_id + report_kind + params_hash). Client-safe on purpose (no database
 * imports): the edit box shows the same number the service enforces.
 *
 * MEASURED, not guessed — see tests/unit/services/packs/packApprovedCommentaryCap.test.ts.
 * Page 4 of the board pack joins EVERY approved row into one paragraph and a
 * page that overflows its sheet refuses the whole pack, so the limit is on the
 * total, not on a row. The tightest page 4 measured fits 1435 joined chars of
 * prose; 1300 leaves ~9%.
 *
 * Each row costs its trimmed length plus one for the space that joins it to the
 * next, so the sum is never smaller than the joined paragraph.
 */
export const MAX_APPROVED_PACK_CHARS = 1300;

/** What one approved row costs against the pack budget. */
export function approvedCharCost(text: string): number {
  return text.trim().length + 1;
}

/** Budget already spent by the approved rows among `rows`. */
export function packCharsUsed(rows: ReadonlyArray<{ status: string; approvedText: string | null }>): number {
  return rows.reduce(
    (sum, r) => (r.status === 'approved' && r.approvedText !== null ? sum + approvedCharCost(r.approvedText) : sum),
    0,
  );
}
